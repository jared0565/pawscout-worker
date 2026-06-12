import { Vault } from './vault';
import { CjClient, CjTokenManager, cjFetchFromEnv, type CjSearchItem } from './cj';
import { makeAdminGraphql, type AdminGraphql } from './shopify-admin';
import { TenantStore, listActiveShops, purgeExpiredSearchCache, trimOldLogs } from './tenant-store';
import { passesGates, normalizeKeyword, CACHE_TTL_DAYS } from './proxy/search';
import { importProduct, getCachedDetail, resolveCategory } from './proxy/import';
import type { Env, TenantConfig } from './types';

export const CULL_WINDOW_DAYS = 30; // grace period AND inactivity window
const LOG_RETENTION_DAYS = 90;
const MAX_IMPORTS_PER_RUN = 6; // gentle daily fill — respects CJ rate limits
const CJ_CALL_GAP_MS = 1100; // CJ allows ~1 request/second

const ARCHIVE = `mutation pawscoutArchive($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

/**
 * 30-day performance cull: ARCHIVE (never delete) imported products with zero
 * qualifying events (view/atc/order) in the window. Products younger than the
 * window are exempt by the same cutoff (grace period).
 */
export async function cullStaleProducts(
  store: TenantStore,
  admin: AdminGraphql,
  now: () => number = Date.now
): Promise<number> {
  const cutoff = new Date(now() - CULL_WINDOW_DAYS * 86400_000).toISOString();
  const stale = await store.linksEligibleForArchive(cutoff);
  let archived = 0;
  for (const link of stale) {
    if (!link.shopify_product_id) continue;
    try {
      const data = await admin(ARCHIVE, { input: { id: link.shopify_product_id, status: 'ARCHIVED' } });
      const errs = (data.productUpdate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
      if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
      await store.putLink({ cjPid: link.cj_pid, state: 'archived' });
      archived++;
    } catch (e) {
      console.warn(`cull: archive failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return archived;
}

async function gatedSearch(store: TenantStore, cj: CjClient, cfg: TenantConfig, keyword: string): Promise<CjSearchItem[]> {
  const kw = normalizeKeyword(keyword);
  let items: CjSearchItem[];
  const cached = await store.getSearchCache(`kw:${kw}`);
  if (cached) {
    items = JSON.parse(cached);
  } else {
    items = await cj.search(kw);
    await store.putSearchCache(`kw:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
  }
  // Best-seller ordering: most-listed first.
  return items.filter((i) => passesGates(i, cfg.gates, kw)).sort((a, b) => b.listedNum - a.listedNum);
}

/**
 * Demand-driven refill: import top gated CJ products for (1) the most-searched
 * under-served keywords, then (2) mapped collections below target. Capped per
 * run and paced for CJ's rate limits.
 */
export async function refillCollections(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  opts: { maxImports?: number; pause?: (ms: number) => Promise<void>; now?: () => number } = {}
): Promise<number> {
  const maxImports = opts.maxImports ?? MAX_IMPORTS_PER_RUN;
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let imported = 0;

  const tryImport = async (item: CjSearchItem, category: string | null | undefined): Promise<boolean> => {
    const link = await store.getLink(item.pid);
    if (link && (link.state === 'imported' || link.state === 'importing')) return false;
    await pause(CJ_CALL_GAP_MS);
    const detail = await getCachedDetail(store, cj, item.pid);
    if (!detail) return false;
    await importProduct(store, admin, cfg, detail, category);
    const after = await store.getLink(item.pid);
    return after?.state === 'imported';
  };

  // 1) Under-served search keywords (last 30 days), most-searched first.
  const since = new Date(now() - 30 * 86400_000).toISOString();
  for (const demand of await store.underfilledKeywords(since, cfg.target, 3)) {
    if (imported >= maxImports) return imported;
    const candidates = await gatedSearch(store, cj, cfg, demand.keyword_norm);
    for (const item of candidates.slice(0, 3)) {
      if (imported >= maxImports) return imported;
      if (await tryImport(item, undefined)) imported++; // category resolved from CJ data
    }
  }

  // 2) Mapped collections below target.
  for (const key of Object.keys(cfg.collectionMap)) {
    if (imported >= maxImports) break;
    let deficit = cfg.target - (await store.countImportedByCategory(key));
    if (deficit <= 0) continue;
    const candidates = await gatedSearch(store, cj, cfg, key.replace(/-/g, ' '));
    for (const item of candidates) {
      if (deficit <= 0 || imported >= maxImports) break;
      if (await tryImport(item, key)) {
        imported++;
        deficit--;
      }
    }
  }
  return imported;
}

/** Daily cron entry point: retention purges, then per-tenant cull + refill. */
export async function runDailyMaintenance(env: Env): Promise<void> {
  await purgeExpiredSearchCache(env.DB);
  await trimOldLogs(env.DB, new Date(Date.now() - LOG_RETENTION_DAYS * 86400_000).toISOString());

  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  for (const shop of await listActiveShops(env.DB)) {
    const store = new TenantStore(env.DB, shop);
    try {
      const tenant = await store.getTenant();
      const cfg = await store.getConfig();
      if (!tenant?.access_token_enc || !cfg) continue;
      const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
      const admin = makeAdminGraphql(shop, accessToken);
      await cullStaleProducts(store, admin);
      if (await store.getSupplierCredential('cj')) {
        const f = cjFetchFromEnv(env);
        const tokens = new CjTokenManager(store, vault, f);
        const cj = new CjClient(() => tokens.getToken(), f);
        await refillCollections(store, cj, admin, cfg);
      }
    } catch (e) {
      console.warn(`daily maintenance failed for ${shop}: ${(e as Error).message}`);
    }
  }
}
