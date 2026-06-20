import type { Pricing } from './types';

/**
 * Landed USD supplier cost → GBP retail price.
 *
 * The default rule (multiplier 2.5×) targets ~17% net margin under the
 * researched cost stack: ads ~33% of revenue (ROAS 3), payments ~2.5%,
 * FX ~1.5%, refunds ~3%, fixed ~2%. The floor and absolute minimum margin
 * protect low-ticket items where percentages don't cover fixed fees.
 *
 * `freightUsd` (decided 2026-06-12): freight disciplines the FLOOR, never
 * the sticker — the multiplier still applies to product cost only, but the
 * minimum-margin clause is enforced against (product + freight) so a heavy
 * cheap item can never ship underwater. Unknown freight (legacy rows)
 * degrades to the product-cost-only rule.
 */
export function retailPriceGbp(landedUsd: number, p: Pricing, freightUsd = 0): number {
  if (!Number.isFinite(landedUsd) || landedUsd <= 0) throw new Error('landed cost must be a positive number');
  const fx = p.fxUsdToGbp * (1 + p.fxBufferPct / 100);
  const costGbp = landedUsd * fx;
  const freightGbp = Number.isFinite(freightUsd) && freightUsd > 0 ? freightUsd * fx : 0;
  let retail = costGbp * Math.max(p.multiplier, p.floor);
  if (retail - (costGbp + freightGbp) < p.minMarginGbp) retail = costGbp + freightGbp + p.minMarginGbp;
  return round99(retail);
}

/**
 * Honest landed COGS in GBP (product + freight) at the RAW configured FX rate —
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

/** Round UP to the nearest .99 ending — never down past the computed price. */
function round99(x: number): number {
  const candidate = Math.ceil(x) - 0.01;
  const r = candidate >= x ? candidate : Math.ceil(x) + 0.99;
  return Math.round(r * 100) / 100;
}
