import type { Pricing } from './types';

/**
 * Landed USD supplier cost → GBP retail price.
 *
 * The default rule (multiplier 2.5×) targets ~17% net margin under the
 * researched cost stack: ads ~33% of revenue (ROAS 3), payments ~2.5%,
 * FX ~1.5%, refunds ~3%, fixed ~2%. The floor and absolute minimum margin
 * protect low-ticket items where percentages don't cover fixed fees.
 */
export function retailPriceGbp(landedUsd: number, p: Pricing): number {
  if (!Number.isFinite(landedUsd) || landedUsd <= 0) throw new Error('landed cost must be a positive number');
  const costGbp = landedUsd * p.fxUsdToGbp * (1 + p.fxBufferPct / 100);
  let retail = costGbp * Math.max(p.multiplier, p.floor);
  if (retail - costGbp < p.minMarginGbp) retail = costGbp + p.minMarginGbp;
  return round99(retail);
}

/** Round UP to the nearest .99 ending — never down past the computed price. */
function round99(x: number): number {
  const candidate = Math.ceil(x) - 0.01;
  const r = candidate >= x ? candidate : Math.ceil(x) + 0.99;
  return Math.round(r * 100) / 100;
}
