import { describe, test, expect } from 'vitest';
import { computeMarketExclusions, type MarketDef } from '../../src/shipping/market-exclusion';

// Fulfillability oracle for the verified catalog reality:
//   GB-warehoused -> UK only (GB->GB; GB->anything else = no CJ route)
//   US-warehoused -> US only (US->US; US->CA/GB/DE = no CJ route)
//   CN-warehoused -> the CN hub reaches GB/US/DE/CA/AU (+ most EU)
const isFulfillable = (sig: string, dest: string): boolean => {
  const origins = sig.split(',');
  if (origins.includes('GB') && dest === 'GB') return true;
  if (origins.includes('US') && dest === 'US') return true;
  if (origins.includes('CN') && ['GB', 'US', 'DE', 'FR', 'CA', 'AU'].includes(dest)) return true;
  return false;
};

const UK: MarketDef = { id: 'm-uk', name: 'United Kingdom', countries: ['GB'] };
const US_CA: MarketDef = { id: 'm-usca', name: 'United States and Canada', countries: ['US', 'CA'] };
const EU: MarketDef = { id: 'm-eu', name: 'European Union', countries: ['DE', 'FR'] };
const AU: MarketDef = { id: 'm-au', name: 'Australia', countries: ['AU'] };

const memberships = new Map<string, string[]>([
  ['GB', ['gid://shopify/Product/gb1', 'gid://shopify/Product/gb2']],
  ['US', ['gid://shopify/Product/us1']],
  ['CN', ['gid://shopify/Product/cn1']],
  ['CN,US', ['gid://shopify/Product/cnus1']],
]);

const exclFor = (out: ReturnType<typeof computeMarketExclusions>, name: string): string[] =>
  out.find((e) => e.market.name === name)?.excludeProductIds.sort() ?? [];

describe('computeMarketExclusions', () => {
  const out = computeMarketExclusions([UK, US_CA, EU, AU], memberships, isFulfillable);

  test('GB-only products are kept in the UK market', () => {
    expect(exclFor(out, 'United Kingdom')).not.toContain('gid://shopify/Product/gb1');
  });

  test('GB-only products are excluded from EU, US/CA, and AU markets', () => {
    for (const m of ['European Union', 'United States and Canada', 'Australia']) {
      expect(exclFor(out, m)).toEqual(expect.arrayContaining([
        'gid://shopify/Product/gb1',
        'gid://shopify/Product/gb2',
      ]));
    }
  });

  test('US/CA market excludes ONLY the GB-only products (US-only kept; CN kept)', () => {
    expect(exclFor(out, 'United States and Canada')).toEqual([
      'gid://shopify/Product/gb1',
      'gid://shopify/Product/gb2',
    ]);
  });

  test('EU and AU markets exclude both GB-only and US-only products', () => {
    for (const m of ['European Union', 'Australia']) {
      expect(exclFor(out, m)).toEqual([
        'gid://shopify/Product/gb1',
        'gid://shopify/Product/gb2',
        'gid://shopify/Product/us1',
      ]);
    }
  });

  test('US-only product STAYS in the "United States and Canada" market (US is fulfillable, even though CA is not)', () => {
    // The documented coarse-market residual: cannot exclude from Canada alone.
    expect(exclFor(out, 'United States and Canada')).not.toContain('gid://shopify/Product/us1');
  });

  test('US-only product is excluded from UK, EU, and AU markets', () => {
    expect(exclFor(out, 'United Kingdom')).toContain('gid://shopify/Product/us1');
    expect(exclFor(out, 'European Union')).toContain('gid://shopify/Product/us1');
    expect(exclFor(out, 'Australia')).toContain('gid://shopify/Product/us1');
  });

  test('CN and CN+US products stay in every market (CN hub reaches all)', () => {
    for (const m of ['United Kingdom', 'United States and Canada', 'European Union', 'Australia']) {
      expect(exclFor(out, m)).not.toContain('gid://shopify/Product/cn1');
      expect(exclFor(out, m)).not.toContain('gid://shopify/Product/cnus1');
    }
  });

  test('a market with no resolved countries yields no exclusions (safe: cannot determine)', () => {
    const row = computeMarketExclusions([{ id: 'm-row', name: 'Rest of World', countries: [] }], memberships, isFulfillable);
    expect(row[0].excludeProductIds).toEqual([]);
  });

  test('every input market appears in the output', () => {
    expect(out.map((e) => e.market.name)).toEqual([
      'United Kingdom',
      'United States and Canada',
      'European Union',
      'Australia',
    ]);
  });
});

describe('local-for-local lane isolation (deterministic, route matrix cannot override)', () => {
  // An oracle that claims EVERY cross-lane route exists. Under the old
  // fulfillability-only rule this would leak US stock into the UK storefront -
  // the exact case the owner flagged. The lane rule must exclude it anyway.
  const everythingShips = () => true;
  const out = computeMarketExclusions([UK, US_CA, EU, AU], memberships, everythingShips);

  test('US-warehoused product stays OUT of the UK market even when a US->GB route exists', () => {
    expect(exclFor(out, 'United Kingdom')).toContain('gid://shopify/Product/us1');
  });

  test('GB-warehoused product stays OUT of the US/CA, EU and AU markets even with routes', () => {
    for (const m of ['United States and Canada', 'European Union', 'Australia']) {
      expect(exclFor(out, m)).toEqual(expect.arrayContaining([
        'gid://shopify/Product/gb1',
        'gid://shopify/Product/gb2',
      ]));
    }
  });

  test('local products stay IN their own lane even when the route matrix is stale/empty', () => {
    // Oracle finds no routes at all (stale cj_logistics): local stock must
    // never be hidden from its own market by a matrix outage.
    const nothingShips = () => false;
    const stale = computeMarketExclusions([UK, US_CA], memberships, nothingShips);
    expect(exclFor(stale, 'United Kingdom')).not.toContain('gid://shopify/Product/gb1');
    expect(exclFor(stale, 'United States and Canada')).not.toContain('gid://shopify/Product/us1');
    // ...but the CN scaffolding DOES drop out when nothing ships (quote==checkout).
    expect(exclFor(stale, 'United Kingdom')).toContain('gid://shopify/Product/cn1');
  });

  test('the UK/GB origin alias counts as local to the UK market', () => {
    const aliased = new Map<string, string[]>([['UK', ['gid://shopify/Product/ukalias1']]]);
    const r = computeMarketExclusions([UK, US_CA], aliased, everythingShips);
    expect(exclFor(r, 'United Kingdom')).not.toContain('gid://shopify/Product/ukalias1');
    expect(exclFor(r, 'United States and Canada')).toContain('gid://shopify/Product/ukalias1');
  });

  test('EU-warehoused product is local to the EU market and cross-lane everywhere else', () => {
    const withDe = new Map<string, string[]>([['DE', ['gid://shopify/Product/de1']]]);
    const r = computeMarketExclusions([UK, US_CA, EU, AU], withDe, everythingShips);
    expect(exclFor(r, 'European Union')).not.toContain('gid://shopify/Product/de1');
    for (const m of ['United Kingdom', 'United States and Canada', 'Australia']) {
      expect(exclFor(r, m)).toContain('gid://shopify/Product/de1');
    }
  });
});

describe('visibility modes', () => {
  test('local_only drops the CN scaffolding but keeps the local lane', () => {
    const usLaunched: MarketDef = { ...US_CA, mode: 'local_only' };
    const out = computeMarketExclusions([usLaunched], memberships, isFulfillable);
    const excl = exclFor(out, 'United States and Canada');
    expect(excl).toContain('gid://shopify/Product/cn1');       // scaffolding retired
    expect(excl).not.toContain('gid://shopify/Product/us1');   // local stays
    expect(excl).not.toContain('gid://shopify/Product/cnus1'); // local via its US origin
    expect(excl).toEqual(expect.arrayContaining(['gid://shopify/Product/gb1'])); // cross-lane still out
  });

  test('transitional is the default when mode is absent', () => {
    const out = computeMarketExclusions([UK], memberships, isFulfillable);
    expect(exclFor(out, 'United Kingdom')).not.toContain('gid://shopify/Product/cn1');
  });
});
