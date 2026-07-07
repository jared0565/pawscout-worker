// Fixed USD pricing for the US & Canada catalog (2026-07-07): pins the .99
// rounding rule, the adopt-or-create price list flow, and the diff-only sync
// (converged runs must issue no fixed-price mutations).
import { describe, it, expect } from 'vitest';
import { usdFromGbp, ensureUsPriceList, syncUsFixedPrices } from '../src/shipping/us-price-list';
import type { AdminGraphql } from '../src/shopify-admin';

const FX = 0.78;
const CFG = { pricing: { fxUsdToGbp: FX } };

describe('usdFromGbp', () => {
  it('anchors to the tenant fx knob with nearest-.99 rounding', () => {
    expect(usdFromGbp(47.99, FX)).toBe(61.99); // 61.53 raw - the fountain
    expect(usdFromGbp(10.99, FX)).toBe(13.99); // 14.09 raw rounds DOWN to .99
    expect(usdFromGbp(22.99, FX)).toBe(28.99); // 29.47 raw - nearer 28.99 than 29.99
    expect(usdFromGbp(67.99, FX)).toBe(86.99); // the steel-box class
  });
  it('never goes below 0.99 and survives bad input', () => {
    expect(usdFromGbp(0.5, FX)).toBe(0.99);
    expect(usdFromGbp(0, FX)).toBe(0.99);
    expect(usdFromGbp(10, 0)).toBe(0.99);
  });
});

type Call = { q: string; vars: Record<string, unknown> };

function makeAdmin(handlers: (q: string, vars: Record<string, unknown>) => unknown, calls?: Call[]): AdminGraphql {
  return (async (q: string, vars?: Record<string, unknown>) => {
    calls?.push({ q, vars: vars ?? {} });
    return handlers(q, vars ?? {});
  }) as unknown as AdminGraphql;
}

const MARKETS_RESPONSE = {
  markets: { nodes: [
    { id: 'gid://m/uk', name: 'United Kingdom', primary: true, regions: { nodes: [{ code: 'GB' }] }, catalogs: { nodes: [{ id: 'gid://cat/uk', status: 'ACTIVE', publication: { id: 'gid://pub/uk' } }] } },
    { id: 'gid://m/usca', name: 'United States and Canada', primary: false, regions: { nodes: [{ code: 'US' }, { code: 'CA' }] }, catalogs: { nodes: [{ id: 'gid://cat/usca', status: 'ACTIVE', publication: { id: 'gid://pub/usca' } }] } }
  ] }
};

describe('ensureUsPriceList', () => {
  it('adopts an existing USD price list untouched', async () => {
    const calls: Call[] = [];
    const admin = makeAdmin((q) => {
      if (q.includes('pawscoutCatalogPriceList')) return { catalog: { priceList: { id: 'gid://pl/1', currency: 'USD' } } };
      throw new Error(`unexpected: ${q.slice(0, 40)}`);
    }, calls);
    expect(await ensureUsPriceList(admin, 'gid://cat/usca')).toBe('gid://pl/1');
    expect(calls.length).toBe(1); // read only, no mutations
  });

  it('retargets a store-currency (GBP) price list to USD', async () => {
    const updates: Record<string, unknown>[] = [];
    const admin = makeAdmin((q, vars) => {
      if (q.includes('pawscoutCatalogPriceList')) return { catalog: { priceList: { id: 'gid://pl/1', currency: 'GBP' } } };
      if (q.includes('priceListUpdate')) { updates.push(vars); return { priceListUpdate: { priceList: { id: 'gid://pl/1' }, userErrors: [] } }; }
      throw new Error(`unexpected: ${q.slice(0, 40)}`);
    });
    expect(await ensureUsPriceList(admin, 'gid://cat/usca')).toBe('gid://pl/1');
    expect(updates[0]).toMatchObject({ id: 'gid://pl/1', input: { currency: 'USD' } });
  });

  it('creates a USD list with a 0% fallback adjustment when the catalog has none', async () => {
    const creates: Record<string, unknown>[] = [];
    const admin = makeAdmin((q, vars) => {
      if (q.includes('pawscoutCatalogPriceList')) return { catalog: { priceList: null } };
      if (q.includes('priceListCreate')) { creates.push(vars); return { priceListCreate: { priceList: { id: 'gid://pl/new' }, userErrors: [] } }; }
      throw new Error(`unexpected: ${q.slice(0, 40)}`);
    });
    expect(await ensureUsPriceList(admin, 'gid://cat/usca')).toBe('gid://pl/new');
    expect(creates[0].input).toMatchObject({
      currency: 'USD', catalogId: 'gid://cat/usca',
      parent: { adjustment: { type: 'PERCENTAGE_INCREASE', value: 0 } }
    });
  });
});

describe('syncUsFixedPrices', () => {
  function syncAdmin(opts: {
    fixed: { vid: string; amount: string }[];
    variants: { id: string; price: string }[];
    mutations: Record<string, unknown>[];
  }): AdminGraphql {
    return makeAdmin((q, vars) => {
      if (q.includes('pawscoutMarketCatalogs')) return MARKETS_RESPONSE;
      if (q.includes('pawscoutCatalogPriceList')) return { catalog: { priceList: { id: 'gid://pl/1', currency: 'USD' } } };
      if (q.includes('pawscoutFixedPrices') && !q.includes('Update')) return {
        priceList: { prices: { pageInfo: { hasNextPage: false }, nodes: opts.fixed.map((f) => ({ variant: { id: f.vid }, price: { amount: f.amount } })) } }
      };
      if (q.includes('pawscoutActiveVariantPrices')) return {
        productVariants: { pageInfo: { hasNextPage: false }, nodes: opts.variants }
      };
      if (q.includes('priceListFixedPricesUpdate')) { opts.mutations.push(vars); return { priceListFixedPricesUpdate: { priceList: { id: 'gid://pl/1' }, userErrors: [] } }; }
      throw new Error(`unexpected: ${q.slice(0, 60)}`);
    });
  }

  it('stamps new and changed prices, deletes stale ones, in one mutation', async () => {
    const mutations: Record<string, unknown>[] = [];
    const admin = syncAdmin({
      fixed: [
        { vid: 'gid://v/1', amount: '61.99' },  // correct already
        { vid: 'gid://v/2', amount: '80.00' },  // wrong (the Global-e era price)
        { vid: 'gid://v/gone', amount: '9.99' } // product archived since
      ],
      variants: [
        { id: 'gid://v/1', price: '47.99' },
        { id: 'gid://v/2', price: '47.99' },
        { id: 'gid://v/3', price: '10.99' }     // new variant, no fixed price yet
      ],
      mutations
    });
    const r = await syncUsFixedPrices(admin, CFG);
    expect(r).toMatchObject({ priceListId: 'gid://pl/1', stamped: 2, deleted: 1, total: 3 });
    expect(mutations.length).toBe(1);
    const m = mutations[0] as { pricesToAdd: { variantId: string; price: { amount: string; currencyCode: string } }[]; variantIdsToDelete: string[] };
    expect(m.pricesToAdd).toEqual(expect.arrayContaining([
      { variantId: 'gid://v/2', price: { amount: '61.99', currencyCode: 'USD' } },
      { variantId: 'gid://v/3', price: { amount: '13.99', currencyCode: 'USD' } }
    ]));
    expect(m.pricesToAdd.length).toBe(2); // v/1 untouched
    expect(m.variantIdsToDelete).toEqual(['gid://v/gone']);
  });

  it('a converged catalog issues no fixed-price mutations', async () => {
    const mutations: Record<string, unknown>[] = [];
    const admin = syncAdmin({
      fixed: [{ vid: 'gid://v/1', amount: '61.99' }],
      variants: [{ id: 'gid://v/1', price: '47.99' }],
      mutations
    });
    const r = await syncUsFixedPrices(admin, CFG);
    expect(r).toMatchObject({ stamped: 0, deleted: 0, total: 1 });
    expect(mutations.length).toBe(0);
  });

  it('is a no-op when no US market exists', async () => {
    const admin = makeAdmin((q) => {
      if (q.includes('pawscoutMarketCatalogs')) return { markets: { nodes: [] } };
      throw new Error('must not reach price list calls');
    });
    const r = await syncUsFixedPrices(admin, CFG);
    expect(r).toMatchObject({ priceListId: null, stamped: 0, deleted: 0, total: 0 });
  });
});
