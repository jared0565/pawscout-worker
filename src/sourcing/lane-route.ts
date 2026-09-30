import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import type { CjClient, CjDetail } from '../cj';
import { allowedOriginsFor, inquiryWarehouses, localWarehousesFor } from '../local-markets';
import { resolveNearestRoute } from '../shipping/nearest-route';
import { resolveLogistics, doorToDoorBand, formatBand, type LogisticsRoute } from '../logistics';

/** Where an order for this buyer would ship from, and how long it takes. */
export interface LaneRoute {
  /** Warehouse country (internal only; never shown to a customer). */
  origin: string;
  /** True when the origin is outside the buyer's local lane (the CN hub). */
  overseas: boolean;
  /** Door-to-door band as the product page shows it, e.g. "8-21"; null when the route has no parsed transit. */
  days: string | null;
}

/**
 * The nearest allowed warehouse for this buyer and its customer-facing band.
 * Allowed = allowedOriginsFor (lane, plus CN while transitional) over the
 * warehouses holding at least the stock floor. Routes come
 * from the D1 matrix only, the same rows the delivery profiles and the
 * product page read, so a quote here matches checkout. Null when nothing
 * allowed is stocked or no fresh route reaches `dest`.
 */
export async function laneRouteFor(
  store: TenantStore,
  cfg: TenantConfig,
  origins: Record<string, number> | undefined | null,
  dest: string
): Promise<LaneRoute | null> {
  // Only a warehouse that can fill the order may be quoted: stock below the
  // floor never answers as "local" while the real stock is overseas (the import
  // gate applies the same floor, so the quote and the import agree).
  const floor = cfg.floors.stockFloor;
  const deep = origins ? Object.fromEntries(Object.entries(origins).filter(([, q]) => (q ?? 0) >= floor)) : origins;
  const allowed = allowedOriginsFor(deep, dest);
  if (!allowed.length) return null;
  const l = resolveLogistics(cfg.fulfil);
  const candidates: LogisticsRoute[] = [];
  for (const oc of allowed) {
    const r = await store.getLogisticsRoute(oc, dest, l.stalenessHours);
    if (r) candidates.push(r);
  }
  const resolved = resolveNearestRoute(candidates);
  if (!resolved.fulfillable) return null;
  const origin = resolved.nearest.origin;
  return {
    origin,
    overseas: !localWarehousesFor(dest).includes(origin),
    days: formatBand(doorToDoorBand(resolved.nearest.route, l)) || null,
  };
}

/**
 * The freight an overseas card is priced with: the CN -> GB route row, because
 * the store price is set on the CN -> GB quote at import. Undefined without a
 * fresh row (the card then shows the product cost only, as before).
 */
export async function overseasCardFreightUsd(store: TenantStore, cfg: TenantConfig): Promise<number | undefined> {
  const l = resolveLogistics(cfg.fulfil);
  return (await store.getLogisticsRoute('CN', 'GB', l.stalenessHours))?.freight_cost_usd ?? undefined;
}

/** What a storefront ghost click imports with, and the note its preview shows. */
export interface OverseasClickPlan {
  /** Warehouses for confirmAndImport; undefined keeps the home lane. */
  localWarehouses: string[] | undefined;
  /** The detail to import: live origins whenever they were read, never a preview freight. */
  detail: CjDetail;
  /** The preview's delivery note; undefined when the request did not ask for one. */
  delivery: { overseas: boolean; days: string | null } | null | undefined;
  /** Overseas only: the card's freight, so the preview shows the card's price. */
  previewFreightUsd?: number;
}

/**
 * The detail the PREVIEW is priced from. The overseas card carries the China
 * freight, so its preview must too; the import keeps `plan.detail`, whose
 * missing freight makes confirmAndImport quote CJ live.
 */
export function previewDetail(plan: OverseasClickPlan): CjDetail {
  return plan.previewFreightUsd !== undefined && plan.detail.freightUsd === undefined
    ? { ...plan.detail, freightUsd: plan.previewFreightUsd }
    : plan.detail;
}

/**
 * A storefront click carrying overseas=1 (inquiry sourcing, part D). The query
 * string is visitor-controlled, so the flag widens nothing by itself: stock by
 * warehouse is read live from CJ and the route is resolved BEFORE any import.
 * Only a fresh route from a warehouse holding the floor decides the lane (the
 * lane alone for local stock, lane plus CN for China stock); anything else
 * keeps the home lane, exactly as a click without the flag.
 */
export async function overseasClickPlan(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  detail: CjDetail,
  countryRaw: string | undefined,
  overseasFlag: string | undefined
): Promise<OverseasClickPlan> {
  const plain: OverseasClickPlan = { localWarehouses: undefined, detail, delivery: undefined };
  if (overseasFlag !== '1') return plain;
  const cc = (countryRaw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || !inquiryWarehouses(cc).length) return plain;
  const origins = await cj.originsByPid(detail.pid).catch(() => null);
  if (!origins) return { ...plain, delivery: null };
  const live = { ...detail, origins };
  const route = await laneRouteFor(store, cfg, origins, cc);
  if (!route) return { localWarehouses: undefined, detail: live, delivery: null };
  return {
    localWarehouses: route.overseas ? inquiryWarehouses(cc) : localWarehousesFor(cc),
    detail: live,
    delivery: { overseas: route.overseas, days: route.days },
    ...(route.overseas ? { previewFreightUsd: await overseasCardFreightUsd(store, cfg) } : {}),
  };
}
