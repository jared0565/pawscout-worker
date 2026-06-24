import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { TenantStore } from '../src/tenant-store';
import { seedOriginAssortment, reconcileDraftLinks } from '../src/jobs';
import type { CjClient, CjDetail, CjSearchItem } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';

const SHOP = 'test.myshopify.com';
// minimal config with one collection; mirror the config builder used in tests/jobs.test.ts
const CFG: any = { collectionMap: { 'pet-toys': { tag: 'pet-toys' } }, gates: { popularityFloor: 0, priceMin: 0.5, priceMax: 80, relevance: 'strict' }, floors: { warehouseDepth: 20, storeFloor: 8, stockFloor: 10 }, pricing: { multiplier: 2.7, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2 }, llm: { enabled: false, scoreThreshold: 60 }, addons: { enabled: false }, target: 12 };

function fakeCj(stockOverride?: Map<string, number>): CjClient {
  const detail = (pid: string, name: string): CjDetail => ({ pid, nameEn: name, images: ['https://img/x.jpg'], descriptionHtml: 'x', variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: 6, sku: pid, stock: 50 }], listedNum: 20, categoryName: 'pet-toys', stock: 50, origins: { CN: 100, GB: 40 } });
  return {
    searchByWarehouse: async (kw: string): Promise<CjSearchItem[]> => ([
      { pid: 'GB1', nameEn: 'Dog Chew Toy', image: '', sellPriceUsd: 6, listedNum: 20, categoryName: 'pet-toys' },
      { pid: 'GB1', nameEn: 'Dog Chew Toy', image: '', sellPriceUsd: 6, listedNum: 20, categoryName: 'pet-toys' } // dup pid
    ]),
    detail: async (pid: string) => detail(pid, 'Dog Chew Toy'),
    stockByPid: async () => stockOverride ?? new Map([['v-GB1', 50]]),
    freightEstimate: async () => ({ priceUsd: 0, days: '2-5', name: 'Royal Mail' })
  } as unknown as CjClient;
}

function fakeAdmin(): AdminGraphql {
  return (async (q: string) => {
    if (q.includes('productSet')) return { productSet: { product: { id: 'gid://shopify/Product/1', handle: 'h' }, userErrors: [] } };
    if (q.includes('locations') || q.includes('location')) return { locations: { nodes: [{ id: 'loc1' }] } };
    return {};
  }) as unknown as AdminGraphql;
}

describe('seedOriginAssortment', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

  it('does NOT cache a warehouse row when confirmAndImport rejects the candidate (live-stock gate)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // stockByPid returns below the stockFloor (10) so the live-stock gate in confirmAndImport rejects
    const lowStock = new Map([['v-GB1', 2]]);
    const summary = await seedOriginAssortment(store, fakeCj(lowStock), fakeAdmin(), CFG, { countryCode: 'GB', perCollection: 12, pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });

    expect(summary.drafted).toBe(0);
    expect(summary.rejected).toBe(1);
    // rejected candidate must NOT pollute warehouse_products
    expect(await store.getWarehouseProduct('GB1')).toBeNull();
  });

  it('discovers GB candidates, dedupes pids, caches origins, and DRAFT-imports', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const summary = await seedOriginAssortment(store, fakeCj(), fakeAdmin(), CFG, { countryCode: 'GB', perCollection: 12, pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });

    expect(summary.discovered).toBe(1);        // duplicate pid counted once
    expect(summary.drafted).toBe(1);
    expect((await store.getLink('GB1'))?.state).toBe('draft');
    const wh = await store.getWarehouseProduct('GB1');
    expect(wh).not.toBeNull();
    expect(JSON.parse(wh!.detail).origins.GB).toBe(40);   // origins cached for Phase-2 geo-ranking
  });

  it('skips a pid that is already linked', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.putLink({ cjPid: 'GB1', state: 'imported', shopifyProductId: 'gid://x', category: 'pet-toys' });
    const summary = await seedOriginAssortment(store, fakeCj(), fakeAdmin(), CFG, { pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });
    expect(summary.discovered).toBe(0);
    expect(summary.drafted).toBe(0);
  });
});

describe('reconcileDraftLinks', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

  it('flips only published (ACTIVE) drafts to imported', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.putLink({ cjPid: 'A', state: 'draft', shopifyProductId: 'gid://shopify/Product/A', category: 'pet-toys' });
    await store.putLink({ cjPid: 'B', state: 'draft', shopifyProductId: 'gid://shopify/Product/B', category: 'pet-toys' });
    const admin = (async (_q: string, vars: any) => ({
      product: { status: vars.id.endsWith('/A') ? 'ACTIVE' : 'DRAFT' }
    })) as unknown as AdminGraphql;

    const flipped = await reconcileDraftLinks(store, admin);

    expect(flipped).toBe(1);
    expect((await store.getLink('A'))?.state).toBe('imported');
    expect((await store.getLink('B'))?.state).toBe('draft');
  });
});
