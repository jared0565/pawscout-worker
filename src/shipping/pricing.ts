/** USD freight to a GBP rate string (2dp) = usd*fx + handling. Null/undefined or non-finite
 *  freight degrades to 0.00 (domestic / unpriced), never NaN. fx and handling come from config. */
export function freightUsdToGbp(usd: number | null | undefined, fxUsdToGbp: number, handlingGbp: number): string {
  const u = typeof usd === 'number' && Number.isFinite(usd) ? usd : 0;
  const gbp = u * fxUsdToGbp + handlingGbp;
  return (Number.isFinite(gbp) ? Math.max(0, gbp) : 0).toFixed(2);
}
