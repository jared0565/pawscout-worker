// Local-for-local (the owner's governing model, locked 2026-07-05): every
// market's buyers are served ONLY from warehouses local to them - GB stock for
// GB buyers, US stock for US+CA, EU stock for the EU, AU stock for Australia.
// It is the only configuration that satisfies shipping cost AND time at once,
// so it governs every surface that selects products: imports, the nightly
// refill, warehouse-pool admission, and the storefront search suggestions.
// CN warehouses serve CN buyers, whom we do not sell to - CN stock is never
// pulled for any market we serve.

/** EU single-market members: one EU warehouse serves all of them duty-free. */
export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
]);

/** CJ warehouse country codes acceptable as LOCAL for a buyer's country.
 *  Empty array = no local warehouse serves that buyer, so no supplier
 *  suggestions and no imports on their behalf. */
export function localWarehousesFor(buyerCountry: string | null | undefined): string[] {
  const cc = (buyerCountry ?? '').trim().toUpperCase();
  if (!cc) return [];
  if (cc === 'GB' || cc === 'UK') return ['GB'];
  if (cc === 'US' || cc === 'CA') return ['US'];
  if (cc === 'AU') return ['AU'];
  if (EU_COUNTRIES.has(cc)) return ['DE', 'FR', 'ES', 'IT', 'PL', 'CZ']; // CJ's EU warehouses (DE carries most pet stock)
  return [];
}

/** The home market's local warehouses (the UK store). Import-side gates use
 *  this constant: nothing enters the catalog unless a home-local warehouse
 *  really stocks it. Per-market catalogs for US/EU/AU get their own gates
 *  when those seed runs land. */
export const HOME_MARKET_WAREHOUSES = localWarehousesFor('GB');

/** Best available quantity across the given local warehouses. Tolerates CJ's
 *  GB/UK aliasing; absent/undefined origins count as zero (fail closed - an
 *  unverified origin is exactly the CN-era ambiguity this model ends). */
export function bestLocalQty(origins: Record<string, number> | undefined | null, locals: string[]): number {
  if (!origins) return 0;
  let best = 0;
  for (const cc of locals) {
    const qty = origins[cc] ?? (cc === 'GB' ? origins['UK'] : undefined) ?? 0;
    if (qty > best) best = qty;
  }
  return best;
}
