import { Vault } from './vault';
import { chooseOrigin, CjClient, CjTokenManager, cjFetchFromEnv, type CjSearchItem } from './cj';
import { makeAdminGraphql, type AdminGraphql } from './shopify-admin';
import { TenantStore, listActiveShops, purgeExpiredSearchCache, purgeUnusedWarehouse, trimOldLogs } from './tenant-store';
import { liveCjPasses, normalizeKeyword, CACHE_TTL_DAYS, isLikelyPetProduct, titleSignature } from './proxy/search';
import { getExpansions, seedTerm } from './semantic/library';
import { confirmAndImport, getCachedDetail, resolveCategory, reconcileAddonVisibility, reconcileHeroImages, reconcileDescriptions, reconcileCategories, setProductTags, ADDON_CATEGORY } from './proxy/import';
import { AFFILIATE_ELIGIBLE_TAG, productAffiliateEligible, ensureAffiliateCollection } from './affiliate';
import { sendReorderReminders } from './retention';
import { enableTracking, getPrimaryLocationId, productInventoryItems, setInventoryQuantities, setSupplierMetafields, updateVariantPrices, updateVariantCosts, MAX_TRACKED_QTY } from './proxy/inventory';
import { retailPriceGbp, landedCostGbp } from './pricing';
import { parseDaysRange, resolveLogistics, doorToDoorBand, formatBand, bandFromQuote } from './logistics';
import { LOGISTICS_DESTINATIONS } from './inbox/freight';
import type { CjDetail } from './cj';
import { LlmClient, curateProduct, pickHeroImage, rewriteDescription, type Curation, type HeroPick } from './llm';
import { DEFAULT_SEMANTIC, type Env, type TenantConfig } from './types';

export const CULL_WINDOW_DAYS = 30; // grace period AND inactivity window
const LOG_RETENTION_DAYS = 90;
const MAX_IMPORTS_PER_RUN = 30; // W2: promotions cost 1 CJ stock-check each - well within budget
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
  opts: { maxImports?: number; pause?: (ms: number) => Promise<void>; now?: () => number; curate?: (detail: CjDetail, context: string) => Promise<Curation | null>; pickHero?: (title: string, imageUrls: string[]) => Promise<HeroPick> } = {}
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
    await pause(CJ_CALL_GAP_MS); // confirmAndImport makes one CJ stock call
    await confirmAndImport(store, cj, admin, cfg, detail, category, opts.curate, opts.pickHero);
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
  opts: { maxProducts?: number; offset?: number; pause?: (ms: number) => Promise<void>; errors?: string[] } = {}
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
        try {
          for (const v of (JSON.parse(wh.detail) as CjDetail).variants) skuToVid.set(v.sku, v.vid);
        } catch { /* fall back to uniform stock */ }
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
            const qty = paused ? 0 : (vid !== undefined ? stockMap.get(vid) ?? maxStock : maxStock);
            return { inventoryItemId: v.inventoryItemId, quantity: Math.min(qty, MAX_TRACKED_QTY) };
          })
        );
      }

      // Price sync: retail must always equal the pricing rule applied to CJ's
      // CURRENT cost. Only variants whose SKU matches a CJ variant reprice;
      // unchanged prices are skipped to avoid pointless writes.
      const priceUpdates = variants.flatMap((v) => {
        const cost = skuToCost.get(v.sku);
        if (cost === undefined || cost <= 0) return [];
        const expected = retailPriceGbp(cost, cfg.pricing, freightUsd).toFixed(2);
        return expected === v.price ? [] : [{ id: v.variantId, price: expected }];
      });
      if (priceUpdates.length) await updateVariantPrices(admin, link.shopify_product_id, priceUpdates);

      // Cost-per-item sync: write the honest landed GBP COGS (raw FX, product +
      // freight) so Shopify margin analytics and the affiliate £6 floor read a
      // current figure. Admin-only field; only changed costs are written.
      const costUpdates = variants.flatMap((v) => {
        const cost = skuToCost.get(v.sku);
        if (cost === undefined || cost <= 0) return [];
        const landed = landedCostGbp(cost, cfg.pricing, freightUsd).toFixed(2);
        const current = v.cost === '' ? '' : Number(v.cost).toFixed(2);
        return current === landed ? [] : [{ inventoryItemId: v.inventoryItemId, cost: landed }];
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
        await setSupplierMetafields(admin, link.shopify_product_id, {
          status: paused ? 'out_of_stock' : maxStock < cfg.floors.stockFloor * 2 ? 'low_stock' : 'available',
          qty: maxStock,
          checkedAt: new Date().toISOString(),
          origin,
          deliveryDays,
          deliveryDaysActual
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
    // Shares the kw2: live-CJ cache namespace with proxy/search.ts (bumped from
    // kw: when topCategory was added) so sourcing and the storefront feed reuse
    // the same category-bearing CJ results instead of double-fetching a
    // rate-limited supplier. Sourcing ignores topCategory; the storefront gate
    // reads it.
    const cached = await store.getSearchCache(`kw2:${kw}`);
    let items: CjSearchItem[];
    if (cached) {
      items = JSON.parse(cached);
    } else {
      if (cjCalls >= maxCjCalls) return [];
      await spend();
      items = await cj.search(kw);
      await store.putSearchCache(`kw2:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
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

    // W3: LLM curation - quality score + rewritten copy. A failed/absent LLM
    // degrades to mechanical gates; a low score is a hard reject.
    let title = detail.nameEn;
    let admittedDetail: CjDetail = { ...detail, stock };
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
          await s.upsertLogisticsRoute({ from, to: dest, channel: cheapest.name, transitMin: range.min, transitMax: range.max, agingRaw: cheapest.days, repVid });
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

/** Daily cron entry point: retention purges, then per-tenant cull + refill. */
export async function runDailyMaintenance(env: Env): Promise<void> {
  await purgeExpiredSearchCache(env.DB);
  await purgeUnusedWarehouse(env.DB, new Date(Date.now() - 30 * 86400_000).toISOString());
  await trimOldLogs(env.DB, new Date(Date.now() - LOG_RETENTION_DAYS * 86400_000).toISOString());

  // Refresh the CJ delivery-time matrix ONCE (fetch-once-fan-out), in the idle
  // relay window before any per-shop work - so it's fresh before any PDP metafield
  // write. Best-effort: a failure here must never block the rest of maintenance.
  try { await syncCjLogistics(env); } catch (e) { console.warn(`cj logistics sync failed: ${(e as Error).message}`); }

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
        const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY });
        const curate = llm.available && cfg.llm.enabled
          ? (detail: CjDetail, context: string) => curateProduct(llm, store, cfg, detail, context)
          : undefined;
        const pickHero = llm.available && cfg.llm.enabled
          ? (title: string, urls: string[]) => pickHeroImage(llm, store, cfg, title, urls)
          : undefined;
        await replenishWarehouse(store, cj, cfg, { curate });
        await seedSemanticLibrary(store, llm, cfg); // warm the term-library cores (hybrid cron half)
        // Ensure the affiliate-eligible smart collection exists before the
        // inventory sync toggles per-product tags into it (best-effort).
        try { await ensureAffiliateCollection(admin); } catch (e) { console.warn(`affiliate collection ensure failed: ${(e as Error).message}`); }
        await syncStoreInventory(store, cj, admin, cfg);
        await refillCollections(store, cj, admin, cfg, { curate, pickHero }); // promote-from-warehouse (floor 8, target 12)
        await reconcileAddonVisibility(store, admin, cfg); // align hidden/visible add-ons to the toggle
        // Retention reorder reminders (1.3) - DORMANT unless explicitly enabled;
        // even then only emails marketing-SUBSCRIBED customers. Best-effort.
        if (env.RETENTION_REORDER_ENABLED === '1' || env.RETENTION_REORDER_ENABLED === 'true') {
          try { await sendReorderReminders(store, admin, cfg, env); }
          catch (e) { console.warn(`reorder reminders failed: ${(e as Error).message}`); }
        }
        for (let off: number | null = 0, i = 0; off !== null && i < 30; i++) {
          const r = await reconcileCategories(store, admin, cfg, { offset: off, limit: 25 }); // re-file unambiguous mis-categorised products
          off = r.next;
        }
        // Drain the batched vision/description sweeps over multiple iterations
        // (each batch finishes well inside the request budget; the loop walks
        // the whole catalog). Safety cap stops a runaway if `next` never clears.
        if (pickHero) {
          for (let off: number | null = 0, i = 0; off !== null && i < 30; i++) {
            const r = await reconcileHeroImages(store, admin, cfg, pickHero, { offset: off, limit: 8 });
            off = r.next;
          }
        }
        if (llm.available && cfg.llm.enabled) {
          const rewrite = (title: string, raw: string) => rewriteDescription(llm, store, cfg, title, raw);
          for (let off: number | null = 0, i = 0; off !== null && i < 30; i++) {
            const r = await reconcileDescriptions(store, admin, cfg, rewrite, { offset: off, limit: 8 });
            off = r.next;
          }
        }
      }
    } catch (e) {
      console.warn(`daily maintenance failed for ${shop}: ${(e as Error).message}`);
    }
  }
}
