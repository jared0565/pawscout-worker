import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { chooseOrigin, looksLikeCjSku, type CjClient, type CjDetail } from '../cj';
import { retailPriceGbp } from '../pricing';
import { bestLocalQty, inquiryWarehouses } from '../local-markets';
import { getDetailPreferWarehouse, stripHtml } from '../proxy/import';
import { isPetProductStrict, titleAnswersQuery, queryTermHits } from '../proxy/search';
import { debrandTitle, debrandText, capTitle } from '../debrand';
import { laneRouteFor } from './lane-route';

const CJ_GAP_MS = 1100; // CJ allows about one request a second

/** One supplier item we could sell this buyer, with the figures the import would use. */
export interface SupplierOffer {
  pid: string;
  title: string;
  image: string;
  /** Lowest variant price under the import's own pricing rule (GBP). */
  priceGbp: number;
  /** Warehouse country it would ship from (internal only). */
  origin: string;
  overseas: boolean;
  /** Door-to-door band as the product page shows it, or null. */
  days: string | null;
  /** Supplier copy, stripped, at most 600 characters (grounding only, never pasted to a customer). */
  descriptionText: string;
  /** Set when the item is already in the catalog. */
  handle: string | null;
}

/**
 * Supplier items that answer `query` and can reach `dest` (owner rule
 * 2026-09-30: local stock when it exists, otherwise the real overseas facts).
 * A pasted SKU is looked up directly; anything else runs CJ's relevance search,
 * kept to pet products whose titles answer the query, closest first. Each
 * candidate needs live stock at or above the stock floor in the buyer's
 * inquiry warehouses and a fresh route to `dest`.
 */
export async function supplierOffers(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  query: string,
  dest: string,
  opts: { limit: number; pause?: (ms: number) => Promise<void> }
): Promise<SupplierOffer[]> {
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warehouses = inquiryWarehouses(dest);
  if (!warehouses.length) return [];

  const sku = looksLikeCjSku(query);
  const skuDetail = sku ? await cj.detailBySku(sku) : null;
  let pids: string[];
  if (sku) {
    pids = skuDetail ? [skuDetail.pid] : [];
  } else {
    const items = await cj.search(query, 40);
    pids = items
      .filter((i) => isPetProductStrict(i.nameEn) && titleAnswersQuery(query, i.nameEn, 'title'))
      .map((i) => ({ i, hits: queryTermHits(query, i.nameEn) }))
      .sort((a, b) => b.hits - a.hits || b.i.listedNum - a.i.listedNum)
      .map((r) => r.i.pid);
  }

  const offers: SupplierOffer[] = [];
  for (const pid of pids.slice(0, opts.limit * 3)) {
    if (offers.length >= opts.limit) break;
    await pause(CJ_GAP_MS);
    const detail: CjDetail | null = skuDetail?.pid === pid ? skuDetail : await getDetailPreferWarehouse(store, cj, pid);
    if (!detail) continue;
    // Owner rule: the ACTUAL information from CJ. The detail may come from the
    // warehouse row or the 30-day cache, so stock by warehouse is always read
    // live; an unreadable answer skips the item rather than trusting the cache.
    await pause(CJ_GAP_MS);
    const origins = await cj.originsByPid(pid).catch(() => null);
    if (!origins || bestLocalQty(origins, warehouses) < cfg.floors.stockFloor) continue;
    const route = await laneRouteFor(store, cfg, origins, dest);
    if (!route) continue;

    // The import's own pricing chain (confirmAndImport): origin by chooseOrigin,
    // freight quoted from that origin, retail from the variant's CJ price.
    const priced = { ...detail, origins };
    let freightUsd = priced.freightUsd;
    const vid = priced.variants[0]?.vid;
    if (freightUsd === undefined && vid && vid !== 'default') {
      await pause(CJ_GAP_MS);
      const origin = priced.origin ?? chooseOrigin(priced, cfg.floors.stockFloor);
      freightUsd = (await cj.freightEstimate(vid, origin).catch(() => null))?.priceUsd;
    }
    const prices = priced.variants.filter((v) => Number.isFinite(v.sellPriceUsd) && v.sellPriceUsd > 0)
      .map((v) => retailPriceGbp(v.sellPriceUsd, cfg.pricing, freightUsd));
    if (!prices.length) continue;

    const link = await store.getLink(pid);
    offers.push({
      pid,
      // The import's own title treatment; maker brands never reach a customer.
      title: capTitle(debrandTitle(detail.nameEn)),
      image: detail.images[0] ?? '',
      priceGbp: Math.min(...prices),
      origin: route.origin,
      overseas: route.overseas,
      days: route.days,
      descriptionText: debrandText(stripHtml(detail.descriptionHtml ?? '')).slice(0, 600),
      handle: link?.state === 'imported' ? link.handle : null,
    });
  }
  return offers;
}
