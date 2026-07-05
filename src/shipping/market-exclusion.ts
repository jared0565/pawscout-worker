// src/shipping/market-exclusion.ts
//
// Pure engine for per-market product visibility under the local-for-local
// governing model (owner, 2026-07-05): every market's buyers are served from
// warehouses LOCAL to them. A market's catalog therefore contains:
//
//   - its local-lane products, always (GB stock in the UK market, US stock in
//     the US+CA market, EU stock in the EU market, AU stock in Australia);
//   - while the market is 'transitional', the CN scaffolding catalog too -
//     but only products the CN hub can genuinely deliver to the market
//     (quote==checkout: CarrierService cannot block an unfulfillable order,
//     and zone omission is defeated by Managed Markets backfill).
//
// Cross-lane warehouse stock is excluded DETERMINISTICALLY, whatever the route
// matrix says: a US-warehoused product never shows in the UK market even if a
// US->GB route exists, because a cross-lane order fails the shipping time+cost
// promise that local-for-local exists to keep. Once a market flips to
// 'local_only' (its launch), the CN scaffolding drops out as well.
//
// This module computes WHICH products to exclude from WHICH markets. The
// Shopify-admin wiring (fetch live markets + their catalog publications, then
// publicationUpdate with publishablesToRemove) lives in market-catalogs.ts and
// is verified against the live schema, because mock tests validate shape
// against the mock, not the real Shopify schema.

import { marketLocalWarehouses, normalizeOriginCode, type MarketVisibilityMode } from '../local-markets';

export interface MarketDef {
  /** Shopify Market gid. */
  id: string;
  /** Human-readable market name (for logging / matching). */
  name: string;
  /** Concrete ISO country codes that belong to this market. The caller must expand any
   *  "Rest of World" / wildcard market into its concrete countries before calling; an empty
   *  list means "cannot determine" and yields no exclusions (fail-safe, never over-exclude). */
  countries: string[];
  /** Visibility mode; absent defaults to 'transitional' (local + CN scaffolding). */
  mode?: MarketVisibilityMode;
}

export interface MarketExclusion {
  market: MarketDef;
  /** Shopify product ids to exclude from this market's catalog. */
  excludeProductIds: string[];
}

/**
 * For each market, the products to exclude from that market's catalog. A product is
 * VISIBLE in a market when:
 *
 *   1. its origin signature includes a warehouse local to the market (local-for-local;
 *      note the documented coarse-market residual: a US-warehoused product stays in the
 *      whole "United States and Canada" market because a multi-country market cannot be
 *      split per country); or
 *   2. the market is 'transitional' AND the signature includes the CN scaffolding hub
 *      AND at least one of the market's countries is a fulfillable destination for the
 *      signature.
 *
 * Everything else - cross-lane stock above all - is excluded.
 *
 * Pure: the caller supplies the live markets (with concrete country lists and modes), the
 * signature -> productIds memberships (TenantStore.listSignatureMemberships), and a
 * fulfillability oracle `isFulfillable(signature, destCountry)` built from resolveNearestRoute
 * over the cj_logistics matrix - the SAME resolver the inbox agent and profile sync use, so
 * the transitional CN set is consistent with the quotes and the delivery profiles.
 *
 * @param markets concrete markets; a market with an empty `countries` array is skipped (no
 *   exclusions) so an unresolved wildcard market can never cause silent over-exclusion.
 */
export function computeMarketExclusions(
  markets: MarketDef[],
  memberships: Map<string, string[]>,
  isFulfillable: (signature: string, destCountry: string) => boolean
): MarketExclusion[] {
  return markets.map((market) => {
    const excludeProductIds: string[] = [];
    if (market.countries.length) {
      const locals = marketLocalWarehouses(market.countries);
      const mode = market.mode ?? 'transitional';
      for (const [signature, productIds] of memberships) {
        const origins = signature.split(',').map(normalizeOriginCode);
        const visible = origins.some((o) => locals.has(o)) || (
          mode === 'transitional'
          && origins.includes('CN')
          && market.countries.some((c) => isFulfillable(signature, c))
        );
        if (!visible) excludeProductIds.push(...productIds);
      }
    }
    return { market, excludeProductIds };
  });
}
