import { describe, it, expect } from 'vitest';
import { localWarehousesFor, bestLocalQty, marketLocalWarehouses, visibilityModeFor, laneVisibilityModeFor, normalizeOriginCode, sellableToBuyer, HOME_MARKET_WAREHOUSES, LOCAL_ONLY_MARKETS, EU_COUNTRIES } from '../src/local-markets';

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

describe('marketLocalWarehouses', () => {
  it('unions locals across a market\'s member countries', () => {
    expect([...marketLocalWarehouses(['US', 'CA'])]).toEqual(['US']);
    expect([...marketLocalWarehouses(['GB'])]).toEqual(['GB']);
    expect(marketLocalWarehouses(['DE', 'FR']).has('DE')).toBe(true);
    expect([...marketLocalWarehouses([])]).toEqual([]);
    expect([...marketLocalWarehouses(['JP'])]).toEqual([]); // unserved country -> no locals
  });
});

describe('visibilityModeFor', () => {
  it('every market is transitional until its launch flips it (LOCAL_ONLY_MARKETS empty today)', () => {
    expect(LOCAL_ONLY_MARKETS).toEqual([]);
    expect(visibilityModeFor(['GB'])).toBe('transitional');
    expect(visibilityModeFor(['US', 'CA'])).toBe('transitional');
    expect(visibilityModeFor([])).toBe('transitional');
  });

  it('a launched country flips its whole market to local-only', () => {
    expect(visibilityModeFor(['US', 'CA'], ['US'])).toBe('local_only');
    expect(visibilityModeFor(['GB'], ['US'])).toBe('transitional'); // other markets untouched
    expect(visibilityModeFor(['DE', 'FR'], ['DE'])).toBe('local_only');
  });
});

describe('laneVisibilityModeFor (per buyer country, lane-consistent with the market flip)', () => {
  it('flipping US flips every country the US lane serves, and only that lane', () => {
    expect(laneVisibilityModeFor('CA', ['US'])).toBe('local_only'); // same lane as US
    expect(laneVisibilityModeFor('US', ['US'])).toBe('local_only');
    expect(laneVisibilityModeFor('GB', ['US'])).toBe('transitional');
    expect(laneVisibilityModeFor('FR', ['US'])).toBe('transitional');
  });

  it('flipping one EU country flips the whole EU lane', () => {
    expect(laneVisibilityModeFor('FR', ['DE'])).toBe('local_only');
    expect(laneVisibilityModeFor('PL', ['DE'])).toBe('local_only');
    expect(laneVisibilityModeFor('AU', ['DE'])).toBe('transitional');
  });

  it('a country with no lane reads local_only (nothing sellable, scaffolding included)', () => {
    expect(laneVisibilityModeFor('JP', [])).toBe('local_only');
    expect(laneVisibilityModeFor('BR', ['US'])).toBe('local_only');
  });
});

describe('normalizeOriginCode', () => {
  it('maps the UK alias to GB and uppercases', () => {
    expect(normalizeOriginCode('UK')).toBe('GB');
    expect(normalizeOriginCode('uk ')).toBe('GB');
    expect(normalizeOriginCode('gb')).toBe('GB');
    expect(normalizeOriginCode('CN')).toBe('CN');
  });
});

describe('sellableToBuyer (the per-inquiry local-for-local sale test)', () => {
  it('local-lane stock is sellable to its own lane, never cross-lane', () => {
    expect(sellableToBuyer({ GB: 10 }, 'GB')).toBe(true);
    expect(sellableToBuyer({ US: 10 }, 'GB')).toBe(false); // the owner-flagged leak
    expect(sellableToBuyer({ GB: 10 }, 'US')).toBe(false);
    expect(sellableToBuyer({ US: 10 }, 'CA')).toBe(true);  // CA rides the US lane
    expect(sellableToBuyer({ DE: 5 }, 'FR')).toBe(true);   // EU lane
  });

  it('CN scaffolding sells only while the lane is transitional and only when deliverable', () => {
    expect(sellableToBuyer({ CN: 900 }, 'GB')).toBe(true);
    expect(sellableToBuyer({ CN: 900 }, 'GB', { cnDeliverable: false })).toBe(false);
    expect(sellableToBuyer({ CN: 900 }, 'US', { launched: ['US'] })).toBe(false); // local_only drops CN
    expect(sellableToBuyer({ US: 10, CN: 900 }, 'US', { launched: ['US'] })).toBe(true); // local stays
  });

  it('fails closed: no lane, no origins, zero stock', () => {
    expect(sellableToBuyer({ CN: 900 }, 'JP')).toBe(false); // no lane -> no market
    expect(sellableToBuyer(undefined, 'GB')).toBe(false);
    expect(sellableToBuyer(null, 'GB')).toBe(false);
    expect(sellableToBuyer({ GB: 0 }, 'GB')).toBe(false);
  });

  it('tolerates the UK origin alias', () => {
    expect(sellableToBuyer({ UK: 7 }, 'GB')).toBe(true);
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
