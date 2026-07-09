import type { Pricing } from './types';

/**
 * Landed USD supplier cost → GBP retail price.
 *
 * The default rule (multiplier 2.5×) targets ~17% net margin under the
 * researched cost stack: ads ~33% of revenue (ROAS 3), payments ~2.5%,
 * FX ~1.5%, refunds ~3%, fixed ~2%. The floor and absolute minimum margin
 * protect low-ticket items where percentages don't cover fixed fees.
 *
 * `freightUsd` (owner decision 2026-07-03, free-UK-delivery cutover): freight
 * is BAKED INTO the sticker - added AFTER the multiplier (pass-through, never
 * multiplied) - so UK checkout shipping can be £0 storewide without eating
 * margin. Domestic-warehouse items (freight $0, e.g. GB stock sold to the UK)
 * keep their sticker unchanged. The minimum-margin clause still guarantees
 * (product + freight + minMargin) on cheap items. This REVERSES the 2026-06-12
 * "freight disciplines the floor, never the sticker" rule: that rule plus a
 * separate checkout shipping charge double-charged freight on min-margin items.
 * Unknown freight (legacy rows) degrades to the product-cost-only rule.
 *
 * `maxMarginGbp` (owner decision 2026-07-04): optional absolute margin cap, the
 * mirror of the minimum. Above the crossover cost the effective multiplier
 * declines smoothly as 1 + cap/cost - a high-end taper with no band-edge price
 * cliffs - keeping big-ticket items near their market price instead of
 * multiplier-inflated far above it. Freight still passes through on top.
 * Absent/zero/invalid = no cap.
 */
export function retailPriceGbp(landedUsd: number, p: Pricing, freightUsd = 0): number {
  if (!Number.isFinite(landedUsd) || landedUsd <= 0) throw new Error('landed cost must be a positive number');
  const fx = p.fxUsdToGbp * (1 + p.fxBufferPct / 100);
  const costGbp = landedUsd * fx;
  const freightGbp = Number.isFinite(freightUsd) && freightUsd > 0 ? freightUsd * fx : 0;
  let retail = costGbp * Math.max(p.multiplier, p.floor) + freightGbp;
  if (retail - (costGbp + freightGbp) < p.minMarginGbp) retail = costGbp + freightGbp + p.minMarginGbp;
  const cap = p.maxMarginGbp;
  if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0 && retail - (costGbp + freightGbp) > cap) {
    retail = costGbp + freightGbp + cap;
  }
  return round99(retail);
}

/**
 * Honest landed COGS in GBP (product + freight) at the RAW configured FX rate -
 * no buffer. This is what we actually pay, and it is what gets written to
 * Shopify's store-wide "Cost per item" (which drives native margin/profit
 * analytics) and fed to the affiliate £6 floor. It must NOT be padded: the FX
 * buffer exists to make the RETAIL sticker conservative, not to overstate cost.
 * Conservatism for affiliate eligibility lives in the floor, not here.
 */
export function landedCostGbp(landedUsd: number, p: Pricing, freightUsd = 0): number {
  if (!Number.isFinite(landedUsd) || landedUsd <= 0) throw new Error('landed cost must be a positive number');
  const freight = Number.isFinite(freightUsd) && freightUsd > 0 ? freightUsd : 0;
  return Math.round((landedUsd + freight) * p.fxUsdToGbp * 100) / 100;
}

/**
 * Defensible cost-plus shelf price from a GBP LANDED cost (product + freight
 * already in GBP - e.g. Shopify's live "Cost per item"). This is the active
 * profitability agent's "market of one" when NO competitor price exists: our
 * standard markup on the REAL, current cost. It mirrors retailPriceGbp's markup +
 * minimum/maximum-margin clauses but is GBP-native, so it tracks the freshest live
 * cost rather than an admission-time USD figure (freight is already inside the
 * landed cost here, so it is part of the marked-up base rather than a pass-through
 * term - a small, conservative difference vs retailPriceGbp that only matters for
 * freight-heavy items, where it errs toward MORE margin). Returns 0 (no defensible
 * price) for a non-positive cost, so callers can fall back to a flag.
 */
export function costPlusPriceGbp(costGbp: number, p: Pricing): number {
  if (!Number.isFinite(costGbp) || costGbp <= 0) return 0;
  let retail = costGbp * Math.max(p.multiplier, p.floor);
  if (retail - costGbp < p.minMarginGbp) retail = costGbp + p.minMarginGbp;
  const cap = p.maxMarginGbp;
  if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0 && retail - costGbp > cap) retail = costGbp + cap;
  return round99(retail);
}

/**
 * Affiliate £6-floor parameters. The floor is the per-unit contribution that
 * must SURVIVE an affiliate sale: net-of-VAT revenue (the VAT isn't ours),
 * minus honest COGS, minus the affiliate commission (on the ex-VAT base) and
 * the platform fee (on the gross sale, which is how UpPromote charges). Only
 * SKUs that still clear £6 after all of that are worth promoting.
 */
export interface AffiliateFloor {
  vatRate: number;          // UK VAT included in the sticker (0.20)
  commissionRate: number;   // affiliate commission on ex-VAT revenue (0.08)
  platformFeeRate: number;  // UpPromote fee on gross sale (0.02)
  floorGbp: number;         // minimum surviving per-unit contribution (£6)
}

export const DEFAULT_AFFILIATE_FLOOR: AffiliateFloor = {
  vatRate: 0.2,
  commissionRate: 0.08,
  platformFeeRate: 0.02,
  floorGbp: 6
};

/** Per-unit contribution left after VAT, COGS, commission and platform fee. */
export function affiliateContributionGbp(retailGbp: number, cogsGbp: number, f: AffiliateFloor = DEFAULT_AFFILIATE_FLOOR): number {
  const netRevenue = retailGbp / (1 + f.vatRate);
  return netRevenue - cogsGbp - f.commissionRate * netRevenue - f.platformFeeRate * retailGbp;
}

/** True when a SKU's surviving contribution clears the floor (default £6). */
export function affiliateEligible(retailGbp: number, cogsGbp: number, f: AffiliateFloor = DEFAULT_AFFILIATE_FLOOR): boolean {
  if (!Number.isFinite(retailGbp) || !Number.isFinite(cogsGbp) || retailGbp <= 0 || cogsGbp <= 0) return false;
  return affiliateContributionGbp(retailGbp, cogsGbp, f) >= f.floorGbp - 1e-9;
}

/** Round UP to the nearest .99 ending - never down past the computed price. */
function round99(x: number): number {
  const candidate = Math.ceil(x) - 0.01;
  const r = candidate >= x ? candidate : Math.ceil(x) + 0.99;
  return Math.round(r * 100) / 100;
}
