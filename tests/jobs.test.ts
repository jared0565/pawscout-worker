import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { cullStaleProducts, refillCollections, syncStoreInventory, resyncLowStockInventory, seedSemanticLibrary, sellableQty, LOW_STOCK_BAND, LOW_STOCK_RESERVE } from '../src/jobs';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX, DEFAULT_SEMANTIC, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail } from '../src/cj';
import type { LlmClient } from '../src/llm';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const DAY = 86400_000;

// Tests write rows directly so they can backdate timestamps (the store API
// always stamps "now"); production code still goes through TenantStore only.
async function insertLink(cjPid: string, state: string, createdAgoDays: number, stockPaused = 0): Promise<void> {
  const ts = new Date(Date.now() - createdAgoDays * DAY).toISOString();
  await env.DB.prepare(
    `INSERT INTO product_links (shop, cj_pid, shopify_product_id, handle, category, state, stock_paused, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?7)`
  ).bind(SHOP, cjPid, `gid://shopify/Product/${cjPid}`, `h-${cjPid}`, state, stockPaused, ts).run();
}

async function insertEvent(cjPid: string, event: string, agoDays: number): Promise<void> {
  const ts = new Date(Date.now() - agoDays * DAY).toISOString();
  await env.DB.prepare(`INSERT INTO product_events (shop, cj_pid, event, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(SHOP, cjPid, event, ts).run();
}

function detailOf(pid: string, stock = 50, costUsd = 10): CjDetail {
  return {
    pid,
    nameEn: `Pet Toys ${pid}`,
    images: ['https://i/1.jpg'],
    descriptionHtml: 'desc',
    variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: costUsd, sku: `sku-${pid}`, stock }],
    listedNum: 10,
    categoryName: 'Pet Toys',
    stock,
    // local-for-local (2026-07-05): promotion/import requires proven
    // home-local warehouse stock; the fixture is GB-stocked.
    origins: stock > 0 ? { GB: stock } : undefined
  };
}

async function seedWarehouse(store: TenantStore, pid: string, category: string, stock = 50): Promise<void> {
  const d = detailOf(pid, stock);
  await store.putWarehouseProduct({
    cjPid: pid, category, title: d.nameEn, detailJson: JSON.stringify(d),
    priceUsd: 10, listedNum: d.listedNum, stock
  });
}

interface Call { query: string; variables?: Record<string, unknown> }

function shopAdmin(calls: Call[], currentPrice = '99.99', tracked = true): AdminGraphql {
  return async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('inventoryItemUpdate')) return { inventoryItemUpdate: { userErrors: [] } };
    if (query.includes('productUpdate')) return { productUpdate: { product: { id: 'x' }, userErrors: [] } };
    if (query.includes('productSet')) {
      const title = (variables!.input as { title: string }).title;
      return { productSet: { product: { id: `gid://shopify/Product/${title}`, handle: title.toLowerCase().replace(/\s+/g, '-') }, userErrors: [] } };
    }
    if (query.includes('publications(')) return { publications: { nodes: [{ id: 'gid://p/1', name: 'Online Store' }] } };
    if (query.includes('publishablePublish')) return { publishablePublish: { userErrors: [] } };
    if (query.includes('pawscoutLocation')) return { location: { id: 'gid://shopify/Location/1' } };
    if (query.includes('pawscoutVariants')) {
      return { product: { variants: { nodes: [{ id: 'gid://v/1', sku: (variables!.id as string).includes('A') ? 'sku-A' : 'sku-x', price: currentPrice, inventoryItem: { id: 'gid://inv/1', tracked } }] } } };
    }
    if (query.includes('productVariantsBulkUpdate')) return { productVariantsBulkUpdate: { userErrors: [] } };
    if (query.includes('inventorySetQuantities')) return { inventorySetQuantities: { userErrors: [] } };
    if (query.includes('metafieldsSet')) return { metafieldsSet: { userErrors: [] } };
    if (query.includes('tagsAdd')) return { tagsAdd: { userErrors: [] } };
    if (query.includes('tagsRemove')) return { tagsRemove: { userErrors: [] } };
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  };
}

function stockCj(stock: number, counters = { search: 0, stock: 0 }): CjClient {
  return {
    search: async () => { counters.search++; return []; },
    searchByWarehouse: async () => { counters.search++; return []; },
    stockByPid: async (pid: string) => { counters.stock++; return new Map([[`v-${pid}`, stock]]); },
    originsByPid: async () => (stock > 0 ? { GB: stock } : {})
  } as unknown as CjClient;
}

describe('cullStaleProducts', () => {
  it('archives only old products with no qualifying events in the window', async () => {
    await insertLink('stale', 'imported', 45);          // old, silent → archive
    await insertLink('fresh', 'imported', 5);           // grace period → keep
    await insertLink('active', 'imported', 45);         // old but viewed recently → keep
    await insertEvent('active', 'view', 3);
    await insertLink('sold', 'imported', 45);           // old but ATC in window → keep
    await insertEvent('sold', 'atc', 20);
    await insertLink('ghost', 'ghost', 45);             // never imported → not cull's business
    await insertLink('paused', 'imported', 45, 1);      // W2: stock-paused → exempt

    const store = new TenantStore(env.DB, SHOP);
    const archived: string[] = [];
    const admin: AdminGraphql = async (query, variables) => {
      archived.push((variables!.input as { id: string }).id);
      return { productUpdate: { product: { id: 'x' }, userErrors: [] } };
    };
    const n = await cullStaleProducts(store, admin);

    expect(n).toBe(1);
    expect(archived).toEqual(['gid://shopify/Product/stale']);
    expect((await store.getLink('paused'))?.state).toBe('imported'); // exempt while unsellable
    expect((await store.getLink('active'))?.state).toBe('imported');
  });
});

describe('refillCollections (promote-from-warehouse)', () => {
  const CFG: TenantConfig = {
    collectionMap: {
      'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' },
      'pet-health': { handle: 'pet-health', tag: 'cj-pet-health' }
    },
    gates: DEFAULT_GATES,
    pricing: DEFAULT_PRICING,
    floors: { ...DEFAULT_FLOORS, storeFloor: 1 },
    llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX,
    target: 2
  };

  it('promotes from the warehouse with zero CJ searches (stock confirms only)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const pid of ['A', 'B', 'C']) await seedWarehouse(store, pid, 'pet-toys');
    const counters = { search: 0, stock: 0 };
    const n = await refillCollections(store, stockCj(50, counters), shopAdmin([]), { ...CFG, collectionMap: { 'pet-toys': CFG.collectionMap['pet-toys'] } }, { pause: async () => {} });
    expect(n).toBe(2); // target
    expect(counters.search).toBe(0);
    expect(counters.stock).toBe(2); // one live confirm per promotion
    expect(await store.countImportedByCategory('pet-toys')).toBe(2);
  });

  it('raises every category to the floor before topping any up to target', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const pid of ['T1', 'T2', 'T3']) await seedWarehouse(store, pid, 'pet-toys');
    for (const pid of ['H1', 'H2', 'H3']) await seedWarehouse(store, pid, 'pet-health');
    // Cap of 2: a target-first strategy would put both in pet-toys.
    const n = await refillCollections(store, stockCj(50), shopAdmin([]), CFG, { pause: async () => {}, maxImports: 2 });
    expect(n).toBe(2);
    expect(await store.countImportedByCategory('pet-toys')).toBe(1);
    expect(await store.countImportedByCategory('pet-health')).toBe(1);
  });

  it('skips warehouse rows below the stock floor', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'low', 'pet-toys', 2);
    const n = await refillCollections(store, stockCj(50), shopAdmin([]), CFG, { pause: async () => {} });
    expect(n).toBe(0);
  });

  it('a failed live stock confirm blocks the promotion', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'A', 'pet-toys'); // row says 50…
    const n = await refillCollections(store, stockCj(1), shopAdmin([]), CFG, { pause: async () => {} }); // …CJ says 1
    expect(n).toBe(0);
    expect((await store.getLink('A'))?.state).toBe('failed');
  });

  it('refillCollections never promotes a draft-state link', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // seed a warehouse row for category pet-toys + a draft link for it
    await store.putWarehouseProduct({ cjPid: 'D1', category: 'pet-toys', title: 'Cat Toy', detailJson: JSON.stringify({ pid: 'D1', nameEn: 'Cat Toy', images: [], descriptionHtml: '', variants: [{ vid: 'V', name: 'Default', sellPriceUsd: 6, sku: 'S', stock: 50 }], listedNum: 5, categoryName: 'pet-toys', stock: 50 }), priceUsd: 6, listedNum: 5, stock: 50 });
    await store.putLink({ cjPid: 'D1', state: 'draft', shopifyProductId: 'gid://shopify/Product/9', category: 'pet-toys' });
    const admin = (async () => ({})) as unknown as AdminGraphql;
    const cj = { stockByPid: async () => new Map([['V', 50]]) } as unknown as CjClient;

    await refillCollections(store, cj, admin, CFG, { maxImports: 5 });

    // the draft link is untouched (still draft, not re-imported/published)
    expect((await store.getLink('D1'))?.state).toBe('draft');
  });
});

describe('syncStoreInventory', () => {
  const CFG: TenantConfig = {
    collectionMap: {},
    gates: DEFAULT_GATES,
    pricing: DEFAULT_PRICING,
    floors: DEFAULT_FLOORS,
  llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX,
    target: 12
  };

  it('zeroes + pauses an under-floor product and writes supplier metafields', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    await seedWarehouse(store, 'A', 'pet-toys');

    const calls: Call[] = [];
    const n = await syncStoreInventory(store, stockCj(3), shopAdmin(calls), CFG, { pause: async () => {} });
    expect(n).toBe(1);

    const inv = calls.find((c) => c.query.includes('inventorySetQuantities'))!;
    const quantities = (inv.variables!.input as { quantities: { quantity: number }[] }).quantities;
    expect(quantities.every((q) => q.quantity === 0)).toBe(true);

    const meta = calls.find((c) => c.query.includes('metafieldsSet'))!;
    const fields = meta.variables!.metafields as { key: string; value: string }[];
    expect(fields.find((f) => f.key === 'status')?.value).toBe('out_of_stock');
    expect(fields.find((f) => f.key === 'available_qty')?.value).toBe('3');

    expect((await store.getLink('A'))?.stock_paused).toBe(1);
    expect((await store.getWarehouseProduct('A'))?.status).toBe('low_stock');
  });

  it('holds back the low-band reserve so the race-prone last unit is never sold', async () => {
    // CJ stock is shared across every CJ merchant; in the low band we sell one
    // fewer than CJ reports. Stock 10 (== stockFloor, so NOT paused) -> sellable 9.
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    await seedWarehouse(store, 'A', 'pet-toys');

    const calls: Call[] = [];
    await syncStoreInventory(store, stockCj(10), shopAdmin(calls), CFG, { pause: async () => {} });

    const inv = calls.find((c) => c.query.includes('inventorySetQuantities'))!;
    expect((inv.variables!.input as { quantities: { quantity: number }[] }).quantities[0].quantity).toBe(9);
    const meta = calls.find((c) => c.query.includes('metafieldsSet'))!;
    const fields = meta.variables!.metafields as { key: string; value: string }[];
    expect(fields.find((f) => f.key === 'available_qty')?.value).toBe('9'); // theme fallback shows sellable too
    expect((await store.getLink('A'))?.stock_paused).toBe(0); // reserve is not a pause
  });

  it('sellableQty: full above the band, minus reserve inside it, never negative', () => {
    expect(LOW_STOCK_BAND).toBe(10);
    expect(LOW_STOCK_RESERVE).toBe(1);
    expect(sellableQty(0)).toBe(0);
    expect(sellableQty(-3)).toBe(0);
    expect(sellableQty(1)).toBe(0);  // the last unit is never sold
    expect(sellableQty(2)).toBe(1);
    expect(sellableQty(10)).toBe(9);
    expect(sellableQty(11)).toBe(11); // above the band: untouched
    expect(sellableQty(466)).toBe(466);
  });

  it('sets the demand metafield from REAL order events only (selling_fast at 3+/7d, else none)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    await seedWarehouse(store, 'A', 'pet-toys');
    await insertEvent('A', 'order', 1);
    await insertEvent('A', 'order', 2);
    await insertEvent('A', 'order', 3);
    await insertEvent('A', 'order', 20); // outside the 7-day window: ignored

    const calls: Call[] = [];
    await syncStoreInventory(store, stockCj(40), shopAdmin(calls), CFG, { pause: async () => {} });
    const meta = calls.find((c) => c.query.includes('metafieldsSet'))!;
    const fields = meta.variables!.metafields as { key: string; value: string }[];
    expect(fields.find((f) => f.key === 'demand')?.value).toBe('selling_fast');
  });

  it('demand clears to none when recent orders are below the bar (and for paused products)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    await seedWarehouse(store, 'A', 'pet-toys');
    await insertEvent('A', 'order', 1);
    await insertEvent('A', 'order', 2); // only 2 in-window: below the bar of 3

    const calls: Call[] = [];
    await syncStoreInventory(store, stockCj(40), shopAdmin(calls), CFG, { pause: async () => {} });
    const meta = calls.find((c) => c.query.includes('metafieldsSet'))!;
    const fields = meta.variables!.metafields as { key: string; value: string }[];
    expect(fields.find((f) => f.key === 'demand')?.value).toBe('none');
  });

  it('resyncLowStockInventory re-syncs ONLY the low-band items (fast 15-min path)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    await insertLink('B', 'imported', 5);
    await seedWarehouse(store, 'A', 'pet-toys', 4);  // low band -> re-synced
    await seedWarehouse(store, 'B', 'pet-toys', 50); // healthy -> skipped
    const calls: Call[] = [];
    const n = await resyncLowStockInventory(store, stockCj(4), shopAdmin(calls), CFG, { pause: async () => {} });
    expect(n).toBe(1); // only A
    const invCalls = calls.filter((c) => c.query.includes('inventorySetQuantities'));
    expect(invCalls).toHaveLength(1);
    // stock 4 < stockFloor 10 -> paused -> zeroed (the normal floor rule still applies)
    expect((invCalls[0].variables!.input as { quantities: { quantity: number }[] }).quantities[0].quantity).toBe(0);
  });

  it('resyncLowStockInventory is free when nothing is in the low band', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('B', 'imported', 5);
    await seedWarehouse(store, 'B', 'pet-toys', 50);
    const calls: Call[] = [];
    const n = await resyncLowStockInventory(store, stockCj(50), shopAdmin(calls), CFG, { pause: async () => {} });
    expect(n).toBe(0);
    expect(calls).toHaveLength(0); // no Shopify calls at all
  });

  it('restores quantities per-variant via the SKU↔vid map when stock recovers', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5, 1); // currently paused
    await seedWarehouse(store, 'A', 'pet-toys');

    const calls: Call[] = [];
    await syncStoreInventory(store, stockCj(40), shopAdmin(calls), CFG, { pause: async () => {} });

    const inv = calls.find((c) => c.query.includes('inventorySetQuantities'))!;
    const quantities = (inv.variables!.input as { quantities: { quantity: number }[] }).quantities;
    expect(quantities[0].quantity).toBe(40); // sku-A ↔ v-A mapped exactly
    expect((await store.getLink('A'))?.stock_paused).toBe(0);
  });

  it('reprices variants from fresh CJ cost under the pricing rule', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    const cj = {
      detail: async (pid: string) => detailOf(pid, 40, 10), // $10 cost -> £19.99 expected
      stockByPid: async () => new Map<string, number>()
    } as unknown as CjClient;

    const calls: Call[] = [];
    await syncStoreInventory(store, cj, shopAdmin(calls, '53.90'), CFG, { pause: async () => {} });

    const reprice = calls.find((c) => c.query.includes('productVariantsBulkUpdate'))!;
    expect(reprice).toBeDefined();
    expect((reprice.variables!.variants as { price: string }[])[0].price).toBe('19.99');
    // stock came from the detail payload - no separate stock call needed
    const inv = calls.find((c) => c.query.includes('inventorySetQuantities'))!;
    expect((inv.variables!.input as { quantities: { quantity: number }[] }).quantities[0].quantity).toBe(40);
  });

  it('reprices from STORED cost when the fresh CJ detail fetch fails (unfreezes the catalogue)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    await seedWarehouse(store, 'A', 'pet-toys', 40); // stored detail carries sku-A @ $10 cost
    const cj = {
      detail: async () => { throw new Error('CJ detail unavailable'); }, // fresh fetch fails
      stockByPid: async () => new Map<string, number>([['v-A', 40]])
    } as unknown as CjClient;

    const calls: Call[] = [];
    await syncStoreInventory(store, cj, shopAdmin(calls, '53.90'), CFG, { pause: async () => {} });

    // Without the stored-cost fallback, skuToCost is empty on a failed fetch and the price
    // stays frozen at 53.90. With it, the sync realigns to the current rule ($10 -> £19.99).
    const reprice = calls.find((c) =>
      c.query.includes('productVariantsBulkUpdate') &&
      Array.isArray((c.variables as { variants?: unknown })?.variants) &&
      (c.variables!.variants as { price?: string }[])[0]?.price !== undefined
    );
    expect(reprice).toBeDefined();
    expect((reprice!.variables!.variants as { price: string }[])[0].price).toBe('19.99');
  });

  it('skips the price write when retail already matches the rule', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    const cj = {
      detail: async (pid: string) => detailOf(pid, 40, 10),
      stockByPid: async () => new Map<string, number>()
    } as unknown as CjClient;

    const calls: Call[] = [];
    await syncStoreInventory(store, cj, shopAdmin(calls, '19.99'), CFG, { pause: async () => {} });
    expect(calls.some((c) => c.query.includes('productVariantsBulkUpdate'))).toBe(false);
  });

  it('activates tracking + DENY on untracked variants before setting quantities', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    const cj = {
      detail: async (pid: string) => detailOf(pid, 40, 10),
      stockByPid: async () => new Map<string, number>()
    } as unknown as CjClient;

    const calls: Call[] = [];
    // price already rule-exact so the only bulk update must be the DENY one
    await syncStoreInventory(store, cj, shopAdmin(calls, '19.99', false), CFG, { pause: async () => {} });

    const trackIdx = calls.findIndex((c) => c.query.includes('inventoryItemUpdate'));
    const qtyIdx = calls.findIndex((c) => c.query.includes('inventorySetQuantities'));
    expect(trackIdx).toBeGreaterThan(-1);
    expect(trackIdx).toBeLessThan(qtyIdx); // activation must precede the quantity write
    expect(calls[trackIdx].variables!.id).toBe('gid://inv/1');
    const deny = calls.find((c) => c.query.includes('productVariantsBulkUpdate'))!;
    expect((deny.variables!.variants as { inventoryPolicy: string }[])[0].inventoryPolicy).toBe('DENY');
    expect((calls[qtyIdx].variables!.input as { quantities: { quantity: number }[] }).quantities[0].quantity).toBe(40);
  });

  it('already-tracked variants trigger no tracking mutations', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    const cj = {
      detail: async (pid: string) => detailOf(pid, 40, 10),
      stockByPid: async () => new Map<string, number>()
    } as unknown as CjClient;
    const calls: Call[] = [];
    await syncStoreInventory(store, cj, shopAdmin(calls, '19.99', true), CFG, { pause: async () => {} });
    // no tracking re-activation when the variant is already tracked…
    expect(calls.some((c) => c.query.includes('pawscoutTrack'))).toBe(false);
    // …but Cost-per-item still syncs (1.1): honest landed COGS at raw FX, $10 → £7.80
    const cost = calls.find((c) => c.query.includes('pawscoutCost'))!;
    expect(cost.variables!.cost).toBe('7.80');
  });

  it('tags an eligible product affiliate-eligible (1.2)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    const cj = {
      detail: async (pid: string) => detailOf(pid, 40, 10), // $10 → clears the £6 floor
      stockByPid: async () => new Map<string, number>()
    } as unknown as CjClient;
    const calls: Call[] = [];
    await syncStoreInventory(store, cj, shopAdmin(calls, '19.99'), CFG, { pause: async () => {} });
    const add = calls.find((c) => c.query.includes('tagsAdd'))!;
    expect(add).toBeDefined();
    expect(add.variables!.tags).toEqual(['affiliate-eligible']);
    expect(calls.some((c) => c.query.includes('tagsRemove'))).toBe(false);
  });

  it('un-tags a thin product that no longer clears the floor (1.2)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    const cj = {
      detail: async (pid: string) => detailOf(pid, 40, 3), // $3 → floor-priced, fails the affiliate floor
      stockByPid: async () => new Map<string, number>()
    } as unknown as CjClient;
    const calls: Call[] = [];
    await syncStoreInventory(store, cj, shopAdmin(calls, '8.99'), CFG, { pause: async () => {} });
    const remove = calls.find((c) => c.query.includes('tagsRemove'))!;
    expect(remove).toBeDefined();
    expect(remove.variables!.tags).toEqual(['affiliate-eligible']);
    expect(calls.some((c) => c.query.includes('tagsAdd'))).toBe(false);
  });

  it('offset resumes the run partway through the listed catalog', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5); // older updated_at → first in list
    await insertLink('B', 'imported', 3);

    const calls: Call[] = [];
    const n = await syncStoreInventory(store, stockCj(40), shopAdmin(calls), CFG, { offset: 1, pause: async () => {} });

    expect(n).toBe(1);
    const variantReads = calls.filter((c) => c.query.includes('pawscoutVariants'));
    expect(variantReads).toHaveLength(1);
    expect(String(variantReads[0].variables!.id)).toContain('B');
  });

  it('a dead stock endpoint never zeroes the store and never blocks the price sync', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('A', 'imported', 5);
    const cj = {
      // detail arrives with no usable stock; the stock endpoint is broken
      detail: async (pid: string) => ({ ...detailOf(pid, 0, 10), stock: 0, variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: 10, sku: `sku-${pid}` }] }),
      stockByPid: async () => { throw new Error('Interface not found (CJ code 1600002, /product/stock/queryByPid)'); }
    } as unknown as CjClient;

    const calls: Call[] = [];
    const errors: string[] = [];
    const n = await syncStoreInventory(store, cj, shopAdmin(calls, '53.90', false), CFG, { pause: async () => {}, errors });

    expect(n).toBe(1); // still counts: prices were synced
    expect(errors[0]).toContain('stock unknown');
    // quantities, tracking and stock metafields must all be left alone
    expect(calls.some((c) => c.query.includes('inventorySetQuantities'))).toBe(false);
    expect(calls.some((c) => c.query.includes('pawscoutTrack'))).toBe(false);
    expect(calls.some((c) => c.query.includes('metafieldsSet'))).toBe(false);
    // …but Cost-per-item is independent of stock, so it still syncs (1.1)
    expect(calls.some((c) => c.query.includes('pawscoutCost'))).toBe(true);
    expect((await store.getLink('A'))?.stock_paused).toBe(0); // never paused on unknown
    // ...but the price realignment still went through
    const reprice = calls.find((c) => c.query.includes('productVariantsBulkUpdate'))!;
    expect((reprice.variables!.variants as { price: string }[])[0].price).toBe('19.99');
  });

  it('a per-product Shopify failure never aborts the run', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await insertLink('bad', 'imported', 5);
    await insertLink('A', 'imported', 5);
    await seedWarehouse(store, 'A', 'pet-toys');
    const admin: AdminGraphql = async (query, variables) => {
      if (query.includes('pawscoutVariants') && String(variables!.id).includes('bad')) throw new Error('untracked legacy product');
      return shopAdmin([])(query, variables);
    };
    const errors: string[] = [];
    const n = await syncStoreInventory(store, stockCj(40), admin, CFG, { pause: async () => {}, errors });
    expect(n).toBe(1); // 'A' synced; 'bad' logged and skipped
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('bad: untracked legacy product'); // surfaced to the console caller
  });
});

describe('seedSemanticLibrary (Task 8 - cron seeding)', () => {
  const baseCfg = (collectionMap: TenantConfig['collectionMap'], semantic = DEFAULT_SEMANTIC): TenantConfig => ({
    collectionMap, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS,
    llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, semantic, target: 12
  });
  // autocomplete returns pet phrases (Google shape); no LLM → cleanToPetTerms degrades to the pet-floor filter
  const fetchOk = (async () => ({ ok: true, json: async () => ['q', ['dog toy', 'puppy bath']] })) as unknown as typeof fetch;
  const noLlm = { available: false } as unknown as LlmClient;

  it('seeds each non-excluded collection noun under its collection AND the agnostic set; skips excluded', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cfg = baseCfg({ 'pet-toys': { handle: 'pet-toys', tag: 't' }, 'more-to-love': { handle: 'more-to-love', tag: 'm' } });
    const res = await seedSemanticLibrary(store, noLlm, cfg, { fetchImpl: fetchOk, maxTerms: 50 });
    expect(res.seeded).toBe(2); // pet-toys × (collection + agnostic); more-to-love excluded
    expect(await store.getSemanticExpansions('pet-toys', 'pet toys')).not.toBeNull();
    expect(await store.getSemanticExpansions('', 'pet toys')).not.toBeNull();
    expect(await store.getSemanticExpansions('more-to-love', 'more to love')).toBeNull();
  });

  it('respects the per-run cap and skips already-fresh rows on re-run', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cfg = baseCfg({ 'pet-toys': { handle: 'pet-toys', tag: 't' }, 'pet-cleaning': { handle: 'pet-cleaning', tag: 'c' } });
    const r1 = await seedSemanticLibrary(store, noLlm, cfg, { fetchImpl: fetchOk, maxTerms: 1 });
    expect(r1.seeded).toBe(1);
    expect(r1.skipped).toBeGreaterThan(0); // 3 jobs deferred by the cap
    // re-run with the cap lifted: the freshly-seeded row is skipped, the rest seed
    const r2 = await seedSemanticLibrary(store, noLlm, cfg, { fetchImpl: fetchOk, maxTerms: 50 });
    expect(r2.skipped).toBeGreaterThanOrEqual(1); // the fresh row
    expect(r2.seeded).toBeGreaterThanOrEqual(3); // the remaining jobs
  });

  it('no-op when semantic.enabled is false', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const cfg = baseCfg({ 'pet-toys': { handle: 'pet-toys', tag: 't' } }, { ...DEFAULT_SEMANTIC, enabled: false });
    const res = await seedSemanticLibrary(store, noLlm, cfg, { fetchImpl: fetchOk });
    expect(res).toEqual({ seeded: 0, skipped: 0 });
    expect(await store.getSemanticExpansions('pet-toys', 'pet toys')).toBeNull();
  });
});
