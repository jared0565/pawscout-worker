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
 */
export function retailPriceGbp(landedUsd: number, p: Pricing, freightUsd = 0): number {
  if (!Number.isFinite(landedUsd) || landedUsd <= 0) throw new Error('landed cost must be a positive number');
  const fx = p.fxUsdToGbp * (1 + p.fxBufferPct / 100);
  const costGbp = landedUsd * fx;
  const freightGbp = Number.isFinite(freightUsd) && freightUsd > 0 ? freightUsd * fx : 0;
  let retail = costGbp * Math.max(p.multiplier, p.floor) + freightGbp;
  if (retail - (costGbp + freightGbp) < p.minMarginGbp) retail = costGbp + freightGbp + p.minMarginGbp;
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
