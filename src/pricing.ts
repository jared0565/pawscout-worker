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

/** Round UP to the nearest .99 ending — never down past the computed price. */
function round99(x: number): number {
  const candidate = Math.ceil(x) - 0.01;
  const r = candidate >= x ? candidate : Math.ceil(x) + 0.99;
  return Math.round(r * 100) / 100;
}
