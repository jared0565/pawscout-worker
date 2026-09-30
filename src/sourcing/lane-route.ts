import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
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
 * Allowed = allowedOriginsFor (lane, plus CN while transitional). Routes come
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
  const allowed = allowedOriginsFor(origins, dest);
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

/** Warehouses a storefront ghost click may import from: the default (undefined,
 *  meaning the home lane) unless the theme sent overseas=1 with a valid
 *  country whose lane can use the China hub. */
export function storefrontImportWarehouses(countryRaw: string | undefined, overseasFlag: string | undefined): string[] | undefined {
  if (overseasFlag !== '1') return undefined;
  const cc = (countryRaw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return undefined;
  const w = inquiryWarehouses(cc);
  return w.includes('CN') ? w : undefined;
}
