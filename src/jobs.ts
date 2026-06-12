import { Vault } from './vault';
import { CjClient, CjTokenManager, cjFetchFromEnv, type CjSearchItem } from './cj';
import { makeAdminGraphql, type AdminGraphql } from './shopify-admin';
import { TenantStore, listActiveShops, purgeExpiredSearchCache, purgeUnusedWarehouse, trimOldLogs } from './tenant-store';
import { passesGates, normalizeKeyword, CACHE_TTL_DAYS } from './proxy/search';
import { confirmAndImport, getCachedDetail, resolveCategory } from './proxy/import';
import { enableTracking, getPrimaryLocationId, productInventoryItems, setInventoryQuantities, setSupplierMetafields, updateVariantPrices, MAX_TRACKED_QTY } from './proxy/inventory';
import { retailPriceGbp } from './pricing';
import type { CjDetail } from './cj';
import { LlmClient, curateProduct, type Curation } from './llm';
import type { Env, TenantConfig } from './types';

export const CULL_WINDOW_DAYS = 30; // grace period AND inactivity window
const LOG_RETENTION_DAYS = 90;
const MAX_IMPORTS_PER_RUN = 30; // W2: promotions cost 1 CJ stock-check each — well within budget
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

/**
 * W2.1 — store refill promotes FROM THE WAREHOUSE (no CJ search calls).
 * Two passes over the mapped collections: first raise every category to
 * `floors.storeFloor`, then top up toward `target`. Each promotion goes
 * through confirmAndImport (one live CJ stock check, paced). A warehouse
 * that can't supply a floor logs the shortfall — gates are never bypassed.
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
  let imported = 0;

  const promote = async (row: { cj_pid: string; detail: string; stock: number }, category: string): Promise<boolean> => {
    if (row.stock < cfg.floors.stockFloor) return false;
    const link = await store.getLink(row.cj_pid);
    if (link && (link.state === 'imported' || link.state === 'importing')) return false;
    let detail: CjDetail;
    try { detail = JSON.parse(row.detail) as CjDetail; } catch { return false; }
    await pause(CJ_CALL_GAP_MS); // confirmAndImport makes one CJ stock call
    await confirmAndImport(store, cj, admin, cfg, detail, category);
    return (await store.getLink(row.cj_pid))?.state === 'imported';
  };

  for (const goal of [cfg.floors.storeFloor, cfg.target]) {
    for (const key of Object.keys(cfg.collectionMap)) {
      if (imported >= maxImports) return imported;
      let deficit = goal - (await store.countImportedByCategory(key));
      if (deficit <= 0) continue;
      for (const row of await store.warehouseByCategory(key, 50)) {
        if (deficit <= 0 || imported >= maxImports) break;
        if (await promote(row, key)) {
          imported++;
          deficit--;
        }
      }
      if (deficit > 0 && goal === cfg.floors.storeFloor) {
        console.warn(`refill shortfall: ${key} is ${deficit} below the store floor (warehouse supply-limited)`);
      }
    }
  }
  return imported;
}

/**
 * W2.3 — daily CJ→Shopify stock sync for every listed product:
 * tracked quantities set absolutely (per-variant via SKU↔vid mapping when the
 * warehouse detail provides it), products under the stock floor are zeroed and
 * flagged stock_paused (cull-exempt), recoveries restore automatically, and
 * the theme's supplier.* metafields get refreshed every run.
 */
export async function syncStoreInventory(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  opts: { maxProducts?: number; offset?: number; pause?: (ms: number) => Promise<void> } = {}
): Promise<number> {
  const maxProducts = opts.maxProducts ?? 60;
  const offset = opts.offset ?? 0;
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const locationId = await getPrimaryLocationId(admin);
  if (!locationId) {
    console.warn('inventory sync skipped: no primary location');
    return 0;
  }

  let synced = 0;
  for (const link of (await store.listImportedLinks()).slice(offset, offset + maxProducts)) {
    if (!link.shopify_product_id) continue;
    try {
      // Fresh CJ detail: source of truth for variant costs (price sync) and,
      // when present, stock — saving the separate stock call.
      await pause(CJ_CALL_GAP_MS);
      let detail: CjDetail | null = null;
      try { detail = await cj.detail(link.cj_pid); } catch { detail = null; }
      if (detail) await store.putSearchCache(`pid:${link.cj_pid}`, JSON.stringify(detail), 30);

      let stockMap = new Map<string, number>();
      let maxStock = detail?.stock ?? 0;
      if (detail) {
        for (const v of detail.variants) if (v.stock !== undefined) stockMap.set(v.vid, v.stock);
      }
      if (!maxStock) {
        await pause(CJ_CALL_GAP_MS);
        stockMap = await cj.stockByPid(link.cj_pid);
        maxStock = stockMap.size ? Math.max(...stockMap.values()) : 0;
      }
      const paused = maxStock < cfg.floors.stockFloor;

      // SKU → vid mapping for per-variant quantities (fresh detail preferred).
      const skuToVid = new Map<string, string>();
      const skuToCost = new Map<string, number>();
      if (detail) {
        for (const v of detail.variants) {
          skuToVid.set(v.sku, v.vid);
          skuToCost.set(v.sku, v.sellPriceUsd);
        }
      } else {
        const wh = await store.getWarehouseProduct(link.cj_pid);
        if (wh) {
          try {
            for (const v of (JSON.parse(wh.detail) as CjDetail).variants) skuToVid.set(v.sku, v.vid);
          } catch { /* fall back to uniform stock */ }
        }
      }

      const variants = await productInventoryItems(admin, link.shopify_product_id);
      // Untracked variants (imports whose CJ detail lacked stock) must be
      // activated first or the quantity write below errors out.
      await enableTracking(admin, link.shopify_product_id, variants.filter((v) => !v.tracked));
      await setInventoryQuantities(
        admin,
        locationId,
        variants.map((v) => {
          const vid = skuToVid.get(v.sku);
          const qty = paused ? 0 : (vid !== undefined ? stockMap.get(vid) ?? maxStock : maxStock);
          return { inventoryItemId: v.inventoryItemId, quantity: Math.min(qty, MAX_TRACKED_QTY) };
        })
      );

      // Price sync: retail must always equal the pricing rule applied to CJ's
      // CURRENT cost. Only variants whose SKU matches a CJ variant reprice;
      // unchanged prices are skipped to avoid pointless writes.
      const priceUpdates = variants.flatMap((v) => {
        const cost = skuToCost.get(v.sku);
        if (cost === undefined || cost <= 0) return [];
        const expected = retailPriceGbp(cost, cfg.pricing).toFixed(2);
        return expected === v.price ? [] : [{ id: v.variantId, price: expected }];
      });
      if (priceUpdates.length) await updateVariantPrices(admin, link.shopify_product_id, priceUpdates);

      await setSupplierMetafields(admin, link.shopify_product_id, {
        status: paused ? 'out_of_stock' : maxStock < cfg.floors.stockFloor * 2 ? 'low_stock' : 'available',
        qty: maxStock,
        checkedAt: new Date().toISOString()
      });
      await store.setStockPaused(link.cj_pid, paused);
      await store.setWarehouseStock(link.cj_pid, maxStock, paused ? 'low_stock' : 'available');
      synced++;
    } catch (e) {
      // Per-product failures (CJ hiccups, Shopify errors) log and move on; never abort the run.
      console.warn(`inventory sync failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return synced;
}

// --- W1: warehouse replenishment + freshness ---

export interface ReplenishOpts {
  maxCjCalls?: number;
  maxAdmits?: number;
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
  /** W3: admission curation — score + rewrite. null result = mechanical gates only. */
  curate?: (detail: CjDetail, context: string) => Promise<Curation | null>;
}

/**
 * Keep the PS-local warehouse stocked: demand keywords first (most-searched,
 * under-served), then categories below `floors.warehouseDepth`. Admission =
 * gates + stock ≥ `floors.stockFloor` + not already warehoused/imported.
 * Budgets bound both CJ calls and admits per run; shortfalls just carry to the
 * next night — quality and pacing always outrank the quota.
 */
export async function replenishWarehouse(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  opts: ReplenishOpts = {}
): Promise<number> {
  const maxCjCalls = opts.maxCjCalls ?? 120;
  const maxAdmits = opts.maxAdmits ?? 40;
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let cjCalls = 0;
  let admitted = 0;

  const spend = async (): Promise<void> => {
    cjCalls++;
    await pause(CJ_CALL_GAP_MS);
  };

  const search = async (keyword: string): Promise<CjSearchItem[]> => {
    const kw = normalizeKeyword(keyword);
    const cached = await store.getSearchCache(`kw:${kw}`);
    let items: CjSearchItem[];
    if (cached) {
      items = JSON.parse(cached);
    } else {
      if (cjCalls >= maxCjCalls) return [];
      await spend();
      items = await cj.search(kw);
      await store.putSearchCache(`kw:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
    }
    return items.filter((i) => passesGates(i, cfg.gates, kw)).sort((a, b) => b.listedNum - a.listedNum);
  };

  const tryAdmit = async (item: CjSearchItem, category: string | null, context: string): Promise<boolean> => {
    if (admitted >= maxAdmits || cjCalls >= maxCjCalls) return false;
    if (await store.getWarehouseProduct(item.pid)) return false;
    const link = await store.getLink(item.pid);
    if (link && (link.state === 'imported' || link.state === 'importing')) return false;

    await spend();
    const detail = await getCachedDetail(store, cj, item.pid);
    if (!detail) return false;

    let stock = detail.stock ?? 0;
    if (!stock) {
      if (cjCalls >= maxCjCalls) return false;
      await spend();
      try {
        const m = await cj.stockByPid(item.pid);
        stock = m.size ? Math.max(...m.values()) : 0;
      } catch {
        stock = 0;
      }
    }
    if (stock < cfg.floors.stockFloor) return false;

    // W3: LLM curation — quality score + rewritten copy. A failed/absent LLM
    // degrades to mechanical gates; a low score is a hard reject.
    let title = detail.nameEn;
    let admittedDetail: CjDetail = { ...detail, stock };
    let resolvedCategory = category ?? resolveCategory(cfg, detail);
    if (opts.curate) {
      const curated = await opts.curate(detail, context);
      if (curated) {
        if (curated.relevanceScore < cfg.llm.scoreThreshold) return false;
        title = curated.title;
        admittedDetail = {
          ...admittedDetail,
          nameEn: curated.title,
          descriptionHtml: curated.descriptionHtml,
          originalNameEn: detail.nameEn, // CJ original kept for audit
          llmScore: curated.relevanceScore
        };
        if (curated.category) resolvedCategory = curated.category;
      }
    }

    await store.putWarehouseProduct({
      cjPid: item.pid,
      category: resolvedCategory,
      title,
      detailJson: JSON.stringify(admittedDetail),
      priceUsd: Math.min(...detail.variants.map((v) => v.sellPriceUsd)),
      listedNum: detail.listedNum,
      stock
    });
    admitted++;
    return true;
  };

  // 1) demand keywords (most-searched under-served, last 30 days)
  const since = new Date(now() - 30 * 86400_000).toISOString();
  for (const demand of await store.underfilledKeywords(since, cfg.target, 5)) {
    if (admitted >= maxAdmits || cjCalls >= maxCjCalls) break;
    for (const item of (await search(demand.keyword_norm)).slice(0, 5)) {
      await tryAdmit(item, null, demand.keyword_norm);
    }
  }

  // 2) categories below warehouse depth
  for (const key of Object.keys(cfg.collectionMap)) {
    if (admitted >= maxAdmits || cjCalls >= maxCjCalls) break;
    let deficit = cfg.floors.warehouseDepth - (await store.countWarehouseAvailableByCategory(key));
    if (deficit <= 0) continue;
    for (const item of await search(key.replace(/-/g, ' '))) {
      if (deficit <= 0 || admitted >= maxAdmits || cjCalls >= maxCjCalls) break;
      if (await tryAdmit(item, key, key.replace(/-/g, ' '))) deficit--;
    }
  }
  return admitted;
}

/** Freshness cycle: re-check stock on stale rows (and flag under-floor rows low_stock). */
export async function refreshWarehouseStock(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  opts: ReplenishOpts = {}
): Promise<number> {
  const maxCjCalls = opts.maxCjCalls ?? 30;
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const cutoff = new Date(now() - 48 * 3600_000).toISOString();
  let checked = 0;
  for (const row of await store.staleWarehouseRows('stock', cutoff, maxCjCalls)) {
    if (checked >= maxCjCalls) break;
    checked++;
    await pause(CJ_CALL_GAP_MS);
    try {
      const m = await cj.stockByPid(row.cj_pid);
      const stock = m.size ? Math.max(...m.values()) : 0;
      await store.setWarehouseStock(row.cj_pid, stock, stock >= cfg.floors.stockFloor ? 'available' : 'low_stock');
    } catch (e) {
      console.warn(`stock refresh failed for ${row.cj_pid}: ${(e as Error).message}`);
    }
  }
  return checked;
}

/** Daily cron entry point: retention purges, then per-tenant cull + refill. */
export async function runDailyMaintenance(env: Env): Promise<void> {
  await purgeExpiredSearchCache(env.DB);
  await purgeUnusedWarehouse(env.DB, new Date(Date.now() - 30 * 86400_000).toISOString());
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
        await refreshWarehouseStock(store, cj, cfg);
        const llm = new LlmClient(env.OPENROUTER_API_KEY);
        await replenishWarehouse(store, cj, cfg, {
          curate: llm.available && cfg.llm.enabled
            ? (detail, context) => curateProduct(llm, store, cfg, detail, context)
            : undefined
        });
        await syncStoreInventory(store, cj, admin, cfg);
        await refillCollections(store, cj, admin, cfg); // promote-from-warehouse (floor 8, target 12)
      }
    } catch (e) {
      console.warn(`daily maintenance failed for ${shop}: ${(e as Error).message}`);
    }
  }
}
