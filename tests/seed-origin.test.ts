import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { TenantStore } from '../src/tenant-store';
import { seedOriginAssortment, reconcileDraftLinks, MARKET_SEED_LANES, US_SEED_KEYWORDS, SEED_KEYWORDS } from '../src/jobs';
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
    const cached = JSON.parse(wh!.detail);
    expect(cached.origins.GB).toBe(40);   // origins cached for Phase-2 geo-ranking
    // The cached detail is confirmAndImport's ENRICHED copy: the freight the gates
    // judged is persisted (KNOWN 0 here, not absent), so the nightly cost sync is
    // freight-aware for this product from day one (freight-blind audit gap fix).
    expect(cached.freightUsd).toBe(0);
    expect(cached.origin).toBe('GB');
  });

  it('filters out-of-price-band candidates (liveCjPasses gate) before drafting', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cj = {
      searchByWarehouse: async (): Promise<CjSearchItem[]> => ([
        { pid: 'GBOK', nameEn: 'Dog Chew Toy', image: '', sellPriceUsd: 6, listedNum: 20, categoryName: 'pet-toys' },
        { pid: 'GBHI', nameEn: 'Dog Chew Toy', image: '', sellPriceUsd: 200, listedNum: 20, categoryName: 'pet-toys' } // over priceMax 80
      ]),
      detail: async (pid: string): Promise<CjDetail> => ({ pid, nameEn: 'Dog Chew Toy', images: ['https://img/x.jpg'], descriptionHtml: 'x', variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: 6, sku: pid, stock: 50 }], listedNum: 20, categoryName: 'pet-toys', stock: 50, origins: { CN: 100, GB: 40 } }),
      stockByPid: async () => new Map([['v-GBOK', 50]]),
      freightEstimate: async () => ({ priceUsd: 0, days: '2-5', name: 'Royal Mail' })
    } as unknown as CjClient;

    const summary = await seedOriginAssortment(store, cj, fakeAdmin(), CFG, { countryCode: 'GB', perCollection: 12, pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });

    expect(summary.drafted).toBe(1);                          // only the in-band item
    expect((await store.getLink('GBOK'))?.state).toBe('draft');
    expect(await store.getLink('GBHI')).toBeNull();           // out-of-band filtered, never processed
    expect(await store.getWarehouseProduct('GBHI')).toBeNull();
  });

  it('skips a pid that is already linked', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.putLink({ cjPid: 'GB1', state: 'imported', shopifyProductId: 'gid://x', category: 'pet-toys' });
    const summary = await seedOriginAssortment(store, fakeCj(), fakeAdmin(), CFG, { pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });
    expect(summary.discovered).toBe(0);
    expect(summary.drafted).toBe(0);
  });
});

// --- Market fill lanes (owner's local-for-local model, 2026-07-05) ---

describe('seedOriginAssortment - US market lane', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

  // US-warehoused, NOT GB-warehoused: the exact profile of a US-market candidate.
  function usCj(searchedCountries: string[] = []): CjClient {
    return {
      searchByWarehouse: async (_kw: string, cc: string): Promise<CjSearchItem[]> => {
        searchedCountries.push(cc);
        return [{ pid: 'US1', nameEn: 'Dog Chew Toy', image: '', sellPriceUsd: 6, listedNum: 20, categoryName: 'pet-toys' }];
      },
      detail: async (pid: string): Promise<CjDetail> => ({ pid, nameEn: 'Dog Chew Toy', images: ['https://img/x.jpg'], descriptionHtml: 'x', variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: 6, sku: pid, stock: 50 }], listedNum: 20, categoryName: 'pet-toys', stock: 50, origins: { CN: 100, US: 230 } }),
      stockByPid: async () => new Map([['v-US1', 50]]),
      freightEstimate: async () => ({ priceUsd: 0, days: '2-5', name: 'USPS' })
    } as unknown as CjClient;
  }

  function taggingAdmin(tagSink: string[][]): AdminGraphql {
    return (async (q: string, vars: any) => {
      if (q.includes('productSet')) {
        tagSink.push((vars.input as { tags: string[] }).tags);
        return { productSet: { product: { id: 'gid://shopify/Product/1', handle: 'h' }, userErrors: [] } };
      }
      if (q.includes('locations') || q.includes('location')) return { locations: { nodes: [{ id: 'loc1' }] } };
      return {};
    }) as unknown as AdminGraphql;
  }

  it('drafts a US-warehoused product through the US lane gate, tagged market-us', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const searched: string[] = [];
    const tags: string[][] = [];
    const summary = await seedOriginAssortment(store, usCj(searched), taggingAdmin(tags), CFG,
      { countryCode: 'US', perCollection: 12, pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });

    expect(searched).toEqual(['US']);                       // discovery hits the US warehouse
    expect(summary.drafted).toBe(1);
    expect((await store.getLink('US1'))?.state).toBe('draft');
    expect(tags[0]).toContain('market-us');                 // owner can filter US drafts in admin
    const wh = await store.getWarehouseProduct('US1');
    expect(JSON.parse(wh!.detail).origins.US).toBe(230);    // per-buyer search filters read this
  });

  it('the SAME product is blocked by the default home (GB) lane - lanes never leak', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const summary = await seedOriginAssortment(store, usCj(), fakeAdmin(), CFG,
      { countryCode: 'GB', perCollection: 12, pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });
    expect(summary.drafted).toBe(0);
    expect(summary.rejected).toBe(1);
    expect((await store.getLink('US1'))?.state).toBe('failed'); // gate fails closed: no GB stock
  });

  it('maxDrafts paces a nightly lane', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // Distinct title signatures (the seed dedupes near-twins by design).
    const names: Record<string, string> = { USA: 'Dog Chew Toy Rope Braided Large', USB: 'Dog Chew Toy Ball Squeaky Rubber', USC: 'Dog Chew Toy Bone Nylon Tough' };
    const cj = {
      searchByWarehouse: async (): Promise<CjSearchItem[]> => (
        Object.keys(names).map((pid) => ({ pid, nameEn: names[pid], image: '', sellPriceUsd: 6, listedNum: 20, categoryName: 'pet-toys' }))
      ),
      detail: async (pid: string): Promise<CjDetail> => ({ pid, nameEn: names[pid], images: ['https://img/x.jpg'], descriptionHtml: 'x', variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: 6, sku: pid, stock: 50 }], listedNum: 20, categoryName: 'pet-toys', stock: 50, origins: { US: 90 } }),
      stockByPid: async () => new Map([['v', 50]]),
      freightEstimate: async () => null
    } as unknown as CjClient;
    const summary = await seedOriginAssortment(store, cj, fakeAdmin(), CFG,
      { countryCode: 'US', maxDrafts: 2, pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });
    expect(summary.drafted).toBe(2); // stopped by the nightly cap, not supply
  });
});

// --- US lane bulky-niche gate (2026-07-07) ---
// The generic keyword set went 0-for-35 on US street parity (CJ US-warehouse
// cost >= Amazon/Walmart retail for small commodity goods), so the US lane
// now carries its own keywords + a widened price band. These tests pin the
// lane wiring and prove the override does the filtering the review did by hand.

describe('US lane bulky-niche gate', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

  it('MARKET_SEED_LANES wires the US lane to bulky keywords and the widened band', () => {
    const us = MARKET_SEED_LANES.find((l) => l.countryCode === 'US')!;
    expect(us.keywords).toBe(US_SEED_KEYWORDS);
    expect(us.gateOverrides).toMatchObject({ priceMin: 25, priceMax: 200 });
    // every US keyword bucket is a real collection key the importer can tag into
    for (const k of Object.keys(US_SEED_KEYWORDS)) {
      expect(Object.keys(SEED_KEYWORDS)).toContain(k);
    }
  });

  it('the lane band admits the steel-box class the global band blocked, and still kills commodity items', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const CFG2 = { ...CFG, collectionMap: { ...CFG.collectionMap, 'pet-cleaning': { tag: 'pet-cleaning' } } };
    const items: Record<string, { name: string; usd: number }> = {
      BOX: { name: 'Stainless Steel Cat Litter Box With Lid Extra Large', usd: 96.5 }, // over global priceMax 80
      SCOOP: { name: 'Stainless Steel Litter Box Scoop', usd: 6 }                      // relevance-passing commodity
    };
    const cj = {
      searchByWarehouse: async (): Promise<CjSearchItem[]> => (
        Object.keys(items).map((pid) => ({ pid, nameEn: items[pid].name, image: '', sellPriceUsd: items[pid].usd, listedNum: 20, categoryName: 'pet-cleaning' }))
      ),
      detail: async (pid: string): Promise<CjDetail> => ({ pid, nameEn: items[pid].name, images: ['https://img/x.jpg'], descriptionHtml: 'x', variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: items[pid].usd, sku: pid, stock: 50 }], listedNum: 20, categoryName: 'pet-cleaning', stock: 50, origins: { US: 148 } }),
      stockByPid: async () => new Map([['v-BOX', 50]]),
      freightEstimate: async () => null
    } as unknown as CjClient;

    const summary = await seedOriginAssortment(store, cj, fakeAdmin(), CFG2, {
      countryCode: 'US', pause: async () => {},
      keywords: { 'pet-cleaning': ['stainless steel litter box'] },
      gates: { ...CFG.gates, priceMin: 25, priceMax: 200 }
    });

    expect(summary.drafted).toBe(1);
    expect((await store.getLink('BOX'))?.state).toBe('draft');   // $96.5: in the lane band, out of the global one
    expect(await store.getLink('SCOOP')).toBeNull();             // $6 commodity: filtered before any CJ detail call
  });

  it('without the override the same steel box is blocked by the global band (the pre-tune behavior)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const CFG2 = { ...CFG, collectionMap: { ...CFG.collectionMap, 'pet-cleaning': { tag: 'pet-cleaning' } } };
    const cj = {
      searchByWarehouse: async (): Promise<CjSearchItem[]> => ([
        { pid: 'BOX', nameEn: 'Stainless Steel Cat Litter Box With Lid Extra Large', image: '', sellPriceUsd: 96.5, listedNum: 20, categoryName: 'pet-cleaning' }
      ]),
      detail: async (): Promise<CjDetail> => { throw new Error('must not fetch detail for a gated-out item'); },
      stockByPid: async () => new Map(),
      freightEstimate: async () => null
    } as unknown as CjClient;

    const summary = await seedOriginAssortment(store, cj, fakeAdmin(), CFG2, {
      countryCode: 'US', pause: async () => {},
      keywords: { 'pet-cleaning': ['stainless steel litter box'] }
    });

    expect(summary.drafted).toBe(0);
    expect(await store.getLink('BOX')).toBeNull();
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
