import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore, purgeUnusedWarehouse } from '../src/tenant-store';
import { replenishWarehouse, refreshWarehouseStock } from '../src/jobs';
import { searchBackfill } from '../src/proxy/search';
import { confirmAndImport, getDetailPreferWarehouse } from '../src/proxy/import';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
import type { CjClient, CjSearchItem, CjDetail } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const CFG: TenantConfig = {
  collectionMap: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' } },
  gates: DEFAULT_GATES,
  pricing: DEFAULT_PRICING,
  floors: { ...DEFAULT_FLOORS, warehouseDepth: 3 },
  llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, // small depth keeps tests fast
  target: 12
};

function detailOf(pid: string, stock = 50): CjDetail {
  return {
    pid,
    nameEn: `Dog Toy ${pid}`,
    images: [`https://i/${pid}.jpg`],
    descriptionHtml: 'desc',
    variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: 10, sku: pid, stock }],
    listedNum: 10,
    categoryName: 'Pet Toys',
    stock
  };
}

interface CjFakeOpts { stock?: number; stockMap?: Map<string, number>; freightUsd?: number }
function fakeCj(items: CjSearchItem[], counters: { search: number; detail: number; stock: number }, opts: CjFakeOpts = {}): CjClient {
  return {
    search: async () => { counters.search++; return items; },
    detail: async (pid: string) => { counters.detail++; return detailOf(pid, opts.stock ?? 50); },
    stockByPid: async (pid: string) => {
      counters.stock++;
      if (opts.stockMap) return opts.stockMap;
      return new Map([[`v-${pid}`, opts.stock ?? 50]]);
    },
    freightEstimate: async () => (opts.freightUsd ? { priceUsd: opts.freightUsd, days: '8-12', name: 'CJPacket' } : null)
  } as unknown as CjClient;
}

// Titles must satisfy `title` relevance for both the category keyword
// ("pet toys") and the search keyword ("dog toy") used across these tests.
const items = (n: number, over: Partial<CjSearchItem> = {}) =>
  Array.from({ length: n }, (_, i): CjSearchItem => ({
    pid: `p${i}`, nameEn: `Pet Dog Toys p${i}`, image: 'https://i/x.jpg',
    sellPriceUsd: 10, listedNum: 10 + i, categoryName: 'Pet Toys', ...over
  }));

async function warehouse(store: TenantStore, pid: string, over: Partial<{ stock: number; category: string | null; title: string }> = {}): Promise<void> {
  const d = detailOf(pid, over.stock ?? 50);
  await store.putWarehouseProduct({
    cjPid: pid,
    category: over.category === undefined ? 'pet-toys' : over.category,
    title: over.title ?? d.nameEn,
    detailJson: JSON.stringify(d),
    priceUsd: 10,
    listedNum: d.listedNum,
    stock: over.stock ?? 50
  });
}

describe('TenantStore warehouse', () => {
  it('upserts, fetches, counts, and token-matches rows', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'A', { title: 'Dog Rope Toy' });
    await warehouse(store, 'B', { title: 'Cat Tunnel' });

    expect((await store.getWarehouseProduct('A'))?.title).toBe('Dog Rope Toy');
    expect(await store.countWarehouseAvailableByCategory('pet-toys')).toBe(2);

    const hits = await store.searchWarehouse(['dog', 'rope'], 10);
    expect(hits.map((r) => r.cj_pid)).toEqual(['A']);
  });

  it('low_stock rows leave search results and category counts', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'A');
    await store.setWarehouseStock('A', 2, 'low_stock');
    expect(await store.searchWarehouse(['dog'], 10)).toEqual([]);
    expect(await store.countWarehouseAvailableByCategory('pet-toys')).toBe(0);
  });

  it('purgeUnusedWarehouse drops stale never-imported rows only', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'old-unused');
    await warehouse(store, 'old-imported');
    await store.putLink({ cjPid: 'old-imported', state: 'imported', shopifyProductId: 'gid://1', handle: 'h' });
    // Backdate both rows past the cutoff (tests may write D1 directly).
    await env.DB.prepare(`UPDATE warehouse_products SET fetched_at = '2020-01-01T00:00:00Z' WHERE shop = ?1`).bind(SHOP).run();

    const dropped = await purgeUnusedWarehouse(env.DB, new Date().toISOString());
    expect(dropped).toBe(1);
    expect(await store.getWarehouseProduct('old-unused')).toBeNull();
    expect(await store.getWarehouseProduct('old-imported')).not.toBeNull();
  });
});

describe('replenishWarehouse — addon lane', () => {
  it('admits cheap items under the addon band into the hidden addons category', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const counters = { search: 0, detail: 0, stock: 0 };
    // $2 item: fails the main gate ($5-80) but fits the addon band ($1-5)
    const cheap = items(1, { sellPriceUsd: 2 });
    const cj = {
      search: async () => { counters.search++; return cheap; },
      detail: async (pid: string) => ({ ...detailOf(pid, 50), variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: 2, sku: pid, stock: 50 }] }),
      stockByPid: async (pid: string) => new Map([[`v-${pid}`, 50]]),
      freightEstimate: async () => null
    } as unknown as CjClient;
    const admitted = await replenishWarehouse(store, cj, CFG, { pause: async () => {} });
    expect(admitted).toBe(1);
    const row = await store.getWarehouseProduct('p0');
    expect(row?.category).toBe('addons');
  });

  it('addon lane is skipped when disabled and never exceeds the pool size', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cheap = items(3, { sellPriceUsd: 2 });
    const cj = {
      search: async () => cheap,
      detail: async (pid: string) => ({ ...detailOf(pid, 50), variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: 2, sku: pid, stock: 50 }] }),
      stockByPid: async (pid: string) => new Map([[`v-${pid}`, 50]]),
      freightEstimate: async () => null
    } as unknown as CjClient;
    const off = await replenishWarehouse(store, cj, { ...CFG, addons: { ...CFG.addons, enabled: false } }, { pause: async () => {} });
    expect(off).toBe(0);
    const capped = await replenishWarehouse(store, cj, { ...CFG, addons: { ...CFG.addons, poolSize: 2 } }, { pause: async () => {} });
    expect(capped).toBe(2);
  });
});

describe('replenishWarehouse', () => {
  it('admission captures origin and the cheapest freight on the stored detail', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const counters = { search: 0, detail: 0, stock: 0 };
    await replenishWarehouse(store, fakeCj(items(1), counters, { freightUsd: 3.4 }), CFG, { pause: async () => {} });
    const row = await store.getWarehouseProduct('p0');
    expect(row).not.toBeNull();
    const stored = JSON.parse(row!.detail);
    expect(stored.origin).toBe('CN'); // no per-country data in fixture → CN default
    expect(stored.freightUsd).toBe(3.4);
    expect(stored.freightDays).toBe('8-12');
  });


  it('fills a category to warehouseDepth with gated, stocked products', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const counters = { search: 0, detail: 0, stock: 0 };
    const admitted = await replenishWarehouse(store, fakeCj(items(6), counters), CFG, { pause: async () => {} });
    expect(admitted).toBe(3); // warehouseDepth
    expect(await store.countWarehouseAvailableByCategory('pet-toys')).toBe(3);
  });

  it('rejects candidates below the stock floor', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const counters = { search: 0, detail: 0, stock: 0 };
    const admitted = await replenishWarehouse(store, fakeCj(items(4), counters, { stock: 3 }), CFG, { pause: async () => {} });
    expect(admitted).toBe(0); // stock 3 < floor 10
  });

  it('prioritizes demand keywords and respects the CJ call budget', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.logSearch('rope toy', 0, 1); // under-served demand
    const counters = { search: 0, detail: 0, stock: 0 };
    // Budget of 3 CJ calls: 1 search + 1 detail admits exactly one product (detail carries stock).
    const admitted = await replenishWarehouse(store, fakeCj(items(6), counters), CFG, { pause: async () => {}, maxCjCalls: 2 });
    expect(admitted).toBe(1);
    expect(counters.search + counters.detail + counters.stock).toBeLessThanOrEqual(2);
  });

  it('skips products already warehoused or imported', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'p0');
    await store.putLink({ cjPid: 'p1', state: 'imported', shopifyProductId: 'gid://1', handle: 'h' });
    const counters = { search: 0, detail: 0, stock: 0 };
    await replenishWarehouse(store, fakeCj(items(3), counters), CFG, { pause: async () => {} });
    // p0 warehoused, p1 imported → only p2 admitted (3 total in category, incl. pre-seeded p0... count available)
    expect(await store.getWarehouseProduct('p2')).not.toBeNull();
    expect(await store.getWarehouseProduct('p1')).toBeNull();
  });
});

describe('refreshWarehouseStock', () => {
  it('re-checks stale rows and pauses under-floor products', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'A');
    await env.DB.prepare(`UPDATE warehouse_products SET stock_checked_at = '2020-01-01T00:00:00Z' WHERE shop = ?1`).bind(SHOP).run();

    const counters = { search: 0, detail: 0, stock: 0 };
    const checked = await refreshWarehouseStock(store, fakeCj([], counters, { stock: 1 }), CFG, { pause: async () => {} });
    expect(checked).toBe(1);
    const row = await store.getWarehouseProduct('A');
    expect(row?.status).toBe('low_stock');
    expect(row?.stock).toBe(1);
  });
});

describe('warehouse-first search', () => {
  it('serves a warmed warehouse with ZERO CJ calls', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const pid of ['A', 'B', 'C']) await warehouse(store, pid);
    const counters = { search: 0, detail: 0, stock: 0 };
    const cards = await searchBackfill(store, fakeCj(items(5), counters), CFG, 'dog toy', 0, 3);
    expect(cards).toHaveLength(3);
    expect(counters.search).toBe(0); // CJ untouched
    expect(cards[0].price).toBe(19.99);
  });

  it('falls back to CJ only when the warehouse cannot fill the grid', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'A');
    const counters = { search: 0, detail: 0, stock: 0 };
    const cards = await searchBackfill(store, fakeCj(items(5), counters), CFG, 'dog toy', 0, 4);
    expect(cards.length).toBe(4);
    expect(counters.search).toBe(1);
    expect(new Set(cards.map((c) => c.pid)).size).toBe(4); // no duplicates across sources
  });

  it('excludes under-stocked warehouse rows', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'A', { stock: 2 }); // below stockFloor 10
    const counters = { search: 0, detail: 0, stock: 0 };
    const cards = await searchBackfill(store, fakeCj([], counters), CFG, 'dog toy', 0, 3);
    expect(cards).toEqual([]);
  });
});

describe('preview + confirmAndImport', () => {
  const adminOk = (calls: string[]): AdminGraphql => async (query) => {
    calls.push(query);
    if (query.includes('productSet')) return { productSet: { product: { id: 'gid://shopify/Product/9', handle: 'dog-toy-a' }, userErrors: [] } };
    if (query.includes('publications(')) return { publications: { nodes: [{ id: 'gid://p/1', name: 'Online Store' }] } };
    if (query.includes('publishablePublish')) return { publishablePublish: { userErrors: [] } };
    return { productUpdate: { product: { id: 'x' }, userErrors: [] } };
  };

  it('getDetailPreferWarehouse reads the warehouse without CJ', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'A');
    const counters = { search: 0, detail: 0, stock: 0 };
    const d = await getDetailPreferWarehouse(store, fakeCj([], counters), 'A');
    expect(d?.nameEn).toBe('Dog Toy A');
    expect(counters.detail).toBe(0);
  });

  it('imports when the live stock confirmation passes, updating the warehouse row', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'A');
    const counters = { search: 0, detail: 0, stock: 0 };
    const calls: string[] = [];
    await confirmAndImport(store, fakeCj([], counters, { stock: 40 }), adminOk(calls), CFG, detailOf('A'));
    expect(counters.stock).toBe(1);
    expect((await store.getLink('A'))?.state).toBe('imported');
    expect((await store.getWarehouseProduct('A'))?.stock).toBe(40);
  });

  it('blocks the import when live stock is below the floor', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await warehouse(store, 'A');
    const counters = { search: 0, detail: 0, stock: 0 };
    const calls: string[] = [];
    await confirmAndImport(store, fakeCj([], counters, { stock: 2 }), adminOk(calls), CFG, detailOf('A'));
    expect(calls).toEqual([]); // Shopify never touched
    expect((await store.getLink('A'))?.state).toBe('failed');
    expect((await store.getWarehouseProduct('A'))?.status).toBe('low_stock');
  });

  it('curation gate rejects an off-category ghost import before Shopify is touched', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const counters = { search: 0, detail: 0, stock: 0 };
    const calls: string[] = [];
    const curate = async () => ({ relevanceScore: 12, title: 'Vacuum Sealer', descriptionHtml: '<p>x</p>', category: null, petClass: 'other' as const });
    await confirmAndImport(store, fakeCj([], counters, { stock: 40 }), adminOk(calls), CFG, detailOf('A'), undefined, curate);
    expect(calls).toEqual([]); // never reached Shopify
    expect((await store.getLink('A'))?.state).toBe('failed');
  });

  it('curation rewrites the title on a passing ghost import and skips pre-curated details', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const counters = { search: 0, detail: 0, stock: 0 };
    const calls: Array<{ q: string; v?: Record<string, unknown> }> = [];
    const admin: AdminGraphql = async (q, v) => {
      calls.push({ q, v });
      if (q.includes('productSet')) return { productSet: { product: { id: 'gid://shopify/Product/9', handle: 'h' }, userErrors: [] } };
      if (q.includes('publications(')) return { publications: { nodes: [] } };
      if (q.includes('metafieldsSet')) return { metafieldsSet: { userErrors: [] } };
      return { productUpdate: { product: { id: 'x' }, userErrors: [] } };
    };
    let curateCalls = 0;
    const curate = async () => { curateCalls++; return { relevanceScore: 90, title: 'Tough Dog Rope Toy', descriptionHtml: '<p>good</p>', category: null, petClass: 'dog' as const }; };
    await confirmAndImport(store, fakeCj([], counters, { stock: 40 }), admin, CFG, detailOf('A'), undefined, curate);
    const set = calls.find((c) => c.q.includes('productSet'))!;
    expect((set.v!.input as { title: string }).title).toBe('Tough Dog Rope Toy');
    expect(curateCalls).toBe(1);

    // already-curated detail (llmScore present) must NOT be re-scored
    await confirmAndImport(store, fakeCj([], counters, { stock: 40 }), admin, CFG, { ...detailOf('B'), llmScore: 88 }, undefined, curate);
    expect(curateCalls).toBe(1);
  });

  it('proceeds on a stock-endpoint failure (unknown ≠ unavailable)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cj = { stockByPid: async () => { throw new Error('CJ down'); } } as unknown as CjClient;
    const calls: string[] = [];
    await confirmAndImport(store, cj, adminOk(calls), CFG, detailOf('A'));
    expect((await store.getLink('A'))?.state).toBe('imported');
  });
});
