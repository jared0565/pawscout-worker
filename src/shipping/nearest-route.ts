// src/shipping/nearest-route.ts
import type { LogisticsRoute } from '../logistics';

export interface NearestRoute { origin: string; dest: string; route: LogisticsRoute }
export type NearestResult = { fulfillable: true; nearest: NearestRoute } | { fulfillable: false };

/**
 * Pick the nearest warehouse route from pre-fetched candidate rows (all sharing one dest).
 * Ranking: domestic (from === to) first, then cheapest freight (null sorts last), then
 * shortest transit. Domestic is the geographically nearest warehouse and is robust to an
 * unsynced (null) domestic freight. Empty candidates => not fulfillable (honest no-ship).
 * Pure: the caller is responsible for fetching candidates and for quote==checkout by using
 * this same function on both the inquiry and the checkout-profile side.
 */
export function resolveNearestRoute(candidates: LogisticsRoute[]): NearestResult {
  if (!candidates.length) return { fulfillable: false };
  const key = (r: LogisticsRoute): [number, number, number] => [
    r.from_country === r.to_country ? 0 : 1,
    typeof r.freight_cost_usd === 'number' && Number.isFinite(r.freight_cost_usd) ? r.freight_cost_usd : Infinity,
    typeof r.transit_min === 'number' && Number.isFinite(r.transit_min) ? r.transit_min : Infinity,
  ];
  const best = [...candidates].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  })[0];
  return { fulfillable: true, nearest: { origin: best.from_country, dest: best.to_country, route: best } };
}
