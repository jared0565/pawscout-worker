import { Vault } from './vault';
import { chooseOrigin, CjClient, CjTokenManager, cjFetchFromEnv, type CjSearchItem } from './cj';
import { makeAdminGraphql, type AdminGraphql } from './shopify-admin';
import { TenantStore, listActiveShops, purgeExpiredSearchCache, purgeUnusedWarehouse, trimOldLogs, readJobCheckpoint, writeJobCheckpoint } from './tenant-store';
import { liveCjPasses, normalizeKeyword, CACHE_TTL_DAYS, isLikelyPetProduct, titleSignature } from './proxy/search';
import { bestLocalQty, localWarehousesFor, HOME_MARKET_WAREHOUSES } from './local-markets';
import { archiveProductGuarded } from './catalog/archive-guard';
import { rebuildReferrerIndex } from './catalog/referrers';
import { findRedirect, createRedirect, deleteRedirect, pickRedirectTarget, isScopeDenial, buildArticleTargets, type LivenessMemo } from './catalog/redirects';

/** US-lane sourcing keywords (2026-07-07): bulky / high-ticket niches ONLY.
 *  The generic SEED_KEYWORDS produced a 0-for-35 street-parity pass rate for
 *  the US market because CJ's US-warehouse COST sits at or above Amazon and
 *  Walmart RETAIL for small commodity goods (kits, wipes, small toys). The
 *  only cost-below-street candidates in that review were freight-heavy items
 *  (a stainless steel litter box: cost $46.81 vs street $57-70), so this set
 *  targets categories where US street prices carry real freight. Works with
 *  the lane's gateOverrides price band (below), which replaces the commodity
 *  band for US discovery. */
export const US_SEED_KEYWORDS: Record<string, string[]> = {
  'pet-cleaning': ['stainless steel litter box', 'cat litter box enclosed', 'self cleaning cat litter box'],
  'pet-grooming': ['dog grooming table', 'dog grooming vacuum', 'dog bath tub'],
  'pet-toys': ['cat exercise wheel', 'dog agility set'],
  'pet-accessories': ['dog crate', 'dog kennel', 'cat tree', 'pet stroller', 'dog ramp', 'dog stairs', 'elevated dog bed', 'dog playpen', 'orthopedic dog bed', 'cat wall shelves', 'dog house']
};

/** Nightly market-fill lanes (owner's local-for-local model, 2026-07-05):
 *  each lane discovers products the TARGET market's local warehouse really
 *  stocks and imports them as DRAFTS (tagged market-<cc>) for owner review.
 *  Publishing stays gated on the per-market visibility phase - drafts are
 *  invisible everywhere, so the lanes are safe to run every night. US first
 *  (deepest CJ supply); EU (DE) and AU lanes join once US validates.
 *  Per-lane `keywords` / `gateOverrides` replace the home-market discovery
 *  profile where the target market's economics differ (see US_SEED_KEYWORDS):
 *  priceMin 25 kills the commodity tier that always fails US street parity,
 *  priceMax 200 admits the furniture class the global band (80) would block. */
export const MARKET_SEED_LANES: {
  countryCode: string; maxDraftsPerNight: number;
  keywords?: Record<string, string[]>; gateOverrides?: Partial<Gates>;
}[] = [
  { countryCode: 'US', maxDraftsPerNight: 15, keywords: US_SEED_KEYWORDS, gateOverrides: { priceMin: 25, priceMax: 200 } },
];
import { getExpansions, seedTerm } from './semantic/library';
import { confirmAndImport, getCachedDetail, resolveCategory, reconcileAddonVisibility, reconcileHeroImages, reconcileCatalogImages, reconcileDescriptions, reconcileCategories, setProductTags, ADDON_CATEGORY } from './proxy/import';
import { runProfitAgent, competitorSignal, type CompetitorSignal } from './profitability';
import { ebayFromEnv } from './market';
import { AFFILIATE_ELIGIBLE_TAG, productAffiliateEligible, ensureAffiliateCollection } from './affiliate';
import { sendReorderReminders } from './retention';
import { enableTracking, getPrimaryLocationId, productInventoryItems, setInventoryQuantities, setSupplierMetafields, updateVariantPrices, updateVariantCosts, MAX_TRACKED_QTY } from './proxy/inventory';
import { retailPriceGbp, landedCostGbp } from './pricing';
import { parseDaysRange, resolveLogistics, doorToDoorBand, formatBand, bandFromQuote } from './logistics';
import { syncSignatureProfiles } from './shipping/delivery-profile';
import { syncMarketExclusions } from './shipping/market-catalogs';
import { syncUsFixedPrices } from './shipping/us-price-list';
import { resolveShipConfig } from './shipping/ship-config';
import { LOGISTICS_DESTINATIONS } from './inbox/freight';
import type { CjDetail } from './cj';
import { LlmClient, curateProduct, pickHeroImage, rewriteDescription, type Curation, type HeroPick } from './llm';
import { DEFAULT_SEMANTIC, type Env, type TenantConfig, type Gates } from './types';
import { rotateRecurringEvents } from './recurring-events';
import { debrandCatalog } from './catalog-debrand';
import { runArticleHealth, healArticleBody, saveArticleBody } from './blog/article-health';
import { getArticleForEnrich, updateArticleAssets } from './blog/article';
import { groundCollection } from './blog/ground';
import type { GuardDeps } from './catalog/archive-guard';

export const CULL_WINDOW_DAYS = 30; // grace period AND inactivity window
/** Engagement gate for the cull (2026-07-18): "zero events for this product"
 * is only evidence when the STORE had traffic to give. Below this many
 * catalog-wide qualifying events in the window, the cull stands down entirely -
 * it must never mow down a catalog for the crime of an unvisited storefront
 * (live incident: 48 products culled in a week on ~2 events/day store-wide
 * while Google listings were suspended). */
export const CULL_MIN_WINDOW_EVENTS = 100;
const LOG_RETENTION_DAYS = 90;
const MAX_IMPORTS_PER_RUN = 30; // W2: promotions cost 1 CJ stock-check each - well within budget
const CJ_CALL_GAP_MS = 1100; // CJ allows ~1 request/second

/** Low-band sellable reserve. CJ warehouse stock is SHARED across every CJ
 * merchant, so the last unit is the one most likely to be sniped between our
 * syncs. In the low band we sell one unit fewer than CJ reports: an oversold
 * order (refund + apology + trust damage) costs more than the last unit earns.
 * Above the band the race risk is negligible and the full quantity is sellable.
 * The PDP/cart display this same sellable number, so what the customer sees is
 * exactly what we are willing to sell. */
export const LOW_STOCK_BAND = 10;
export const LOW_STOCK_RESERVE = 1;
export function sellableQty(realStock: number): number {
  if (realStock <= 0) return 0;
  if (realStock <= LOW_STOCK_BAND) return Math.max(0, realStock - LOW_STOCK_RESERVE);
  return realStock;
}

/** "Selling fast" badge rule: at least this many REAL order events in the window.
 * Deterministic and grounded (only genuine recent sales light it; it clears on the
 * next sync when demand fades) - honest social proof, never an invented signal. */
export const SELLING_FAST_MIN_ORDERS = 3;
export const SELLING_FAST_WINDOW_DAYS = 7;

/** Console health stamps (Glance view): search_cache keys recording when each cron
 * last COMPLETED for a shop. Stamped only after the work succeeds, so a missing or
 * stale stamp honestly means "did not finish recently". The markets stamp carries a
 * JSON payload of per-market exclusion counts; the others are bare ISO timestamps. */
export const JOB_STAMP_DAILY = 'job:daily-maintenance';
export const JOB_STAMP_PIPELINE = 'job:order-pipeline';
export const JOB_STAMP_MARKETS = 'job:market-exclusions';
export const JOB_STAMP_TTL_DAYS = 30;

/** Sets a product back to ACTIVE. The UN-archive direction, so it is not an
 *  archive path and does not go through the guard. It previously shared a
 *  constant with the cull's archive mutation, which is why that constant
 *  outlived the archive call site. */
const SET_PRODUCT_ACTIVE = `mutation pawscoutActivate($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

/**
 * The live repair path handed to the archive guard.
 *
 * Everything here is reused rather than reimplemented: `healArticleBody` brings
 * the deterministic cage that makes an LLM relink safe (the chosen handle MUST
 * come from the grounded candidate list), and `saveArticleBody` is the same
 * mutation the nightly article-health pass writes with. A second relink path
 * would drift from the first, which is exactly how this codebase ended up with
 * three copies of the archive mutation.
 *
 * Candidates are grounded from the article's own funnel tag first, falling back
 * to any configured collection that still has live products - the same walk
 * runArticleHealth does, for the same reason: archives bury collection heads,
 * so a narrow window comes back all-dead.
 */
export function buildGuardDeps(
  _env: Env, store: TenantStore, cfg: TenantConfig, admin: AdminGraphql, llm: LlmClient
): GuardDeps {
  return {
    loadArticle: (articleId) => getArticleForEnrich(admin, articleId).catch(() => null),
    saveArticle: (articleId, body) => saveArticleBody(admin, articleId, body),
    saveRelated: (articleId, handles) => updateArticleAssets(admin, { articleId, relatedHandles: handles }),
    async liveCandidates(excludeHandle, tags) {
      const validHandles = Object.values(cfg.collectionMap).map((c) => c.handle).filter(Boolean);
      // The article's own tag leads; it is the collection the guide was written
      // for, so its products are the most congruent replacements available.
      const order = [...tags.filter((t) => validHandles.includes(t)), ...validHandles];
      const seen = new Set<string>();
      for (const h of order) {
        if (seen.has(h)) continue;
        seen.add(h);
        const pack = await groundCollection(admin, h).catch(() => null);
        const usable = (pack?.products ?? [])
          .filter((p) => p.available && p.handle.toLowerCase() !== excludeHandle.toLowerCase())
          .map((p) => ({ title: p.title, handle: p.handle, path: p.path }));
        if (usable.length) return usable;
      }
      return [];
    },
    healBody: (o) => healArticleBody(llm, store, cfg, o),
  };
}

/**
 * 30-day performance cull: ARCHIVE (never delete) imported products with zero
 * qualifying events (view/atc/order) in the window. Products younger than the
 * window are exempt by the same cutoff (grace period).
 *
 * Since 2026-07-31 this is the ONLY automated takedown in the system - the
 * profitability agent no longer archives - and it goes through
 * archiveProductGuarded, which refuses a product that a guide or a syndicated
 * post still points at and creates a URL redirect before anything is archived.
 * Its inline ARCHIVE mutation was deleted; a refusal is logged, not thrown.
 */
export async function cullStaleProducts(
  store: TenantStore,
  admin: AdminGraphql,
  now: () => number = Date.now,
  deps?: GuardDeps
): Promise<number> {
  const cutoff = new Date(now() - CULL_WINDOW_DAYS * 86400_000).toISOString();
  // Engagement gate: with next to no store-wide traffic in the window, a
  // product's zero events carry no signal - stand down rather than archive.
  const windowEvents = await store.countProductEventsSince(cutoff);
  if (windowEvents < CULL_MIN_WINDOW_EVENTS) {
    console.log(`cull: standing down - only ${windowEvents} store-wide events in ${CULL_WINDOW_DAYS}d (< ${CULL_MIN_WINDOW_EVENTS})`);
    return 0;
  }
  const stale = await store.linksEligibleForArchive(cutoff);
  let archived = 0;
  // One memo for the whole run: the stale set shares a handful of categories,
  // so without it the same "is this collection still live?" question is asked
  // once per product instead of once per category.
  const memo: LivenessMemo = new Map();
  // Built once and shared for the same reason. Skipped entirely when there is
  // nothing to cull, so a quiet night costs no Shopify call.
  const articles = stale.length ? await buildArticleTargets(store, admin) : null;
  for (const link of stale) {
    if (!link.shopify_product_id || !link.handle) continue;
    try {
      const out = await archiveProductGuarded(admin, store, {
        cjPid: link.cj_pid,
        productId: link.shopify_product_id,
        handle: link.handle,
        reason: 'no-movement cull',
        memo,
        articles,
      }, deps);
      if (out.ok) {
        await store.putLink({ cjPid: link.cj_pid, state: 'archived' });
        archived++;
      } else {
        // Not an error: a refusal is the guard working. Logged with its reason
        // so a cull that archives nothing is diagnosable rather than mysterious.
        console.log(`cull: skipped ${link.cj_pid} - ${out.refusal}: ${out.detail}`);
      }
    } catch (e) {
      console.warn(`cull: archive failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return archived;
}

/**
 * Undo a no-traffic cull wave (2026-07-18): restore archived products whose
 * archive is attributable to the CULL - archived since `sinceIso` with NO real
 * agent drop on record (agent drops are economics, the owner's console archives
 * are the owner's call; neither is ours to reverse here). Restored products
 * re-enter the profit agent's walk, so a genuine loser is re-judged on
 * evidence, not resurrected permanently. Owner-triggered (console).
 */
/**
 * Give every already-archived product a redirect so it stops 404ing.
 *
 * This is the repair half of the work. Task 7 stops NEW 404s being minted;
 * this clears the ones already in Google's index - 112 archived links measured
 * 2026-07-31, all with handles.
 *
 * Re-runnable by design rather than one-shot: findRedirect is consulted first,
 * so a second run creates nothing. That matters because the owner triggers it
 * by hand and a double-click must not mint duplicates.
 *
 * `dryRun` defaults to TRUE. This writes to the live storefront's routing
 * table, so the safe outcome is the one you get by forgetting the flag.
 *
 * One liveness memo spans the whole run: the 112 share a handful of categories,
 * so each collection is checked once rather than 112 times.
 */
export async function backfillArchivedRedirects(
  store: TenantStore,
  admin: AdminGraphql,
  opts: { limit?: number; dryRun?: boolean } = {}
): Promise<{ scanned: number; created: number; skipped: number; failed: number; dryRun: boolean; samples: string[]; byTarget: Record<string, number> }> {
  const dryRun = opts.dryRun !== false;
  const links = await store.listArchivedLinksWithHandles(opts.limit ?? 500);
  const memo: LivenessMemo = new Map();
  // One article index for the whole run, same reasoning as the liveness memo.
  // These are historic archives, so none carry a referrer row any more - they
  // reach a guide through the CATEGORY level of the index, not the exact one.
  const articles = await buildArticleTargets(store, admin);
  let created = 0, skipped = 0, failed = 0;
  const samples: string[] = [];
  // Counts per destination. `samples` caps at 12, which is enough to eyeball
  // the format and nowhere near enough to see the DISTRIBUTION - and the
  // distribution is what decides whether this repair is worth shipping. If most
  // of the 112 land on /collections/all rather than a sibling or a category
  // page, that is a much weaker fix than "the 404s are handled" suggests, and
  // the dry run should say so before anything is written.
  const byTarget: Record<string, number> = {};
  for (const link of links) {
    const path = `/products/${link.handle}`;
    try {
      if (await findRedirect(admin, path)) { skipped++; continue; }
      // No guide gate here, deliberately. These URLs are ALREADY dead, so the
      // question is only which live page best replaces them - refusing would
      // leave a 404 standing, which is the one outcome the owner ruled out.
      const { path: target, tier } = await pickRedirectTarget(store, admin, link.handle!, memo, { articles });
      if (!dryRun) await createRedirect(admin, path, target);
      created++;
      byTarget[target] = (byTarget[target] ?? 0) + 1;
      if (samples.length < 12) samples.push(`${path} -> ${target} (${tier})`);
    } catch (e) {
      failed++;
      console.warn(`redirect backfill failed for ${link.cj_pid} (${path}): ${(e as Error).message}`);
    }
  }
  const spread = Object.entries(byTarget).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} x${n}`).join(', ');
  console.log(`redirect backfill (${dryRun ? 'DRY RUN' : 'live'}): ${created} created, ${skipped} already had one, ${failed} failed of ${links.length}${spread ? ` | targets: ${spread}` : ''}`);
  return { scanned: links.length, created, skipped, failed, dryRun, samples, byTarget };
}

export async function restoreCulledProducts(
  store: TenantStore,
  admin: AdminGraphql,
  sinceIso: string
): Promise<{ restored: number; failed: number }> {
  const links = await store.listCulledArchivedLinks(sinceIso);
  let restored = 0, failed = 0;
  for (const link of links) {
    // DELETE THE REDIRECT FIRST. Every archive now leaves one behind, so a
    // product restored while its own /products/<handle> still redirects
    // elsewhere is live but unreachable, and that failure reports as success.
    //
    // Deliberately its OWN try/catch rather than sharing the activation's. A
    // lookup fault and an activation fault are different problems with
    // different fixes, and folding them together made a 502 on the redirect
    // read indistinguishable from Shopify refusing the status change.
    //
    // Still fail-closed: an unknown redirect state means we cannot promise the
    // product would be reachable, and staying archived is retried next run
    // whereas live-but-invisible is silent. The log says which it was.
    if (link.handle) {
      try {
        const existing = await findRedirect(admin, `/products/${link.handle}`);
        if (existing) await deleteRedirect(admin, existing.id);
      } catch (e) {
        failed++;
        const m = (e as Error).message;
        console.warn(`restore-culled: redirect cleanup ${isScopeDenial(m) ? 'DENIED (scope)' : 'failed'} for ${link.cj_pid}: ${m} - left archived rather than restored behind a possible redirect`);
        continue;
      }
    }
    try {
      const data = await admin(SET_PRODUCT_ACTIVE, { input: { id: link.shopify_product_id, status: 'ACTIVE' } });
      const errs = (data.productUpdate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
      if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
      await store.putLink({ cjPid: link.cj_pid, state: 'imported' });
      restored++;
    } catch (e) {
      failed++;
      console.warn(`restore-culled: failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return { restored, failed };
}

/**
 * W2.1 - store refill promotes FROM THE WAREHOUSE (no CJ search calls).
 * Two passes over the mapped collections: first raise every category to
 * `floors.storeFloor`, then top up toward `target`. Each promotion goes
 * through confirmAndImport (one live CJ stock check, paced). A warehouse
 * that can't supply a floor logs the shortfall - gates are never bypassed.
 */
export async function refillCollections(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  opts: { maxImports?: number; pause?: (ms: number) => Promise<void>; now?: () => number; curate?: (detail: CjDetail, context: string) => Promise<Curation | null>; pickHero?: (title: string, imageUrls: string[]) => Promise<HeroPick>; competitorCheck?: (detail: CjDetail, ourRetailGbp: number) => Promise<CompetitorSignal | null> } = {}
): Promise<number> {
  const maxImports = opts.maxImports ?? MAX_IMPORTS_PER_RUN;
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let imported = 0;

  const promote = async (row: { cj_pid: string; detail: string; stock: number }, category: string): Promise<boolean> => {
    if (row.stock < cfg.floors.stockFloor) return false;
    const link = await store.getLink(row.cj_pid);
    if (link && (link.state === 'imported' || link.state === 'importing' || link.state === 'draft')) return false;
    let detail: CjDetail;
    try { detail = JSON.parse(row.detail) as CjDetail; } catch { return false; }
    // Local-for-local pre-filter: a row whose origins map PROVES it has no
    // home-local warehouse never spends a CJ call. Rows without an origins map
    // proceed - confirmAndImport verifies live and fails closed either way.
    if (detail.origins && bestLocalQty(detail.origins, HOME_MARKET_WAREHOUSES) < cfg.floors.stockFloor) return false;
    await pause(CJ_CALL_GAP_MS); // confirmAndImport makes one CJ stock call
    await confirmAndImport(store, cj, admin, cfg, detail, category, opts.curate, opts.pickHero, { competitorCheck: opts.competitorCheck });
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

  // W-ADDON: top up the hidden filler pool (its own quota, never the category counts).
  if (cfg.addons.enabled) {
    let deficit = cfg.addons.poolSize - (await store.countImportedByCategory('addons'));
    for (const row of await store.warehouseByCategory('addons', 50)) {
      if (deficit <= 0 || imported >= maxImports) break;
      if (await promote(row, 'addons')) {
        imported++;
        deficit--;
      }
    }
  }
  return imported;
}

/**
 * W2.3 - daily CJ→Shopify stock sync for every listed product:
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
  opts: { maxProducts?: number; offset?: number; pause?: (ms: number) => Promise<void>; errors?: string[]; onlyCjPids?: string[] } = {}
): Promise<number> {
  const maxProducts = opts.maxProducts ?? 60;
  const offset = opts.offset ?? 0;
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Price-authority handoff: when the active profitability agent is LIVE (enabled
  // AND not dry-run) IT owns shelf prices - it raises above the rule price to just
  // under a higher competitor. This nightly sync must then NOT drag those back down
  // to the (lower) rule price, or the two crons sawtooth the price against each
  // other. Cost-per-item and stock still sync every night regardless; only the
  // price-LOWERING is ceded. In dry-run or when disabled, the sync keeps full control.
  const profitOwnsPrice = cfg.profit?.enabled === true && cfg.profit?.dryRun === false;
  const locationId = await getPrimaryLocationId(admin);
  if (!locationId) {
    console.warn('inventory sync skipped: no primary location');
    return 0;
  }

  let links = await store.listImportedLinks();
  if (opts.onlyCjPids) {
    const want = new Set(opts.onlyCjPids);
    links = links.filter((l) => want.has(l.cj_pid));
  }
  let synced = 0;
  for (const link of links.slice(offset, offset + maxProducts)) {
    if (!link.shopify_product_id) continue;
    try {
      // Fresh CJ detail: source of truth for variant costs (price sync) and,
      // when present, stock - saving the separate stock call.
      await pause(CJ_CALL_GAP_MS);
      let detail: CjDetail | null = null;
      try { detail = await cj.detail(link.cj_pid); } catch { detail = null; }
      if (detail) await store.putSearchCache(`pid:${link.cj_pid}`, JSON.stringify(detail), 30);

      let stockMap = new Map<string, number>();
      let maxStock = detail?.stock ?? 0;
      let stockKnown = maxStock > 0;
      if (detail) {
        for (const v of detail.variants) if (v.stock !== undefined) stockMap.set(v.vid, v.stock);
      }
      if (!stockKnown) {
        // A broken stock endpoint must NEVER zero the store or block the
        // price sync - unknown means "leave quantities alone", not "0".
        try {
          await pause(CJ_CALL_GAP_MS);
          stockMap = await cj.stockByPid(link.cj_pid);
          maxStock = stockMap.size ? Math.max(...stockMap.values()) : 0;
          stockKnown = true; // a successful empty answer IS knowledge: no stock
        } catch (e) {
          console.warn(`stock unknown for ${link.cj_pid}: ${(e as Error).message}`);
          opts.errors?.push(`${link.cj_pid}: stock unknown (${(e as Error).message}) - prices still synced`);
        }
      }
      const paused = stockKnown && maxStock < cfg.floors.stockFloor;

      // Freight captured at admission/import lives on the stored warehouse
      // detail; fresh details don't carry it (no extra CJ call here).
      const wh = await store.getWarehouseProduct(link.cj_pid);
      let freightUsd: number | undefined;
      let storedOrigin: string | undefined;
      let storedVariants: CjDetail['variants'] = [];
      if (wh) {
        try {
          const stored = JSON.parse(wh.detail) as CjDetail;
          freightUsd = stored.freightUsd;
          storedOrigin = stored.origin;
          storedVariants = stored.variants ?? [];
        } catch { /* legacy row */ }
      }
      const origin = detail?.origins ? chooseOrigin(detail, cfg.floors.stockFloor) : storedOrigin;

      // SKU → vid mapping for per-variant quantities (fresh detail preferred).
      const skuToVid = new Map<string, string>();
      const skuToCost = new Map<string, number>();
      if (detail) {
        for (const v of detail.variants) {
          skuToVid.set(v.sku, v.vid);
          skuToCost.set(v.sku, v.sellPriceUsd);
        }
      } else if (wh) {
        // Fresh CJ detail fetch failed: fall back to the STORED variant costs so the
        // price and cost sync still run from last-known cost, instead of freezing the
        // sticker. Without seeding skuToCost here, any product CJ can no longer return
        // fresh detail for is stuck forever at its import-time price (the "frozen
        // catalogue" problem: prices set under an older multiplier never converge on
        // the current pricing rule).
        try {
          for (const v of (JSON.parse(wh.detail) as CjDetail).variants) {
            skuToVid.set(v.sku, v.vid);
            if (typeof v.sellPriceUsd === 'number' && v.sellPriceUsd > 0) skuToCost.set(v.sku, v.sellPriceUsd);
          }
        } catch { /* legacy row: fall back to uniform stock */ }
      }

      const variants = await productInventoryItems(admin, link.shopify_product_id);
      if (stockKnown) {
        // Untracked variants (imports whose CJ detail lacked stock) must be
        // activated first or the quantity write below errors out.
        await enableTracking(admin, link.shopify_product_id, variants.filter((v) => !v.tracked));
        await setInventoryQuantities(
          admin,
          locationId,
          variants.map((v) => {
            const vid = skuToVid.get(v.sku);
            const raw = vid !== undefined ? stockMap.get(vid) ?? maxStock : maxStock;
            const qty = paused ? 0 : sellableQty(raw); // low-band reserve: never sell the race-prone last unit
            return { inventoryItemId: v.inventoryItemId, quantity: Math.min(qty, MAX_TRACKED_QTY) };
          })
        );
      }

      // Price sync: realign retail toward the pricing rule applied to CJ's CURRENT
      // cost. Only variants whose SKU matches a CJ variant reprice; unchanged prices
      // are skipped. The sync only ever LOWERS a live price: a rule-driven increase
      // (a frozen underpriced item, or a CJ cost rise) must be a deliberate owner
      // decision, never an automatic customer-facing price hike. This is what lets the
      // frozen-catalogue reprice drop overpriced items without bumping the freight-
      // cratered cheap CN items to their (uncompetitive) rule price - those need the
      // decoupled-shipping model, not a hike. Increases are left for owner review.
      const priceUpdates = profitOwnsPrice ? [] : variants.flatMap((v) => {
        const cost = skuToCost.get(v.sku);
        if (cost === undefined || cost <= 0) return [];
        const expected = retailPriceGbp(cost, cfg.pricing, freightUsd).toFixed(2);
        if (expected === v.price) return [];
        if (Number(expected) > Number(v.price)) return []; // never auto-raise; lower only
        return [{ id: v.variantId, price: expected }];
      });
      if (priceUpdates.length) await updateVariantPrices(admin, link.shopify_product_id, priceUpdates);

      // Cost-per-item sync: write the honest landed GBP COGS (raw FX, product +
      // freight) so Shopify margin analytics and the affiliate £6 floor read a
      // current figure. Admin-only field; only changed costs are written.
      // Freight-UNKNOWN guard (2026-07-10 audit): when the stored row carries no
      // freightUsd the landed figure here is ITEM-ONLY, and writing it would strip
      // real freight from an honest cost - the profitability agent then judges an
      // understated cost and over-states net. With freight unknown, never LOWER an
      // existing cost: raises (a real CJ item-cost rise) still land, an empty cost
      // still gets seeded, and the nightly freight backfill fills the row so the
      // full figure converges. Known freight (including 0) syncs freely.
      const costUpdates = variants.flatMap((v) => {
        const cost = skuToCost.get(v.sku);
        if (cost === undefined || cost <= 0) return [];
        const landed = landedCostGbp(cost, cfg.pricing, freightUsd).toFixed(2);
        const current = v.cost === '' ? '' : Number(v.cost).toFixed(2);
        if (current === landed) return [];
        if (freightUsd === undefined && current !== '' && Number(landed) < Number(current)) return [];
        return [{ inventoryItemId: v.inventoryItemId, cost: landed }];
      });
      if (costUpdates.length) await updateVariantCosts(admin, costUpdates);

      // Affiliate eligibility (1.2): toggle the `affiliate-eligible` tag iff
      // EVERY sellable variant clears the £6 ex-VAT, after-commission-and-fee
      // floor. Computed from CJ variant costs + freight (the same numbers the
      // price/cost sync just wrote). Skip when no cost source is available, so a
      // transient no-data day never un-tags an eligible product.
      const eligSource = detail?.variants ?? storedVariants;
      if (eligSource.length && link.category !== ADDON_CATEGORY) {
        const eligible = productAffiliateEligible(eligSource, cfg.pricing, freightUsd);
        await setProductTags(admin, link.shopify_product_id, [AFFILIATE_ELIGIBLE_TAG], eligible);
      }

      if (stockKnown) {
        // Per-product delivery estimate from the synced matrix (this product's origin
        // -> GB). Computed AFTER the load-bearing stock writes and fully guarded: a
        // missing/stale row or any read failure yields '' => the metafield is CLEARED
        // => the PDP falls back to its static window. A logistics gap never strands
        // inventory, and only a real, fresh figure is ever surfaced.
        const logiCfg = resolveLogistics(cfg.fulfil);
        let deliveryDays = '';
        try {
          const route = await store.getLogisticsRoute(origin ?? 'CN', 'GB', logiCfg.stalenessHours);
          deliveryDays = formatBand(doorToDoorBand(route, logiCfg));
        } catch (e) {
          console.warn(`delivery_days lookup failed for ${link.cj_pid}: ${(e as Error).message}`);
        }
        // PER-PRODUCT ACTUAL estimate: quote THIS product's own cheapest freight (its
        // own variant weight) -> the band shown at checkout. One extra CJ call/product;
        // any failure leaves it '' (omitted -> checkout falls back to the representative).
        let deliveryDaysActual = '';
        const productVid = (detail?.variants ?? storedVariants).find((v) => v.vid && v.vid !== 'default')?.vid;
        if (productVid) {
          try {
            await pause(CJ_CALL_GAP_MS);
            const fe = await cj.freightEstimate(productVid, origin ?? 'CN', 'GB');
            deliveryDaysActual = formatBand(bandFromQuote(fe?.days, origin ?? 'CN', 'GB', logiCfg));
          } catch (e) {
            console.warn(`actual freight quote failed for ${link.cj_pid}: ${(e as Error).message}`);
          }
        }
        // Real-demand flag: genuine order events in the window, nothing else. An
        // unsellable (paused) product never claims demand.
        let demand: 'selling_fast' | 'none' = 'none';
        try {
          const since = new Date(Date.now() - SELLING_FAST_WINDOW_DAYS * 86400_000).toISOString();
          const recentOrders = await store.countRecentOrderEvents(link.cj_pid, since);
          demand = !paused && recentOrders >= SELLING_FAST_MIN_ORDERS ? 'selling_fast' : 'none';
        } catch { /* keep 'none' */ }
        await setSupplierMetafields(admin, link.shopify_product_id, {
          status: paused ? 'out_of_stock' : maxStock < cfg.floors.stockFloor * 2 ? 'low_stock' : 'available',
          qty: paused ? maxStock : sellableQty(maxStock), // theme fallback shows/caps the SELLABLE number
          checkedAt: new Date().toISOString(),
          origin,
          deliveryDays,
          deliveryDaysActual,
          demand
        });
        await store.setStockPaused(link.cj_pid, paused);
        await store.setWarehouseStock(link.cj_pid, maxStock, paused ? 'low_stock' : 'available');
      }
      synced++;
    } catch (e) {
      // Per-product failures (CJ hiccups, Shopify errors) log and move on; never abort the run.
      console.warn(`inventory sync failed for ${link.cj_pid}: ${(e as Error).message}`);
      opts.errors?.push(`${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return synced;
}

/** Origin-signature backfill batch: paced CJ detail (+freight) calls per nightly run. */
export const ORIGIN_BACKFILL_BATCH = 15;

/**
 * Backfill origin signatures (2026-07-03, free-UK-delivery cutover step C): imported
 * products with no origins-bearing warehouse row (pre-warehouse imports or purged
 * rows) have no origin signature, so they sit on the merchant's MANUAL default
 * shipping profile instead of the engineered per-origin profiles. For each, fetch
 * the CJ detail (which carries the per-country origins map), capture the freight
 * estimate the pricing rule bakes into the sticker, and upsert a warehouse row -
 * the same night's signature-profile sync then adopts the product. Products whose
 * CJ detail shows no stocked origin are left alone (default profile = honest
 * fallback). Paced (~1.1s/call) and capped per run; the list drains over a few
 * nights and stays empty once healthy.
 */
export async function backfillOriginSignatures(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  opts: { limit?: number; pause?: (ms: number) => Promise<void> } = {}
): Promise<number> {
  const rows = await store.importedCjPidsWithoutOrigins(opts.limit ?? ORIGIN_BACKFILL_BATCH);
  if (!rows.length) return 0;
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let done = 0;
  for (const row of rows) {
    try {
      await pause(1100);
      let detail = await cj.detail(row.cj_pid);
      if (!detail || !detail.variants.length) continue;
      const origins = detail.origins ?? {};
      if (!Object.values(origins).some((n) => n > 0)) continue; // no stocked origin at CJ - stays on the default profile
      if (detail.freightUsd === undefined) {
        detail = { ...detail, origin: detail.origin ?? chooseOrigin(detail, cfg.floors.stockFloor) };
        const vid = detail.variants[0]?.vid;
        if (vid && vid !== 'default') {
          try {
            await pause(1100);
            const f = await cj.freightEstimate(vid, detail.origin);
            if (f) detail = { ...detail, freightUsd: f.priceUsd };
          } catch (e) {
            console.warn(`origin backfill freight estimate failed for ${row.cj_pid}: ${(e as Error).message}`);
          }
        }
      }
      await store.putWarehouseProduct({
        cjPid: row.cj_pid,
        category: row.category,
        title: detail.nameEn,
        detailJson: JSON.stringify(detail),
        priceUsd: Math.min(...detail.variants.map((v) => v.sellPriceUsd)),
        listedNum: detail.listedNum,
        stock: detail.stock ?? Math.max(0, ...Object.values(origins))
      });
      done++;
    } catch (e) {
      console.warn(`origin backfill failed for ${row.cj_pid}: ${(e as Error).message}`);
    }
  }
  if (done) console.log(`origin backfill: ${done} product(s) gained an origin signature`);
  return done;
}

/** Freight backfill batch: up to 2 paced CJ calls per row per nightly run. */
export const FREIGHT_BACKFILL_BATCH = 40;

/**
 * Backfill warehouse freight (2026-07-10 profitability audit): legacy warehouse
 * rows admitted before freight capture carry no freightUsd, so the nightly cost
 * sync could only write a freight-FREE landed cost and the profitability agent
 * judged those products on understated costs (75 of 164 live products at audit
 * time; the origin backfill never revisits them because its work-list keys on
 * missing ORIGINS, and a row whose freight estimate once failed has origins).
 * For each imported product whose row lacks freight, choose its dispatch origin
 * (fetching the per-country origins map when the stored detail lacks one) and
 * write the freight estimate into the stored detail - a detail-only update that
 * never touches stock or status. The same nightly's store-inventory stage then
 * writes the corrected landed cost, and the 15-min profit agent re-judges on it.
 * The work-list keys on the field this writes, so a failed estimate simply stays
 * in the list and retries the next night. Paced (~1.1s/call), capped per run.
 */
export async function backfillWarehouseFreight(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  opts: { limit?: number; pause?: (ms: number) => Promise<void> } = {}
): Promise<number> {
  const rows = await store.importedRowsWithoutFreight(opts.limit ?? FREIGHT_BACKFILL_BATCH);
  if (!rows.length) return 0;
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let done = 0;
  for (const row of rows) {
    try {
      let detail: CjDetail;
      try { detail = JSON.parse(row.detail) as CjDetail; } catch { continue; } // corrupt legacy row - nothing to annotate
      const vid = detail.variants?.[0]?.vid;
      if (!vid || vid === 'default') continue; // no real variant id - CJ cannot quote freight
      let origins = detail.origins;
      if (!origins || !Object.values(origins).some((n) => n > 0)) {
        await pause(CJ_CALL_GAP_MS);
        origins = await cj.originsByPid(row.cj_pid);
        if (!Object.values(origins).some((n) => n > 0)) continue; // nothing stocked anywhere - no origin to quote from
      }
      const origin = detail.origin ?? chooseOrigin({ ...detail, origins }, cfg.floors.stockFloor);
      await pause(CJ_CALL_GAP_MS);
      const f = await cj.freightEstimate(vid, origin);
      if (!f) continue; // no quote - the row stays in the work-list and retries next night
      await store.updateWarehouseDetail(row.cj_pid, JSON.stringify({ ...detail, origins, origin, freightUsd: f.priceUsd }));
      done++;
    } catch (e) {
      console.warn(`freight backfill failed for ${row.cj_pid}: ${(e as Error).message}`);
    }
  }
  if (done) console.log(`freight backfill: ${done} warehouse row(s) gained freightUsd`);
  return done;
}

/**
 * Fast re-sync for the LOW BAND only, run from the 15-minute cron. The nightly
 * sync leaves up to a 24h staleness window; for items at or below LOW_STOCK_BAND
 * (where a shared-warehouse race is most likely) this shrinks it to minutes. It
 * is only ever a handful of products, so the CJ call cost is negligible; a run
 * with no low-band items is free (no CJ or Shopify calls at all).
 */
export async function resyncLowStockInventory(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  opts: { pause?: (ms: number) => Promise<void> } = {}
): Promise<number> {
  const pids = await store.lowStockImportedCjPids(LOW_STOCK_BAND);
  if (!pids.length) return 0;
  return syncStoreInventory(store, cj, admin, cfg, { onlyCjPids: pids, maxProducts: pids.length, pause: opts.pause });
}

// --- W1: warehouse replenishment + freshness ---

export interface ReplenishOpts {
  maxCjCalls?: number;
  maxAdmits?: number;
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
  /** W3: admission curation - score + rewrite. null result = mechanical gates only. */
  curate?: (detail: CjDetail, context: string) => Promise<Curation | null>;
}

/**
 * Keep the PS-local warehouse stocked: demand keywords first (most-searched,
 * under-served), then categories below `floors.warehouseDepth`. Admission =
 * gates + stock ≥ `floors.stockFloor` + not already warehoused/imported.
 * Budgets bound both CJ calls and admits per run; shortfalls just carry to the
 * next night - quality and pacing always outrank the quota.
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
  // Dedupe-at-admission: signatures of every product already in the warehouse,
  // so a near-identical item (incl. literal twins) is never admitted twice.
  const seenTitleSigs = new Set((await store.warehouseTitles()).map(titleSignature));

  const spend = async (): Promise<void> => {
    cjCalls++;
    await pause(CJ_CALL_GAP_MS);
  };

  const search = async (keyword: string, gates = cfg.gates): Promise<CjSearchItem[]> => {
    const kw = normalizeKeyword(keyword);
    // Local-for-local (2026-07-05): sourcing discovers ONLY home-local
    // warehouse stock, so the pool never fills with products the home market
    // is not allowed to sell. Shares the kw3: cache namespace with
    // proxy/search.ts (bumped from kw2: which held unfiltered global results)
    // so sourcing and the storefront feed still reuse one CJ fetch.
    const home = HOME_MARKET_WAREHOUSES[0];
    const cached = await store.getSearchCache(`kw3:${home}:${kw}`);
    let items: CjSearchItem[];
    if (cached) {
      items = JSON.parse(cached);
    } else {
      if (cjCalls >= maxCjCalls) return [];
      await spend();
      items = await cj.searchByWarehouse(kw, home);
      await store.putSearchCache(`kw3:${home}:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
    }
    // Trust listV2 relevance + enforce species/price (then the LLM curates):
    // the same gate the storefront uses, so the warehouse stocks what searches
    // can actually surface - and demand keywords like "dog toy" admit real dog
    // products, not only ones with the literal word "toy".
    return items.filter((i) => liveCjPasses(i, gates, kw)).sort((a, b) => b.listedNum - a.listedNum);
  };

  const tryAdmit = async (item: CjSearchItem, category: string | null, context: string, lane: 'main' | 'addon' = 'main'): Promise<boolean> => {
    if (admitted >= maxAdmits || cjCalls >= maxCjCalls) return false;
    if (await store.getWarehouseProduct(item.pid)) return false;
    const link = await store.getLink(item.pid);
    if (link && (link.state === 'imported' || link.state === 'importing')) return false;

    await spend();
    const detail = await getCachedDetail(store, cj, item.pid);
    if (!detail) return false;

    // Local-for-local pool admission (2026-07-05): the warehouse pool feeds
    // refill promotions AND storefront suggestions, so only products a
    // home-local warehouse really stocks may enter it. Fails closed on an
    // unverifiable origin. Local stock doubles as the stock-floor figure -
    // total-across-all-warehouses no longer means anything here.
    let origins = detail.origins;
    if (!origins) {
      if (cjCalls >= maxCjCalls) return false;
      await spend();
      try {
        origins = await cj.originsByPid(item.pid);
      } catch {
        return false; // unknown origin = not admissible
      }
    }
    const stock = bestLocalQty(origins, HOME_MARKET_WAREHOUSES);
    if (stock < cfg.floors.stockFloor) return false;

    // W3: LLM curation - quality score + rewritten copy. A failed/absent LLM
    // degrades to mechanical gates; a low score is a hard reject.
    let title = detail.nameEn;
    // origins ride along so the refill pre-filter and the storefront search
    // can read the local-warehouse evidence without re-probing CJ.
    let admittedDetail: CjDetail = { ...detail, stock, origins };
    let resolvedCategory = category ?? resolveCategory(cfg, detail);
    let llmAdmitted = false;
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
          llmScore: curated.relevanceScore,
          petClass: curated.petClass
        };
        if (curated.category) resolvedCategory = curated.category;
        llmAdmitted = true;
      }
    }
    // Mechanical pet-relevance floor: when the LLM didn't admit (down/absent),
    // reject items with no pet signal and a clear non-pet marker (kitchen/garden/
    // human-grooming tools) that the mechanical gates would otherwise let in.
    if (!llmAdmitted && !isLikelyPetProduct(`${detail.nameEn} ${detail.categoryName ?? ''}`)) {
      console.warn(`admission blocked (not pet-relevant) for ${item.pid}: ${detail.nameEn}`);
      return false;
    }
    // Dedupe-at-admission: skip a product whose significant-title signature is
    // already stocked (true duplicates / reorderings; distinct items survive).
    const sig = titleSignature(title);
    if (sig && seenTitleSigs.has(sig)) {
      console.warn(`admission skipped (duplicate of stocked product) for ${item.pid}: ${title}`);
      return false;
    }
    // W-ADDON: hidden fillers live under their own category key - never a
    // browsable collection, never counted toward category floors/targets.
    if (lane === 'addon') resolvedCategory = 'addons';

    // Freight-aware floor (decided 2026-06-12): capture origin + cheapest
    // freight at admission so the pricing min-margin sees true landed cost.
    const origin = chooseOrigin(admittedDetail, cfg.floors.stockFloor);
    admittedDetail = { ...admittedDetail, origin };
    const freightVid = admittedDetail.variants[0]?.vid;
    if (freightVid && freightVid !== 'default' && cjCalls < maxCjCalls) {
      await spend();
      try {
        const f = await cj.freightEstimate(freightVid, origin);
        if (f) admittedDetail = { ...admittedDetail, freightUsd: f.priceUsd };
      } catch (e) {
        console.warn(`freight estimate failed for ${item.pid}: ${(e as Error).message}`);
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
    if (sig) seenTitleSigs.add(sig); // guard against a second duplicate later in this run
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

  // 2) categories below warehouse depth. Each collection sources its base noun
  // ("pet cleaning") PLUS any cached semantic expansions ("dog shampoo", "paw
  // wash") so a thin category pulls a wider, still-pet-scoped candidate set.
  // getExpansions is cache-only (semantic disabled/excluded → []); search()'s
  // budget cap and seenTitleSigs dedupe keep CJ spend and admissions unchanged.
  for (const key of Object.keys(cfg.collectionMap)) {
    if (admitted >= maxAdmits || cjCalls >= maxCjCalls) break;
    let deficit = cfg.floors.warehouseDepth - (await store.countWarehouseAvailableByCategory(key));
    if (deficit <= 0) continue;
    const baseKw = key.replace(/-/g, ' ');
    const sourcingKws = [baseKw, ...(await getExpansions(store, cfg, baseKw, key))];
    for (const kw of sourcingKws) {
      if (deficit <= 0 || admitted >= maxAdmits || cjCalls >= maxCjCalls) break;
      for (const item of await search(kw)) {
        if (deficit <= 0 || admitted >= maxAdmits || cjCalls >= maxCjCalls) break;
        if (await tryAdmit(item, key, kw)) deficit--;
      }
    }
  }

  // 3) W-ADDON: hidden basket-filler pool - sub-main-gate price band, SAME
  // LLM curation, capped pool. Reuses the keyword caches the sweep above
  // just filled, so this lane costs no extra CJ search calls.
  if (cfg.addons.enabled) {
    const addonGates = { ...cfg.gates, priceMin: cfg.addons.priceMinUsd, priceMax: cfg.addons.priceMaxUsd };
    let deficit = cfg.addons.poolSize
      - (await store.countWarehouseAvailableByCategory('addons'))
      - (await store.countImportedByCategory('addons'));
    for (const key of Object.keys(cfg.collectionMap)) {
      if (deficit <= 0 || admitted >= maxAdmits || cjCalls >= maxCjCalls) break;
      for (const item of await search(key.replace(/-/g, ' '), addonGates)) {
        if (deficit <= 0 || admitted >= maxAdmits || cjCalls >= maxCjCalls) break;
        if (await tryAdmit(item, null, 'cheap pet add-on: ' + key.replace(/-/g, ' '), 'addon')) deficit--;
      }
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

/**
 * Refresh the CJ delivery-TIME matrix for one origin across a set of shops (the
 * testable core). Transit is shop-invariant, so ONE reference CjClient quotes each
 * destination once and the parsed row is FANNED OUT to every CJ shop's partition.
 *
 * Resilient: per-route failure (CJ error / no options / unparseable aging) keeps
 * the last-good row and bumps its failure counter - never nulls a good row, never
 * throws. Bounded by maxCjCalls; aborts after 3 consecutive 429s (the relay IP is
 * shared). Refreshes oldest-synced destinations first so a truncated run never
 * starves the same tail. Governing rule: only a real, parseable quote becomes a
 * customer-facing number; everything else degrades to the hedge.
 */
export async function syncCjLogisticsRoutes(
  cjStores: TenantStore[],
  reference: TenantStore,
  cj: Pick<CjClient, 'freightQuote'>,
  repVid: string,
  destinations: string[],
  opts: {
    from?: string;
    maxCjCalls?: number;
    pause?: (ms: number) => Promise<void>;
    allowInMarket?: boolean;
    quote?: (vid: string, from: string, to: string, qty: number) => Promise<{ priceUsd: number; days: string; name: string }[]>;
  } = {}
): Promise<{ refreshed: number; failed: number }> {
  const from = opts.from ?? 'CN';
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxCjCalls = opts.maxCjCalls ?? destinations.length + 5;
  const allowInMarket = opts.allowInMarket ?? false;
  const quoteFn = opts.quote ?? cj.freightQuote.bind(cj);
  const synced = await reference.logisticsSyncedFor(from);
  const ordered = [...destinations].sort((a, b) => (synced.get(a) ?? '').localeCompare(synced.get(b) ?? ''));
  let refreshed = 0, failed = 0, cjCalls = 0, consecutive429 = 0;
  for (const dest of ordered) {
    if ((dest === from && !allowInMarket) || cjCalls >= maxCjCalls) continue;
    await pause(CJ_CALL_GAP_MS);
    cjCalls++;
    try {
      const options = await quoteFn(repVid, from, dest, 1);
      const cheapest = options[0];
      const range = parseDaysRange(cheapest?.days);
      if (cheapest && range) {
        for (const s of cjStores) {
          await s.upsertLogisticsRoute({ from, to: dest, channel: cheapest.name, transitMin: range.min, transitMax: range.max, agingRaw: cheapest.days, repVid, freightCostUsd: cheapest.priceUsd });
        }
        refreshed++; consecutive429 = 0;
      } else {
        const why = cheapest ? `unparseable aging: ${cheapest.days}` : 'no freight options';
        for (const s of cjStores) await s.bumpLogisticsFailure(from, dest, why);
        failed++; consecutive429 = 0;
      }
    } catch (e) {
      const msg = (e as Error).message;
      for (const s of cjStores) await s.bumpLogisticsFailure(from, dest, msg);
      failed++;
      if (/\b429\b|1600200|rate limit/i.test(msg)) {
        if (++consecutive429 >= 3) { console.warn('logistics sync: aborting after 3 consecutive 429s (last-good rows cover it)'); break; }
      } else consecutive429 = 0;
    }
  }
  for (const s of cjStores) await s.pruneLogisticsRoutes(from, destinations);
  console.log(`logistics: ${refreshed} refreshed, ${failed} failed across ${cjStores.length} shop(s)`);
  return { refreshed, failed };
}

/**
 * Pick a REPRESENTATIVE in-stock variant id for the freight probe (env override
 * wins). A single arbitrary vid is unsafe: a bulky product routes via CJ's
 * oversized channels (e.g. "Sensitive Over Length", ~10-18d) which overstate the
 * typical small pet item (~4-9d). So sample several candidates, quote each CN->GB,
 * and pick the MEDIAN transit - robust to both bulky and unusually-fast outliers.
 */
async function findRepresentativeVid(store: TenantStore, cj: Pick<CjClient, 'freightQuote'>, envOverride?: string): Promise<string> {
  const ov = envOverride?.trim();
  if (ov) return ov;
  const candidates: string[] = [];
  for (const detailJson of await store.sampleWarehouseDetails(8)) {
    try {
      const d = JSON.parse(detailJson) as CjDetail;
      const v = (d.variants ?? []).find((x) => x.vid && x.vid !== 'default');
      if (v) candidates.push(v.vid);
    } catch { /* skip a malformed row */ }
  }
  if (!candidates.length) return '';
  const scored: { vid: string; tmax: number }[] = [];
  for (const vid of candidates) {
    try {
      const opts = await cj.freightQuote(vid, 'CN', 'GB', 1);
      const range = parseDaysRange(opts[0]?.days);
      if (range) scored.push({ vid, tmax: range.max });
    } catch { /* skip a vid that won't quote */ }
    await new Promise((r) => setTimeout(r, CJ_CALL_GAP_MS));
  }
  if (!scored.length) return candidates[0];
  scored.sort((a, b) => a.tmax - b.tmax);
  return scored[Math.floor((scored.length - 1) / 2)].vid; // lower-median: representative, not the bulky tail
}

/**
 * Pick a representative in-stock variant id for a specific non-CN origin.
 * Samples warehouse products stocked in `origin`, probes CJ with an in-market
 * quote (origin -> origin) via freightQuoteAging (which retains price-0 domestic
 * options), and returns the lower-median vid by transit max. Falls back to the
 * first candidate; returns '' if no stocked variants exist.
 */
async function findRepresentativeVidForOrigin(
  reference: TenantStore,
  cj: Pick<CjClient, 'freightQuoteAging'>,
  origin: string
): Promise<string> {
  const candidates: string[] = [];
  for (const detailJson of await reference.sampleWarehouseDetailsForOrigin(origin, 8)) {
    try {
      const d = JSON.parse(detailJson) as CjDetail;
      const v = (d.variants ?? []).find((x) => x.vid && x.vid !== 'default');
      if (v) candidates.push(v.vid);
    } catch { /* skip a malformed row */ }
  }
  if (!candidates.length) return '';
  const scored: { vid: string; tmax: number }[] = [];
  for (const vid of candidates) {
    try {
      const opts = await cj.freightQuoteAging(vid, origin, origin, 1);
      const range = parseDaysRange(opts[0]?.days);
      if (range) scored.push({ vid, tmax: range.max });
    } catch { /* skip a vid that won't quote */ }
    await new Promise((r) => setTimeout(r, CJ_CALL_GAP_MS));
  }
  if (!scored.length) return candidates[0];
  scored.sort((a, b) => a.tmax - b.tmax);
  return scored[Math.floor((scored.length - 1) / 2)].vid; // lower-median
}

/**
 * Env wrapper: build a reference CjClient + representative vid, then refresh the
 * matrix and fan it out to every CJ shop. Called ONCE at the top of the daily cron
 * (idle relay window), before any per-shop work - so the matrix is fresh before any
 * shop's PDP metafield write. Best-effort: never throws.
 *
 * In addition to the CN origin sync, discovers any non-CN origins in the catalog
 * (currently US when US-warehoused products exist) and syncs those routes too,
 * including the in-market route (e.g. US->US). Only real parseable CJ quotes
 * become rows; missing routes fall back to the CN estimate hedge.
 */
export async function syncCjLogistics(
  env: Env,
  opts: { maxCjCalls?: number; pause?: (ms: number) => Promise<void> } = {}
): Promise<{ refreshed: number; failed: number }> {
  const shops = await listActiveShops(env.DB);
  if (!shops.length) return { refreshed: 0, failed: 0 };
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  const f = cjFetchFromEnv(env);
  const cjStores: TenantStore[] = [];
  let reference: TenantStore | null = null;
  let cj: CjClient | null = null;
  let repVid = '';
  for (const shop of shops) {
    const store = new TenantStore(env.DB, shop);
    if (!(await store.getSupplierCredential('cj'))) continue;
    cjStores.push(store);
    if (!reference) {
      reference = store;
      cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
      repVid = await findRepresentativeVid(store, cj, env.INBOX_FREIGHT_REP_VID);
    }
  }
  if (!reference || !cj) { console.warn('logistics sync: no shop with CJ credentials; skipping'); return { refreshed: 0, failed: 0 }; }
  if (!repVid) { console.warn('logistics sync: no representative in-stock vid; skipping'); return { refreshed: 0, failed: 0 }; }
  const cnResult = await syncCjLogisticsRoutes(cjStores, reference, cj, repVid, LOGISTICS_DESTINATIONS, opts);
  let refreshed = cnResult.refreshed;
  let failed = cnResult.failed;
  // Sync non-CN origins present in the catalog (e.g. US-warehoused products).
  for (const origin of await reference.catalogNonCnOrigins()) {
    const ov = await findRepresentativeVidForOrigin(reference, cj, origin);
    if (!ov) { console.warn(`logistics sync: no rep vid for origin ${origin}; skipping`); continue; }
    // Include the in-market dest (origin->origin) so US customers get the fast estimate.
    const dests = [...new Set([origin, ...LOGISTICS_DESTINATIONS])];
    const r = await syncCjLogisticsRoutes(cjStores, reference, cj, ov, dests, {
      from: origin,
      allowInMarket: true,
      quote: cj.freightQuoteAging.bind(cj),
      maxCjCalls: opts.maxCjCalls,
      pause: opts.pause,
    });
    refreshed += r.refreshed;
    failed += r.failed;
  }
  return { refreshed, failed };
}

/**
 * Cron half of the semantic term library's hybrid population. Precomputes the
 * per-collection sourcing cores (each collection noun under its own collection)
 * AND the collection-agnostic ('') search vocabulary (same nouns), so on-site
 * search [[Task 7]] and CJ sourcing [[Task 6]] read warm cache; the long tail
 * lazy-fills on demand. Bounded by `maxTerms`/run; refreshes only rows older
 * than `semantic.ttlDays`; excluded collections (and the disabled flag) are
 * honoured. Never throws - `seedTerm` swallows its own network/LLM failures.
 */
export async function seedSemanticLibrary(
  store: TenantStore,
  llm: LlmClient,
  cfg: TenantConfig,
  opts: { maxTerms?: number; now?: () => number; fetchImpl?: typeof fetch } = {}
): Promise<{ seeded: number; skipped: number }> {
  const sem = cfg.semantic ?? DEFAULT_SEMANTIC;
  if (!sem.enabled) return { seeded: 0, skipped: 0 };
  const maxTerms = opts.maxTerms ?? 12;
  const now = opts.now ?? Date.now;
  const ttlMs = sem.ttlDays * 86400_000;

  // Each non-excluded collection noun seeds BOTH its own collection (sourcing
  // core) and '' (agnostic search vocabulary). '' is never excluded.
  const jobs: { term: string; collection: string }[] = [];
  for (const key of Object.keys(cfg.collectionMap)) {
    if (sem.excludeCollections.includes(key)) continue;
    const noun = key.replace(/-/g, ' ');
    jobs.push({ term: noun, collection: key }, { term: noun, collection: '' });
  }

  let seeded = 0;
  let skipped = 0;
  for (const job of jobs) {
    if (seeded >= maxTerms) { skipped++; continue; }
    const existing = await store.getSemanticExpansions(job.collection, job.term);
    if (existing && now() - new Date(existing.updatedAt).getTime() < ttlMs) { skipped++; continue; } // still fresh
    await seedTerm(store, llm, cfg, job.term, job.collection, 'cron', opts.fetchImpl);
    seeded++;
  }
  if (skipped) console.log(`semantic seeding: ${seeded} seeded, ${skipped} skipped (cap ${maxTerms})`);
  return { seeded, skipped };
}

/** Per-collection GB sourcing keywords (mirrors discover-cj-category-products.py).
 *  Broadened 2026-07-03 (free-UK-delivery initiative step D): the 2026-06-24 seed
 *  exhausted the original 17-keyword set at ~29 drafts; wider coverage of the
 *  ~300-strong GB pet pool needs more search angles, not re-runs. The discovery
 *  gate + LLM curation still filter every candidate. */
export const SEED_KEYWORDS: Record<string, string[]> = {
  'pet-cleaning': ['pet cleaning wipes', 'paw cleaner', 'pet bath towel', 'dog shampoo', 'pet stain remover', 'litter scoop', 'pet hair remover', 'dog poop bags'],
  'pet-grooming': ['dog grooming brush', 'pet nail clipper', 'dog comb', 'deshedding tool', 'pet grooming glove', 'dog hair clipper', 'cat brush', 'dog nail grinder'],
  'pet-health': ['dog dental', 'dog supplement', 'pet probiotic', 'dog toothpaste', 'joint supplement dog', 'calming dog', 'flea comb', 'pet first aid'],
  'pet-toys': ['dog chew toy', 'cat toy', 'pet puzzle toy', 'interactive dog toy', 'cat tunnel', 'catnip toy', 'squeaky dog toy', 'cat scratcher', 'dog rope toy'],
  'pet-accessories': ['dog collar', 'dog harness', 'pet bowl', 'cat litter', 'pet carrier', 'dog bed', 'cat bed', 'dog lead', 'pet water fountain', 'dog coat', 'cat litter box', 'pet blanket', 'dog crate', 'pet feeder']
};

/**
 * One-off origin seed: discover products CJ warehouses in `countryCode`, cache
 * each (with its per-country origins) into warehouse_products, and DRAFT-import
 * it (status DRAFT, unpublished) for owner review. Reuses confirmAndImport's
 * full gate chain (curation/pet-floor/image-QA/stock); the only difference from
 * the cron is publish:false. Idempotent: skips pids already linked.
 */
export async function seedOriginAssortment(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  opts: {
    countryCode?: string;
    perCollection?: number;
    maxDrafts?: number;
    curate?: (detail: CjDetail, context: string) => Promise<Curation | null>;
    pickHero?: (title: string, imageUrls: string[]) => Promise<HeroPick>;
    competitorCheck?: (detail: CjDetail, ourRetailGbp: number) => Promise<CompetitorSignal | null>;
    pause?: (ms: number) => Promise<void>;
    keywords?: Record<string, string[]>;
    /** Lane-specific discovery gates (e.g. the US lane's bulky-niche price
     *  band); defaults to the tenant's global gates. */
    gates?: Gates;
  } = {}
): Promise<{ discovered: number; drafted: number; rejected: number }> {
  const cc = opts.countryCode ?? 'GB';
  const cap = opts.perCollection ?? 12;
  const maxDrafts = opts.maxDrafts ?? Infinity; // nightly lanes pace themselves
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const keywords = opts.keywords ?? SEED_KEYWORDS;
  const gates = opts.gates ?? cfg.gates;
  // Local-for-local: the seed lane's gate is the TARGET market's warehouses,
  // and non-home seeds carry a market tag (e.g. market-us) so the owner can
  // filter drafts in admin and the visibility phase can scope publishing.
  const laneWarehouses = localWarehousesFor(cc);
  const marketTag = cc === 'GB' ? undefined : `market-${cc.toLowerCase()}`;
  const seenTitleSigs = new Set((await store.warehouseTitles()).map(titleSignature));
  const seenPids = new Set<string>();
  let discovered = 0, drafted = 0, rejected = 0;

  for (const [category, kws] of Object.entries(keywords)) {
    let perCat = 0;
    for (const kw of kws) {
      if (perCat >= cap || drafted >= maxDrafts) break;
      // Apply the same discovery gate the storefront feed + replenishWarehouse use
      // (price band + popularity + species + keyword relevance). /product/list is a
      // loose keyword endpoint, so without this an off-target or out-of-band product
      // (e.g. a $110 stroller above priceMax, or a car-seat-cover under a grooming
      // keyword) would be drafted into the wrong collection. The LLM curation gate
      // downstream still applies on top of this.
      const items = (await cj.searchByWarehouse(normalizeKeyword(kw), cc))
        .filter((i) => liveCjPasses(i, gates, normalizeKeyword(kw)));
      await pause(CJ_CALL_GAP_MS);
      for (const item of items) {
        if (perCat >= cap || drafted >= maxDrafts) break;
        if (seenPids.has(item.pid)) continue;
        seenPids.add(item.pid);
        const link = await store.getLink(item.pid);
        if (link && (link.state === 'imported' || link.state === 'importing' || link.state === 'draft')) continue;
        discovered++;
        const detail = await getCachedDetail(store, cj, item.pid);
        await pause(CJ_CALL_GAP_MS);
        if (!detail) { rejected++; continue; }
        const sig = titleSignature(detail.nameEn);
        if (seenTitleSigs.has(sig)) { rejected++; continue; }
        const enriched = await confirmAndImport(store, cj, admin, cfg, detail, category, opts.curate, opts.pickHero, {
          publish: false, localWarehouses: laneWarehouses, competitorCheck: opts.competitorCheck, ...(marketTag ? { marketTag } : {})
        });
        await pause(CJ_CALL_GAP_MS);
        if ((await store.getLink(detail.pid))?.state === 'draft') {
          // Cache the gate-ENRICHED detail (curated copy, per-country origins,
          // freightUsd - the exact numbers the gates judged) only for candidates
          // that passed the full gate chain - rejected candidates must not pollute
          // warehouse_products (those rows feed searchBackfill ghost cards).
          // Caching freight here keeps the nightly cost sync freight-aware for
          // this product from day one (the freight-blind audit gap, 2026-07-10).
          const cached = enriched ?? detail;
          await store.putWarehouseProduct({
            cjPid: detail.pid,
            category,
            title: cached.nameEn,
            detailJson: JSON.stringify(cached),
            priceUsd: cached.variants[0]?.sellPriceUsd ?? 0,
            listedNum: cached.listedNum,
            stock: cached.stock ?? 0
          });
          drafted++; perCat++; seenTitleSigs.add(sig);
        } else {
          rejected++; // confirmAndImport's gate chain rejected it (link ends 'failed')
        }
      }
    }
  }
  return { discovered, drafted, rejected };
}

const PRODUCT_STATUS_QUERY = `query pawscoutProductStatus($id: ID!) { product(id: $id) { status } }`;

/**
 * Flip seed drafts to 'imported' once the owner has published them (Shopify
 * status ACTIVE). Runs daily; cheap (one status query per outstanding draft).
 */
export async function reconcileDraftLinks(store: TenantStore, admin: AdminGraphql): Promise<number> {
  let flipped = 0;
  for (const link of await store.linksByState('draft')) {
    if (!link.shopify_product_id) continue;
    try {
      const data = (await admin(PRODUCT_STATUS_QUERY, { id: link.shopify_product_id })) as { product?: { status?: string } };
      if (data.product?.status === 'ACTIVE') {
        await store.putLink({ cjPid: link.cj_pid, state: 'imported' });
        flipped++;
      }
    } catch (e) {
      console.warn(`draft reconcile failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return flipped;
}

/** One market-visibility reconcile for one shop: sync every market's catalog
 * publication to the local-for-local rule and stamp the Glance payload.
 * Best-effort: a failure is logged and never blocks the caller. */
async function reconcileMarketVisibility(admin: AdminGraphql, store: TenantStore, cfg: TenantConfig): Promise<void> {
  try {
    const l = resolveLogistics(cfg.fulfil);
    const mx = await syncMarketExclusions(admin, store, { stalenessHours: l.stalenessHours });
    const changed = mx.markets.filter((m) => m.removed || m.readded);
    if (changed.length) console.log(`market visibility reconcile: ${changed.map((m) => `${m.name} -${m.removed}/+${m.readded} (excl ${m.excluded})`).join(', ')}`);
    await store.putSearchCache(
      JOB_STAMP_MARKETS,
      JSON.stringify({ at: new Date().toISOString(), markets: mx.markets.map((m) => ({ name: m.name, excluded: m.excluded })) }),
      JOB_STAMP_TTL_DAYS
    );
  } catch (e) { console.warn(`market visibility sync skipped: ${(e as Error).message}`); }
}

/** 15-min cron lane for market visibility. The nightly run also reconciles, but
 * publishing happens at owner speed: the moment a market-us draft goes ACTIVE,
 * autoPublish drops it into EVERY market's catalog, and only this sweep takes it
 * back out of the UK/EU/AU within minutes instead of at 04:17. Converged runs
 * issue no mutations, so the steady-state cost is a handful of reads. */
export async function runMarketVisibilityReconcile(env: Env): Promise<void> {
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  for (const shop of await listActiveShops(env.DB)) {
    try {
      const store = new TenantStore(env.DB, shop);
      const tenant = await store.getTenant();
      const cfg = await store.getConfig();
      if (!tenant?.access_token_enc || !cfg) continue;
      const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
      const admin = makeAdminGraphql(shop, accessToken);
      await reconcileMarketVisibility(admin, store, cfg);
    } catch (e) { console.warn(`market visibility reconcile failed for ${shop}: ${(e as Error).message}`); }
  }
}

/** Checkpoint key for the profit agent's rolling catalog cursor (per shop). */
export const PROFIT_AGENT_OFFSET_KEY = 'job:profit-agent-offset';
// Opaque Shopify products cursor for the full-catalog image/title reconcile
// (catalog-images stage). Unlike the numeric stage offset, this is a GraphQL
// cursor persisted across ticks; cleared to null when a full pass completes.
export const CATALOG_IMAGE_CURSOR_KEY = 'job:catalog-images-cursor';

/**
 * 15-min cron lane for the ACTIVE profitability agent. Rolling batches of 8 across
 * the day so the whole catalog is re-evaluated CONTINUOUSLY (not a nightly pass):
 * read each shop's saved offset, run one batch, advance the cursor, wrap to 0 at the
 * end of the catalog. Fully DORMANT unless cfg.profit.enabled - a disabled shop
 * costs one config read and never builds an admin client or spends a token. In
 * dry-run the agent records what it WOULD do; only live mode touches prices/listings.
 */
export async function runProfitAgentSweep(env: Env, nowMs: number = Date.now()): Promise<void> {
  // Hourly cadence (owner decision 2026-07-18, was every 15 min): the ride
  // stays on the quarter-hour cron but only the top-of-hour tick proceeds.
  // The competitor signal is cached 14 days and reprices are dead-banded, so
  // sub-hourly passes only ever re-derived the same answer.
  if (new Date(nowMs).getUTCMinutes() >= 15) return;
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY });
  for (const shop of await listActiveShops(env.DB)) {
    try {
      const store = new TenantStore(env.DB, shop);
      const tenant = await store.getTenant();
      const cfg = await store.getConfig();
      if (!tenant?.access_token_enc || !cfg?.profit?.enabled) continue; // dormant: no admin, no spend
      const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
      const admin = makeAdminGraphql(shop, accessToken);
      const saved = Number(await readJobCheckpoint(env.DB, shop, PROFIT_AGENT_OFFSET_KEY));
      const offset = Number.isFinite(saved) && saved > 0 ? saved : 0;
      const r = await runProfitAgent(store, admin, llm, cfg, { offset, limit: 8, market: ebayFromEnv(env) });
      // Advance the rolling cursor; r.next is null at the catalog end -> wrap to 0.
      await writeJobCheckpoint(env.DB, shop, PROFIT_AGENT_OFFSET_KEY, String(r.next ?? 0), JOB_STAMP_TTL_DAYS * 86400_000);
      if (r.acted) console.log(`profit agent (${r.dryRun ? 'dry-run' : 'live'}) ${shop}: ${r.repriced} repriced, ${r.dropped} dropped, ${r.flagged} flagged of ${r.scanned}`);
    } catch (e) { console.warn(`profit agent sweep failed for ${shop}: ${(e as Error).message}`); }
  }
}

// ---------------------------------------------------------------------------
// Resumable daily maintenance - stage-cursor continuation.
//
// A Cloudflare cron invocation gets ~15 minutes of wall clock; the full nightly
// outgrew it (proven live 2026-07-05: the run died at 04:32 mid-seeding, and
// everything sequenced after the seed lanes silently never ran - the completion
// stamp had NEVER been written). The nightly is therefore a CHAIN of named,
// individually re-runnable stages driven by a persisted cursor: the 04:17 cron
// seeds the cursor and drives as many stages as fit before the next
// quarter-hour, and every 15-min tick resumes the chain until it completes.
// JOB_STAMP_DAILY is stamped per shop only when that shop's LAST stage
// finishes, so Glance's dailyLastRunAt now means "the whole nightly ran".
//
// Guarantees:
//  - at-least-once per stage: a killed invocation leaves the cursor ON the
//    stage it was running; the next tick re-runs it. Every stage is nightly-
//    idempotent by construction (re-running refreshes, never duplicates).
//  - mutual exclusion: a lease (stage maxMs + slack) is taken before each
//    stage, so an overshooting invocation and the next tick never drive the
//    same stage concurrently.
//  - bounded invocations: a stage is only STARTED when its declared maxMs fits
//    before the quarter-hour deadline (90s safety margin); the catalog-walking
//    sweeps additionally checkpoint their offset mid-stage.
//  - stage failures warn and advance (best-effort, the same philosophy as the
//    old inline try/catches) - one broken stage no longer kills the night.

const MIN_MS = 60_000;
const QUARTER_MS = 15 * MIN_MS;
const DAILY_CURSOR_SHOP = '__jobs__'; // sentinel row in search_cache (not a real tenant)
export const DAILY_CURSOR_KEY = 'job:daily-cursor';

export interface DailyCursor {
  date: string;          // YYYY-MM-DD the chain belongs to
  shops: string[];       // frozen at chain start so mid-day tenant changes cannot shift indices
  g: number;             // next global stage index
  si: number;            // current shop index
  ss: number;            // next shop-stage index
  ssName: string | null; // stage name at ss (re-resolves the index if a deploy reshapes the list)
  off: number | null;    // mid-stage offset for the catalog-walking sweeps
  leaseUntil: number;    // epoch ms; a live lease means another invocation is mid-stage
}

export async function readDailyCursor(db: D1Database): Promise<DailyCursor | null> {
  const payload = await readJobCheckpoint(db, DAILY_CURSOR_SHOP, DAILY_CURSOR_KEY);
  if (!payload) return null;
  try { return JSON.parse(payload) as DailyCursor; } catch { return null; }
}

/** Exported for tests. expires_at is 2 days out: an abandoned cursor self-purges. */
export async function writeDailyCursor(db: D1Database, cur: DailyCursor | null): Promise<void> {
  await writeJobCheckpoint(db, DAILY_CURSOR_SHOP, DAILY_CURSOR_KEY, cur ? JSON.stringify(cur) : null, 2 * 86400_000);
}

/** Stages only start when they fit before the next quarter-hour boundary (90s
 * safety), so a driver never runs into the next tick's invocation. Invoked too
 * close to a boundary, it uses the following window instead. */
export function chainDeadline(now: number): number {
  let d = Math.ceil((now + 1) / QUARTER_MS) * QUARTER_MS - 90_000;
  if (d <= now + 30_000) d += QUARTER_MS;
  return d;
}

export interface DailyShopCtx {
  env: Env;
  shop: string;
  store: TenantStore;
  admin: AdminGraphql;
  cfg: TenantConfig;
  cj: CjClient | null; // null when the shop has no CJ credential
  llm: LlmClient;
  curate?: (detail: CjDetail, context: string) => ReturnType<typeof curateProduct>;
  pickHero?: (title: string, urls: string[], opts?: { maxImages?: number }) => ReturnType<typeof pickHeroImage>;
  /** Entry competition check for the import gate (confirmAndImport); only
   *  consulted when profit.competitionCheckOnImport is on. Cached per pid. */
  competitorCheck?: (detail: CjDetail, ourRetailGbp: number) => Promise<CompetitorSignal | null>;
}

export interface DailyGlobalStage {
  name: string;
  maxMs: number;
  run(env: Env, deadline: number): Promise<void>;
}

export interface DailyStage {
  name: string;
  maxMs: number;
  /** Default true: skipped for shops without a CJ credential (only cull runs, as before). */
  needsCj?: boolean;
  /** Return a number to checkpoint a mid-stage offset (deadline reached); return
   * nothing when the stage is complete. */
  run(ctx: DailyShopCtx, offset: number, deadline: number): Promise<number | void>;
}

export const DAILY_GLOBAL_STAGES: DailyGlobalStage[] = [
  {
    name: 'purge', maxMs: 2 * MIN_MS,
    async run(env) {
      await purgeExpiredSearchCache(env.DB);
      await purgeUnusedWarehouse(env.DB, new Date(Date.now() - 30 * 86400_000).toISOString());
      await trimOldLogs(env.DB, new Date(Date.now() - LOG_RETENTION_DAYS * 86400_000).toISOString());
    }
  },
  // Refresh the CJ delivery-time matrix ONCE (fetch-once-fan-out) before any
  // per-shop work, so it's fresh before any PDP metafield write.
  { name: 'cj-logistics', maxMs: 10 * MIN_MS, run: async (env) => { await syncCjLogistics(env); } },
];

export const DAILY_SHOP_STAGES: DailyStage[] = [
  // MUST precede 'cull'. The cull is the only automated takedown left, and it
  // refuses to archive anything unless this stage has just proven the referrer
  // index is complete. Running it after the cull would mean every night's cull
  // reads yesterday's index - or on the first night, no index at all.
  { name: 'referrer-index', maxMs: 3 * MIN_MS, needsCj: false, run: async (ctx) => { await rebuildReferrerIndex(ctx.store, ctx.admin); } },
  // Deps are wired HERE and nowhere else: this is the only caller that holds an
  // env, a config and an LLM, so it is the only one that can repair a guide
  // rather than merely refuse. The owner console still refuses (see the
  // no-deps branch in archiveProductGuarded).
  { name: 'cull', maxMs: 3 * MIN_MS, needsCj: false, run: (ctx) => cullStaleProducts(ctx.store, ctx.admin, Date.now, buildGuardDeps(ctx.env, ctx.store, ctx.cfg, ctx.admin, ctx.llm)).then(() => undefined) },
  { name: 'warehouse-stock', maxMs: 10 * MIN_MS, run: async (ctx) => { await refreshWarehouseStock(ctx.store, ctx.cj!, ctx.cfg); } },
  { name: 'replenish', maxMs: 8 * MIN_MS, run: async (ctx) => { await replenishWarehouse(ctx.store, ctx.cj!, ctx.cfg, { curate: ctx.curate }); } },
  // Warm the term-library cores (hybrid cron half).
  { name: 'semantic-library', maxMs: 3 * MIN_MS, run: async (ctx) => { await seedSemanticLibrary(ctx.store, ctx.llm, ctx.cfg); } },
  // Ensure the affiliate-eligible smart collection exists before the inventory
  // sync toggles per-product tags into it.
  { name: 'affiliate-collection', maxMs: 2 * MIN_MS, run: async (ctx) => { await ensureAffiliateCollection(ctx.admin); } },
  // Origin-signature backfill BEFORE the inventory sync + profile syncs, so a
  // backfilled product is repriced (freight-baked sticker) and adopted into its
  // engineered shipping profile in the SAME nightly chain.
  { name: 'origin-backfill', maxMs: 8 * MIN_MS, run: async (ctx) => { await backfillOriginSignatures(ctx.store, ctx.cj!, ctx.cfg); } },
  // Freight backfill BEFORE the inventory sync: a warehouse row that gains its
  // freightUsd tonight gets its honest (freight-inclusive) landed cost written in
  // the SAME chain, and the 15-min profit agent re-judges on real numbers.
  { name: 'warehouse-freight', maxMs: 6 * MIN_MS, run: async (ctx) => { await backfillWarehouseFreight(ctx.store, ctx.cj!, ctx.cfg); } },
  // Market fill lanes: paced nightly discovery of each target market's
  // local-warehouse stock, drafted (never published) for owner review. One
  // stage per lane so the budget check runs between lanes.
  ...MARKET_SEED_LANES.map((lane): DailyStage => ({
    name: `seed-${lane.countryCode.toLowerCase()}`, maxMs: 9 * MIN_MS,
    async run(ctx) {
      const r = await seedOriginAssortment(ctx.store, ctx.cj!, ctx.admin, ctx.cfg, {
        countryCode: lane.countryCode, maxDrafts: lane.maxDraftsPerNight, curate: ctx.curate, pickHero: ctx.pickHero, competitorCheck: ctx.competitorCheck,
        ...(lane.keywords ? { keywords: lane.keywords } : {}),
        ...(lane.gateOverrides ? { gates: { ...ctx.cfg.gates, ...lane.gateOverrides } } : {})
      });
      if (r.drafted || r.discovered) console.log(`market seed ${lane.countryCode}: +${r.drafted} drafts (${r.discovered} discovered, ${r.rejected} rejected)`);
    }
  })),
  { name: 'store-inventory', maxMs: 10 * MIN_MS, run: async (ctx) => { await syncStoreInventory(ctx.store, ctx.cj!, ctx.admin, ctx.cfg); } },
  // NOTE: the profitability agent is NOT a nightly stage. It runs CONTINUOUSLY on
  // the 15-min cron (runProfitAgentSweep) so the catalog is re-evaluated through the
  // day, and it is the sole writer of product_profit (the old observe-first
  // profit-audit stage was retired 2026-07-09 - two writers clobbered one row).
  // Promote-from-warehouse (floor 8, target 12).
  { name: 'refill', maxMs: 8 * MIN_MS, run: async (ctx) => { await refillCollections(ctx.store, ctx.cj!, ctx.admin, ctx.cfg, { curate: ctx.curate, pickHero: ctx.pickHero, competitorCheck: ctx.competitorCheck }); } },
  // Flip ACTIVE seed drafts to imported.
  { name: 'draft-links', maxMs: 3 * MIN_MS, run: async (ctx) => { await reconcileDraftLinks(ctx.store, ctx.admin); } },
  // De-brand: strip manufacturer/supplier brands (e.g. PawHut) from any product
  // title or published article body that still carries one, so we never advertise
  // a competitor. Self-healing and idempotent - a cheap no-op once the catalog is
  // clean. See src/catalog-debrand.ts + src/debrand.ts.
  { name: 'debrand', maxMs: 3 * MIN_MS, needsCj: false, run: async (ctx) => { const r = await debrandCatalog(ctx.admin); if (r.errors.length) console.warn(`debrand: ${r.errors.join(' | ')}`); } },
  // Article health: published guides must never link a 404 product (the profit
  // agent archives stock continuously). Dead body links are relinked to live
  // congruent products (caged LLM, deterministic fallback) and stale shop-block
  // metafields refreshed. Idempotent no-op on a healthy catalog.
  // See src/blog/article-health.ts.
  { name: 'article-health', maxMs: 3 * MIN_MS, needsCj: false, run: async (ctx) => { const r = await runArticleHealth(ctx.env, ctx.store, ctx.cfg, ctx.admin); if (r.errors.length) console.warn(`article-health: ${r.errors.join(' | ')}`); } },
  // Fixed USD shelf prices on the US & Canada catalog (after all repricing
  // stages, so tonight's GBP stickers are what gets converted). Takes US
  // display pricing away from Global-e's padded conversion; see us-price-list.ts.
  { name: 'us-price-list', maxMs: 5 * MIN_MS, run: async (ctx) => {
    const r = await syncUsFixedPrices(ctx.admin, ctx.cfg);
    if (r.stamped || r.deleted) console.log(`us price list: ${r.stamped} stamped, ${r.deleted} deleted (${r.total} active variants)`);
  } },
  // Unified nearest-warehouse shipping: per-origin-signature delivery profiles
  // (free UK on GB items; per-route nearest-warehouse pricing elsewhere).
  {
    name: 'signature-profiles', maxMs: 4 * MIN_MS,
    async run(ctx) {
      const sc = resolveShipConfig(ctx.cfg.fulfil);
      const l = resolveLogistics(ctx.cfg.fulfil);
      const r = await syncSignatureProfiles(ctx.admin, ctx.store, { servedCountries: sc.servedCountries, fx: sc.fx, handlingGbp: sc.handlingGbp, stalenessHours: l.stalenessHours });
      const moved = r.profiles.filter((p) => p.added || p.removed);
      if (moved.length) console.log(`signature profiles reconcile: ${moved.map((p) => `${p.sig} +${p.added}/-${p.removed}`).join(', ')}`);
    }
  },
  // Per-market visibility (Task 12 + local-for-local); also runs on the 15-min cron.
  { name: 'market-visibility', maxMs: 4 * MIN_MS, run: (ctx) => reconcileMarketVisibility(ctx.admin, ctx.store, ctx.cfg) },
  // Align hidden/visible add-ons to the toggle.
  { name: 'addon-visibility', maxMs: 3 * MIN_MS, run: async (ctx) => { await reconcileAddonVisibility(ctx.store, ctx.admin, ctx.cfg); } },
  // Retention reorder reminders (1.3) - DORMANT unless explicitly enabled; even
  // then only emails marketing-SUBSCRIBED customers.
  {
    name: 'retention', maxMs: 3 * MIN_MS,
    async run(ctx) {
      if (ctx.env.RETENTION_REORDER_ENABLED === '1' || ctx.env.RETENTION_REORDER_ENABLED === 'true') {
        await sendReorderReminders(ctx.store, ctx.admin, ctx.cfg, ctx.env);
      }
    }
  },
  // Recurring events rotation (2026-07-06): keep every ENABLED catalogue event
  // scheduled in Shopify (this is what rolls an event to next year after it
  // ends) and stage the announcement campaign draft near each occurrence.
  {
    name: 'recurring-events', maxMs: 2 * MIN_MS, needsCj: false,
    async run(ctx) {
      const r = await rotateRecurringEvents(ctx.store, ctx.admin);
      if (r.ensured || r.staged || r.errors.length) {
        console.log(`recurring events for ${ctx.shop}: ensured ${r.ensured}, staged ${r.staged}${r.errors.length ? `, errors: ${r.errors.join(' | ')}` : ''}`);
      }
    }
  },
  // The catalog-walking sweeps checkpoint their offset against the deadline, so
  // a long walk spans ticks instead of blowing the window.
  {
    name: 'categories', maxMs: 4 * MIN_MS,
    async run(ctx, offset, deadline) {
      let off: number | null = offset;
      for (let i = 0; off !== null && i < 30; i++) {
        if (Date.now() >= deadline) return off;
        const r = await reconcileCategories(ctx.store, ctx.admin, ctx.cfg, { offset: off, limit: 25 });
        off = r.next;
      }
    }
  },
  {
    name: 'hero-images', maxMs: 5 * MIN_MS,
    async run(ctx, offset, deadline) {
      if (!ctx.pickHero) return;
      let off: number | null = offset;
      for (let i = 0; off !== null && i < 30; i++) {
        if (Date.now() >= deadline) return off;
        const r = await reconcileHeroImages(ctx.store, ctx.admin, ctx.cfg, ctx.pickHero, { offset: off, limit: 8 });
        off = r.next;
      }
    }
  },
  {
    // Full-catalog image/title reconcile: walks the ENTIRE live catalog by cursor
    // (not just product_links), clearing Google Merchant "promotional overlay" and
    // truncated-title issues across the bulk-imported products. Own string cursor
    // in a checkpoint (the numeric stage offset is unused); returns a number to
    // resume next tick, void when a full pass completes (then the cursor is cleared,
    // so the next night re-walks cheaply - all products sig-cached).
    name: 'catalog-images', maxMs: 8 * MIN_MS,
    async run(ctx, _offset, deadline) {
      if (!ctx.pickHero || !ctx.cfg.llm.enabled) return; // dormant without vision
      const pickHero = ctx.pickHero;
      const ttl = JOB_STAMP_TTL_DAYS * 86400_000;
      let cursor = (await readJobCheckpoint(ctx.env.DB, ctx.shop, CATALOG_IMAGE_CURSOR_KEY)) || null;
      for (let i = 0; i < 40; i++) {
        if (Date.now() >= deadline) {
          await writeJobCheckpoint(ctx.env.DB, ctx.shop, CATALOG_IMAGE_CURSOR_KEY, cursor, ttl);
          return 1; // more remains - resume next tick
        }
        const r = await reconcileCatalogImages(ctx.admin, ctx.cj, pickHero, { after: cursor });
        cursor = r.nextCursor;
        if (!cursor) { await writeJobCheckpoint(ctx.env.DB, ctx.shop, CATALOG_IMAGE_CURSOR_KEY, null, ttl); return; } // full pass done
      }
      await writeJobCheckpoint(ctx.env.DB, ctx.shop, CATALOG_IMAGE_CURSOR_KEY, cursor, ttl);
      return 1;
    }
  },
  {
    name: 'descriptions', maxMs: 5 * MIN_MS,
    async run(ctx, offset, deadline) {
      if (!ctx.llm.available || !ctx.cfg.llm.enabled) return;
      const rewrite = (title: string, raw: string) => rewriteDescription(ctx.llm, ctx.store, ctx.cfg, title, raw);
      let off: number | null = offset;
      for (let i = 0; off !== null && i < 30; i++) {
        if (Date.now() >= deadline) return off;
        const r = await reconcileDescriptions(ctx.store, ctx.admin, ctx.cfg, rewrite, { offset: off, limit: 8 });
        off = r.next;
      }
    }
  },
];

async function buildDailyShopCtx(env: Env, vault: Vault, shop: string): Promise<DailyShopCtx | null> {
  const store = new TenantStore(env.DB, shop);
  const tenant = await store.getTenant();
  const cfg = await store.getConfig();
  if (!tenant?.access_token_enc || !cfg) return null;
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  const admin = makeAdminGraphql(shop, accessToken);
  let cj: CjClient | null = null;
  if (await store.getSupplierCredential('cj')) {
    const f = cjFetchFromEnv(env);
    const tokens = new CjTokenManager(store, vault, f);
    cj = new CjClient(() => tokens.getToken(), f);
  }
  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY });
  const curate = llm.available && cfg.llm.enabled
    ? (detail: CjDetail, context: string) => curateProduct(llm, store, cfg, detail, context)
    : undefined;
  const pickHero = llm.available && cfg.llm.enabled
    ? (title: string, urls: string[], o?: { maxImages?: number }) => pickHeroImage(llm, store, cfg, title, urls, o)
    : undefined;
  const nightlyMarket = ebayFromEnv(env);
  const competitorCheck = llm.available && cfg.llm.enabled
    ? (detail: CjDetail, ourRetailGbp: number) => competitorSignal(llm, store, cfg, { pid: detail.pid, title: detail.nameEn, ourRetailGbp, market: nightlyMarket })
    : undefined;
  return { env, shop, store, admin, cfg, cj, llm, curate, pickHero, competitorCheck };
}

/** Test injection points; production callers pass nothing. */
export interface DailyDriveOpts {
  globalStages?: DailyGlobalStage[];
  shopStages?: DailyStage[];
  buildCtx?: (env: Env, vault: Vault, shop: string) => Promise<DailyShopCtx | null>;
  deadlineMs?: number;
}

/** Drive the persisted daily chain until it completes or the window closes. */
export async function driveDailyChain(env: Env, opts: DailyDriveOpts = {}): Promise<void> {
  const globalStages = opts.globalStages ?? DAILY_GLOBAL_STAGES;
  const shopStages = opts.shopStages ?? DAILY_SHOP_STAGES;
  const buildCtx = opts.buildCtx ?? buildDailyShopCtx;
  const deadline = opts.deadlineMs ?? chainDeadline(Date.now());

  const cur = await readDailyCursor(env.DB);
  if (!cur) return;
  if (cur.leaseUntil > Date.now()) return; // another invocation is mid-stage
  const persist = () => writeDailyCursor(env.DB, cur);

  while (cur.g < globalStages.length) {
    const stage = globalStages[cur.g];
    if (Date.now() + stage.maxMs > deadline) { await persist(); return; }
    cur.leaseUntil = Date.now() + stage.maxMs + 30_000;
    await persist();
    try { await stage.run(env, deadline); }
    catch (e) { console.warn(`daily global stage ${stage.name} failed: ${(e as Error).message}`); }
    cur.g++; cur.leaseUntil = 0;
    await persist();
  }

  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  while (cur.si < cur.shops.length) {
    const shop = cur.shops[cur.si];
    // Re-resolve the stage index by name if a deploy reshaped the list mid-day.
    if (cur.ssName && shopStages[cur.ss]?.name !== cur.ssName) {
      const byName = shopStages.findIndex((s) => s.name === cur.ssName);
      if (byName >= 0) cur.ss = byName;
    }
    let ctx: DailyShopCtx | null = null;
    try { ctx = await buildCtx(env, vault, shop); }
    catch (e) { console.warn(`daily maintenance skipped for ${shop}: ${(e as Error).message}`); }
    if (ctx) {
      while (cur.ss < shopStages.length) {
        const stage = shopStages[cur.ss];
        if ((stage.needsCj ?? true) && !ctx.cj) { cur.ss++; cur.ssName = null; cur.off = null; continue; }
        if (Date.now() + stage.maxMs > deadline) { await persist(); return; }
        cur.ssName = stage.name;
        cur.leaseUntil = Date.now() + stage.maxMs + 30_000;
        await persist();
        let paused: number | void;
        try { paused = await stage.run(ctx, cur.off ?? 0, deadline); }
        catch (e) { console.warn(`daily stage ${stage.name} failed for ${shop}: ${(e as Error).message}`); paused = undefined; }
        cur.leaseUntil = 0;
        if (typeof paused === 'number') { cur.off = paused; await persist(); return; }
        cur.ss++; cur.ssName = null; cur.off = null;
        await persist();
      }
      // Shop chain complete -> completion stamp (Glance dailyLastRunAt).
      try { await ctx.store.putSearchCache(JOB_STAMP_DAILY, new Date().toISOString(), JOB_STAMP_TTL_DAYS); } catch { /* stamp only */ }
    }
    cur.si++; cur.ss = 0; cur.ssName = null; cur.off = null;
    await persist();
  }
  await writeDailyCursor(env.DB, null);
  console.log(`daily maintenance chain complete (${cur.date}, ${cur.shops.length} shop(s))`);
}

/** Daily cron entry point: seeds the stage cursor for a fresh chain and drives
 * as many stages as fit this invocation; the 15-min cron resumes the rest. An
 * unfinished chain from yesterday is dropped (freshness beats completeness). */
export async function runDailyMaintenance(env: Env, opts: DailyDriveOpts = {}): Promise<void> {
  const prior = await readDailyCursor(env.DB);
  if (prior) console.warn(`daily chain ${prior.date} was incomplete (shop ${prior.si + 1}/${prior.shops.length}, stage ${prior.ssName ?? `g${prior.g}`}); starting fresh`);
  const shops = await listActiveShops(env.DB);
  await writeDailyCursor(env.DB, { date: new Date().toISOString().slice(0, 10), shops, g: 0, si: 0, ss: 0, ssName: null, off: null, leaseUntil: 0 });
  await driveDailyChain(env, opts);
}

/** 15-min cron hook: continue an in-flight daily chain, else no-op (one read). */
export async function resumeDailyMaintenance(env: Env, opts: DailyDriveOpts = {}): Promise<void> {
  if (!(await readDailyCursor(env.DB))) return;
  await driveDailyChain(env, opts);
}
