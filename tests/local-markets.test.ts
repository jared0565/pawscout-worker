import { describe, it, expect } from 'vitest';
import { localWarehousesFor, bestLocalQty, HOME_MARKET_WAREHOUSES, EU_COUNTRIES } from '../src/local-markets';

// Local-for-local (owner's governing model, 2026-07-05): every market's buyers
// are served ONLY from warehouses local to them. These mappings drive the
// import gate, pool admission, refill pre-filter and search suggestions.
describe('localWarehousesFor', () => {
  it('maps the home market and its alias', () => {
    expect(localWarehousesFor('GB')).toEqual(['GB']);
    expect(localWarehousesFor('uk')).toEqual(['GB']);
  });

  it('maps US and Canada to the US warehouse', () => {
    expect(localWarehousesFor('US')).toEqual(['US']);
    expect(localWarehousesFor('CA')).toEqual(['US']);
  });

  it('maps every EU member to the EU warehouse set', () => {
    for (const cc of EU_COUNTRIES) {
      expect(localWarehousesFor(cc)).toContain('DE');
    }
  });

  it('maps Australia, and gives unserved countries NO local warehouse', () => {
    expect(localWarehousesFor('AU')).toEqual(['AU']);
    expect(localWarehousesFor('JP')).toEqual([]);
    expect(localWarehousesFor('BR')).toEqual([]);
    expect(localWarehousesFor('')).toEqual([]);
    expect(localWarehousesFor(null)).toEqual([]);
    expect(localWarehousesFor('CN')).toEqual([]); // we do not sell to CN; CN stock serves nobody we serve
  });

  it('the home market constant is GB', () => {
    expect(HOME_MARKET_WAREHOUSES).toEqual(['GB']);
  });
});

describe('bestLocalQty', () => {
  it('returns the best quantity among local warehouses only', () => {
    expect(bestLocalQty({ GB: 12, CN: 900 }, ['GB'])).toBe(12);
    expect(bestLocalQty({ CN: 900 }, ['GB'])).toBe(0); // CN stock counts for nothing locally
    expect(bestLocalQty({ DE: 5, PL: 9, CN: 100 }, ['DE', 'FR', 'ES', 'IT', 'PL', 'CZ'])).toBe(9);
  });

  it('tolerates the GB/UK alias and fails closed on missing origins', () => {
    expect(bestLocalQty({ UK: 7 }, ['GB'])).toBe(7);
    expect(bestLocalQty(undefined, ['GB'])).toBe(0);
    expect(bestLocalQty(null, ['GB'])).toBe(0);
    expect(bestLocalQty({}, ['GB'])).toBe(0);
  });
});
