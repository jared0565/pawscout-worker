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
