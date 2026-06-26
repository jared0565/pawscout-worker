// src/shipping/market-exclusion.ts
//
// Pure engine for the per-market product-availability fix (Managed Markets reality):
// Shopify CarrierService cannot block an unfulfillable order, and zone omission is
// defeated by Managed Markets backfill - so unfulfillable orders are prevented by
// EXCLUDING products from the catalog of any market they cannot be fulfilled to.
//
// This module computes WHICH products to exclude from WHICH markets. The Shopify-admin
// wiring (fetch live markets + their catalog publications, then publicationUpdate with
// publishablesToRemove) is built separately and verified against the live schema, because
// mock tests validate shape against the mock, not the real Shopify schema.

export interface MarketDef {
  /** Shopify Market gid. */
  id: string;
  /** Human-readable market name (for logging / matching). */
  name: string;
  /** Concrete ISO country codes that belong to this market. The caller must expand any
   *  "Rest of World" / wildcard market into its concrete countries before calling; an empty
   *  list means "cannot determine" and yields no exclusions (fail-safe, never over-exclude). */
  countries: string[];
}

export interface MarketExclusion {
  market: MarketDef;
  /** Shopify product ids to exclude from this market's catalog (unfulfillable to every
   *  country in the market). */
  excludeProductIds: string[];
}

/**
 * For each market, the products that cannot be fulfilled to ANY country in that market and
 * must therefore be excluded from that market's catalog. A product is KEPT in a market when
 * at least one of the market's countries is a fulfillable destination for the product's
 * origin-signature - which is why, e.g., a US-only product stays in a "United States and
 * Canada" market (US is fulfillable) even though Canada is not (the documented coarse-market
 * residual: a multi-country managed market cannot be split per country).
 *
 * Pure: the caller supplies the live markets (with concrete country lists), the
 * signature -> productIds memberships (TenantStore.listSignatureMemberships), and a
 * fulfillability oracle `isFulfillable(signature, destCountry)` built from resolveNearestRoute
 * over the cj_logistics matrix - the SAME resolver the inbox agent and profile sync use, so
 * the exclusion set is consistent with the quotes and the delivery profiles.
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
      for (const [signature, productIds] of memberships) {
        const reachable = market.countries.some((c) => isFulfillable(signature, c));
        if (!reachable) excludeProductIds.push(...productIds);
      }
    }
    return { market, excludeProductIds };
  });
}
