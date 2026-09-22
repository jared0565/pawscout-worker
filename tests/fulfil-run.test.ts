import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { processDueOrders, pollTracking, recheckUnsettledSupplierOrders, runOrderPipelineForShop, isStockoutError, awaitingPaymentEmailBody, type StockoutNotice } from '../src/fulfil-run';
import { TenantStore } from '../src/tenant-store';
import { Vault } from '../src/vault';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_INBOX, type Env, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';

const SHOP = 'a.myshopify.com';
const SHOP2 = 'b.myshopify.com';

/** A synced CJ route (the nightly matrix row the delivery profiles and the
 *  baked-in freight are priced from). The order pipeline counter-checks the
 *  live basket quote against `usd` per unit of this row. */
async function seedRoute(store: TenantStore, from: string, to: string, usd: number | null) {
  await store.upsertLogisticsRoute({ from, to, channel: 'CJPacket', transitMin: 8, transitMax: 12, agingRaw: '8-12', repVid: 'rep', freightCostUsd: usd });
}
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // Every seeded order below ships CN->GB unless a test says otherwise, and
  // the default fake quotes USD 2 for the basket: the same figure as the
  // synced route, so the counter-check passes unless a test moves one side.
  await seedRoute(new TenantStore(env.DB, SHOP), 'CN', 'GB', 2);
  await seedRoute(new TenantStore(env.DB, SHOP2), 'CN', 'GB', 2);
});
function cfg(mode: 'manual' | 'pawscout' | 'cj', createOnly = false): TenantConfig {
  return { collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: { mode, createOnly }, inbox: DEFAULT_INBOX, target: 12 };
}
const ADDRESS = { name: 'Jane', phone: '07000', address1: '1 St', address2: '', city: 'London', province: 'England', zip: 'E1 1AA', countryCode: 'GB' };
const PAST = new Date(Date.now() - 1000).toISOString();
/** How far apart the real schedule runs. A run takes a due row for itself for
 *  ten minutes, so a test that means "the next run" has to move the clock the
 *  way the schedule does instead of calling processDueOrders twice in the
 *  same millisecond. */
const TICK_MS = 900_000;
const atTick = (n: number) => () => Date.now() + n * TICK_MS;

async function seedWarehouse(store: TenantStore, cjPid: string, sku: string, vid: string) {
  const detail: CjDetail = { pid: cjPid, nameEn: 'X', images: [], descriptionHtml: '', variants: [{ vid, name: 'Red', sellPriceUsd: 10, sku }], listedNum: 1, categoryName: 'Pet Toys', origin: 'CN' };
  await store.putWarehouseProduct({ cjPid, category: 'pet-toys', title: 'X', detailJson: JSON.stringify(detail), priceUsd: 10, listedNum: 1, stock: 50 });
}
async function seedOrder(store: TenantStore, id: string, lineItems: unknown[], extra: Record<string, unknown> = {}) {
  await store.insertOrderIfNew({
    shopifyOrderId: id, orderName: '#' + id, totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null,
    status: 'queued', holdReasons: [], addressJson: JSON.stringify(ADDRESS), lineItemsJson: JSON.stringify(lineItems), fulfilAfter: PAST, ...extra
  });
}
function fakeCj(spy: { create: unknown[]; pay: string[] }, over: Partial<Record<string, unknown>> = {}): CjClient {
  return {
    freightForBasket: async () => ({ priceUsd: 2, days: '8-12', name: 'CJPacket' }),
    detail: async () => null, // live-lookup fallback; overridden per-test
    createOrder: async (input: { orderNumber: string }) => { spy.create.push(input); return { orderId: 'CJORD-' + input.orderNumber, orderNum: input.orderNumber }; },
    payBalance: async (id: string) => { spy.pay.push(id); },
    getOrderDetail: async (id: string) => ({ orderId: id, orderNum: '', trackNumber: 'TRK1', trackUrl: '', logisticName: 'CJPacket', status: 'shipped' }),
    ...over
  } as unknown as CjClient;
}
/** The default gate-query answer: a live, paid, unfulfilled order that Shopify's
 *  fraud check has accepted, with a shipping address matching the seeded ADDRESS. */
const LIVE_ORDER: Record<string, unknown> = {
  cancelledAt: null,
  closed: false,
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  risk: { recommendation: 'ACCEPT' },
  shippingAddress: { name: ADDRESS.name, address1: ADDRESS.address1, address2: ADDRESS.address2, city: ADDRESS.city, province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone }
};
/** Admin fake for the gate query: answers with LIVE_ORDER by default (shallow-merged
 *  with `over.order` when given, so a test only needs to state the field it changes),
 *  and `{}` for any other query (a missing gate answer holds the order as "order
 *  missing", per the new whitelist gate). `over.throws` makes every call reject,
 *  simulating an unreadable gate. */
function liveAdmin(over: { order?: Record<string, unknown> | null; throws?: string } = {}): AdminGraphql {
  return (async (query: string) => {
    if (over.throws) throw new Error(over.throws);
    if (query.includes('pawscoutOrderGate')) {
      if ('order' in over && over.order === null) return { order: null };
      return { order: { ...LIVE_ORDER, ...(over.order ?? {}) } };
    }
    return {};
  }) as unknown as AdminGraphql;
}

describe('processDueOrders', () => {
  it('is a no-op when autopay is OFF (orders stay queued, nothing paid)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('manual'));
    expect(r).toMatchObject({ skipped: true, submitted: 0 });
    expect(spy.create.length + spy.pay.length).toBe(0);
    expect((await store.getOrder('O1'))?.status).toBe('queued');
  });

  it('creates + pays a due order and resolves the vid from the sku', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 2, cjPid: 'CJ1' }]);
    const spy = { create: [] as any[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, errored: 0 });
    expect(spy.create[0].products).toEqual([{ vid: 'v1', quantity: 2 }]);
    expect(spy.pay).toEqual(['CJORD-O1']);
    const o = await store.getOrder('O1');
    expect(o).toMatchObject({ status: 'submitted', cj_order_id: 'CJORD-O1' });
  });

  it('resolves the vid via a live CJ lookup when there is NO warehouse row', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // No seedWarehouse - mimics a live product that has been culled from the pool.
    await seedOrder(store, 'O1', [{ sku: 'S9', quantity: 1, cjPid: 'CJ9' }]);
    const spy = { create: [] as any[], pay: [] as string[] };
    const liveDetail: CjDetail = { pid: 'CJ9', nameEn: 'X', images: [], descriptionHtml: '', variants: [{ vid: 'vLIVE', name: 'R', sellPriceUsd: 10, sku: 'S9' }], listedNum: 1, categoryName: 'Pet Toys', origins: { CN: 100 } };
    const cj = fakeCj(spy, { detail: async (pid: string) => (pid === 'CJ9' ? liveDetail : null) });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout', true));
    expect(r).toMatchObject({ awaiting: 1, errored: 0 });
    expect(spy.create[0].products).toEqual([{ vid: 'vLIVE', quantity: 1 }]);
  });

  it('errors (no pay) when the vid cannot be resolved', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', [{ sku: 'MISSING', quantity: 1, cjPid: 'CJ-UNKNOWN' }]); // no warehouse row
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, errored: 1 });
    expect(spy.create.length).toBe(0);
    expect((await store.getOrder('O1'))?.status).toBe('error');
  });

  it('errors without paying when CJ createOrder fails', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, { createOrder: async () => { throw new Error('CJ stock 0'); } });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, errored: 1 });
    expect(spy.pay.length).toBe(0);
    expect((await store.getOrder('O1'))?.status).toBe('error');
  });

  // A per-order step that rejects with a non-Error value (null, here) must
  // not itself throw while the catch is building its log line - that second,
  // unhandled throw would escape the per-order try/catch and end the whole
  // loop early, silently skipping every order still due after the one that
  // rejected with null.
  it('a per-order step that rejects with null lands the row in error and does not stop the loop over the remaining orders', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await seedOrder(store, 'O2', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, {
      createOrder: async (input: { orderNumber: string }) => {
        if (input.orderNumber === 'O1') return Promise.reject(null);
        spy.create.push(input);
        return { orderId: 'CJORD-' + input.orderNumber, orderNum: input.orderNumber };
      }
    });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ errored: 1, submitted: 1 });
    expect((await store.getOrder('O1'))?.status).toBe('error');
    expect((await store.getOrder('O2'))?.status).toBe('submitted');
  });

  it('createOnly: creates the CJ order but does NOT pay (awaiting-payment)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('pawscout', true));
    expect(r).toMatchObject({ submitted: 0, awaiting: 1, errored: 0 });
    expect(spy.create.length).toBe(1); // created
    expect(spy.pay.length).toBe(0);    // not paid
    expect((await store.getOrder('O1'))?.status).toBe('awaiting-payment');
    expect((await store.getOrder('O1'))?.cj_order_id).toBe('CJORD-O1');
  });

  it('fires the notify callback once when an order becomes awaiting-payment (createOnly)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const notes: { cjOrderId: string; orderName: string }[] = [];
    const r = await processDueOrders(store, fakeCj({ create: [], pay: [] }), liveAdmin(), cfg('pawscout', true), {
      notify: async (n) => { notes.push({ cjOrderId: n.cjOrderId, orderName: n.orderName }); }
    });
    expect(r).toMatchObject({ awaiting: 1 });
    expect(notes).toEqual([{ cjOrderId: 'CJORD-O1', orderName: '#O1' }]);
  });

  it('a notify failure does not fail the order (still awaiting-payment)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const r = await processDueOrders(store, fakeCj({ create: [], pay: [] }), liveAdmin(), cfg('pawscout', true), {
      notify: async () => { throw new Error('resend down'); }
    });
    expect(r).toMatchObject({ awaiting: 1, errored: 0 });
    expect((await store.getOrder('O1'))?.status).toBe('awaiting-payment');
  });

  it('insufficient balance downgrades to awaiting-payment, not error', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, { payBalance: async () => { throw new Error('CJ: insufficient balance, please recharge'); } });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, awaiting: 1, errored: 0 });
    expect(spy.create.length).toBe(1); // order exists in CJ
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('awaiting-payment');
    expect(o?.cj_order_id).toBe('CJORD-O1');
  });

  it('non-balance pay failure still errors', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, { payBalance: async () => { throw new Error('CJ system error 500'); } });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, awaiting: 0, errored: 1 });
    expect((await store.getOrder('O1'))?.status).toBe('error');
  });

  it('skips re-create and only pays when cj_order_id is already set (retry-safe)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { cjOrderId: undefined });
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' }); // simulate created-but-unpaid
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1 });
    expect(spy.create.length).toBe(0); // did NOT duplicate the CJ order
    expect(spy.pay).toEqual(['CJORD-EXISTING']);
  });
});

describe('source-stockout handling (sold out at CJ after we sold it)', () => {
  interface Call { query: string; variables?: Record<string, unknown> }
  /** Admin mock that answers the gate query with a live order (so the order reaches
   *  the stock/create path) plus the inventory-zero flow (location -> variants -> set 0). */
  function zeroAdmin(calls: Call[]): AdminGraphql {
    return (async (query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables });
      if (query.includes('pawscoutOrderGate')) return { order: LIVE_ORDER };
      if (query.includes('pawscoutLocation')) return { location: { id: 'gid://shopify/Location/1' } };
      if (query.includes('pawscoutVariants')) return { product: { variants: { nodes: [{ id: 'gid://v/1', sku: 'S1', price: '9.99', inventoryItem: { id: 'gid://inv/1', tracked: true } }] } } };
      if (query.includes('inventorySetQuantities')) return { inventorySetQuantities: { userErrors: [] } };
      return {};
    }) as unknown as AdminGraphql;
  }

  it('pre-flight catches a sniped line: no CJ order, stockout reason, variant zeroed, owner notified', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await store.putLink({ cjPid: 'CJ1', state: 'imported', shopifyProductId: 'gid://shopify/Product/100', handle: 'x', category: 'pet-toys' });
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 2, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, { stockByPid: async () => new Map([['v1', 1]]) }); // source has 1, customer ordered 2
    const calls: Call[] = [];
    const notices: StockoutNotice[] = [];
    const r = await processDueOrders(store, cj, zeroAdmin(calls), cfg('pawscout'), { notifyStockout: async (n) => { notices.push(n); } });

    expect(r).toMatchObject({ submitted: 0, errored: 1 });
    expect(spy.create.length).toBe(0); // never created the CJ order
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('error');
    expect(JSON.parse(o!.hold_reasons ?? '[]')[0]).toMatch(/^stockout:/);
    const zero = calls.find((c) => c.query.includes('inventorySetQuantities'))!;
    expect(zero).toBeDefined(); // phantom stock hidden from sale immediately
    expect((zero.variables!.input as { quantities: { quantity: number }[] }).quantities[0].quantity).toBe(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ orderName: '#O1', item: 'S1', zeroed: true });
  });

  it('an unreachable stock endpoint is UNKNOWN, not zero: the order proceeds normally', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, { stockByPid: async () => { throw new Error('CJ 500'); } });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, errored: 0 });
    expect(spy.create.length).toBe(1);
  });

  it('classifies a CJ createOrder out-of-stock rejection as stockout (backstop, single-line pinpoint)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await store.putLink({ cjPid: 'CJ1', state: 'imported', shopifyProductId: 'gid://shopify/Product/100', handle: 'x', category: 'pet-toys' });
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, {
      stockByPid: async () => new Map([['v1', 50]]), // pre-flight passes...
      createOrder: async () => { throw new Error('the product is out of stock'); } // ...CJ still rejects
    });
    const calls: Call[] = [];
    const notices: StockoutNotice[] = [];
    const r = await processDueOrders(store, cj, zeroAdmin(calls), cfg('pawscout'), { notifyStockout: async (n) => { notices.push(n); } });
    expect(r).toMatchObject({ errored: 1 });
    expect(JSON.parse((await store.getOrder('O1'))!.hold_reasons ?? '[]')[0]).toMatch(/^stockout:/);
    expect(calls.some((c) => c.query.includes('inventorySetQuantities'))).toBe(true); // single line -> pinpointed + zeroed
    expect(notices).toHaveLength(1);
  });

  it('a stockout whose link read rejects with null still lands the row in error, and the next due order in the same batch is still processed', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedWarehouse(store, 'CJ2', 'S2', 'v2');
    await store.putLink({ cjPid: 'CJ1', state: 'imported', shopifyProductId: 'gid://shopify/Product/100', handle: 'x', category: 'pet-toys' });
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await seedOrder(store, 'O2', [{ sku: 'S2', quantity: 1, cjPid: 'CJ2' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, {
      stockByPid: async () => new Map([['v1', 50], ['v2', 50]]), // pre-flight passes for both...
      createOrder: async (input: { orderNumber: string }) => {
        if (input.orderNumber === 'O1') throw new Error('the product is out of stock'); // ...CJ still rejects O1
        spy.create.push(input);
        return { orderId: 'CJORD-' + input.orderNumber, orderNum: input.orderNumber };
      }
    });
    // The stockout branch's inventory-zero step reads the product link first;
    // a rejection with null there (not an Error) used to throw a bare
    // TypeError reading .message from inside a catch with no enclosing try
    // in the loop, ending the whole batch for this shop.
    const getLinkSpy = vi.spyOn(TenantStore.prototype, 'getLink').mockRejectedValue(null);
    let r;
    try {
      r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    } finally {
      getLinkSpy.mockRestore();
    }
    expect(r).toMatchObject({ errored: 1, submitted: 1 });
    expect((await store.getOrder('O1'))?.status).toBe('error');
    expect(JSON.parse((await store.getOrder('O1'))!.hold_reasons ?? '[]')[0]).toMatch(/^stockout:/);
    expect((await store.getOrder('O2'))?.status).toBe('submitted');
  });

  it('a stockout with plenty of source stock never fires: normal orders are untouched', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, { stockByPid: async () => new Map([['v1', 50]]) });
    const notices: StockoutNotice[] = [];
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'), { notifyStockout: async (n) => { notices.push(n); } });
    expect(r).toMatchObject({ submitted: 1, errored: 0 });
    expect(notices).toHaveLength(0);
  });

  it('isStockoutError matches CJ out-of-stock phrasings and not generic failures', () => {
    expect(isStockoutError('The product is OUT OF STOCK')).toBe(true);
    expect(isStockoutError('variant sold out')).toBe(true);
    expect(isStockoutError('insufficient inventory for vid x')).toBe(true);
    expect(isStockoutError('stock is not enough')).toBe(true);
    expect(isStockoutError('CJ system error 500')).toBe(false);
    expect(isStockoutError('no address on order')).toBe(false);
    expect(isStockoutError('insufficient balance, please recharge')).toBe(false); // wallet, not stock
  });
});

describe('pollTracking', () => {
  function fulfilAdmin(calls: { q: string; v?: any }[]): AdminGraphql {
    return (async (query: string, vars?: unknown) => {
      calls.push({ q: query, v: vars });
      if (query.includes('fulfillmentOrders')) return { order: { fulfillmentOrders: { nodes: [{ id: 'gid://fo/1', status: 'OPEN' }] } } };
      if (query.includes('fulfillmentCreate(')) return { fulfillmentCreate: { fulfillment: { id: 'f1', status: 'SUCCESS' }, userErrors: [] } };
      throw new Error('unexpected: ' + query.slice(0, 30));
    }) as unknown as AdminGraphql;
  }

  it('writes tracking to Shopify and marks fulfilled when a track number appears', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O1', orderName: '#1', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' });
    const calls: { q: string; v?: any }[] = [];
    const r = await pollTracking(store, fakeCj({ create: [], pay: [] }), fulfilAdmin(calls));
    expect(r).toEqual({ checked: 1, fulfilled: 1 });
    const fulfil = calls.find((c) => c.q.includes('fulfillmentCreate('));
    expect(fulfil).toBeTruthy();
    // a working tracking link is passed (17track fallback when CJ gives no url)
    expect(fulfil!.v.f.trackingInfo.url).toBe('https://t.17track.net/en#nums=TRK1');
    expect(fulfil!.v.f.trackingInfo.number).toBe('TRK1');
    expect(await store.getOrder('O1')).toMatchObject({ status: 'fulfilled', tracking_number: 'TRK1' });
  });

  it('uses CJ\'s own tracking url when present (not the 17track fallback)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O3', orderName: '#3', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O3', { cj_order_id: 'CJORD-O3' });
    const cj = fakeCj({ create: [], pay: [] }, { getOrderDetail: async (id: string) => ({ orderId: id, orderNum: '', trackNumber: 'TRK9', trackUrl: 'https://track.cj.example/TRK9', logisticName: 'CJPacket', status: 'shipped' }) });
    const calls: { q: string; v?: any }[] = [];
    await pollTracking(store, cj, fulfilAdmin(calls));
    const fulfil = calls.find((c) => c.q.includes('fulfillmentCreate('));
    expect(fulfil!.v.f.trackingInfo.url).toBe('https://track.cj.example/TRK9');
  });

  it('fulfils an awaiting-payment order once the owner pays and tracking appears', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O2', orderName: '#2', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'awaiting-payment', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O2', { cj_order_id: 'CJORD-O2' });
    const calls: { q: string }[] = [];
    const r = await pollTracking(store, fakeCj({ create: [], pay: [] }), fulfilAdmin(calls));
    expect(r).toEqual({ checked: 1, fulfilled: 1 });
    expect((await store.getOrder('O2'))?.status).toBe('fulfilled');
  });

  it('leaves the order submitted when CJ has no tracking yet', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O1', orderName: '#1', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' });
    const cj = fakeCj({ create: [], pay: [] }, { getOrderDetail: async (id: string) => ({ orderId: id, orderNum: '', trackNumber: '', trackUrl: '', logisticName: '', status: 'processing' }) });
    const r = await pollTracking(store, cj, fulfilAdmin([]));
    expect(r).toEqual({ checked: 1, fulfilled: 0 });
    expect((await store.getOrder('O1'))?.status).toBe('submitted');
  });

  it('sends fulfillmentCreate( and not fulfillmentCreateV2', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O5', orderName: '#5', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O5', { cj_order_id: 'CJORD-O5' });
    const calls: { q: string; v?: any }[] = [];
    await pollTracking(store, fakeCj({ create: [], pay: [] }), fulfilAdmin(calls));
    const mutation = calls.find((c) => c.q.includes('mutation pawscoutFulfill'));
    expect(mutation).toBeTruthy();
    expect(mutation!.q).toContain('fulfillmentCreate(');
    expect(mutation!.q).not.toContain('fulfillmentCreateV2');
  });

  it('write-back fails four polls in a row: four tracking-write-failed events, exactly one alert, still submitted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O6', orderName: '#6', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O6', { cj_order_id: 'CJORD-O6' });
    const failAdmin: AdminGraphql = (async (query: string) => {
      if (query.includes('fulfillmentOrders')) throw new Error('write failed');
      return {};
    }) as unknown as AdminGraphql;
    const alerts: { subject: string; text: string }[] = [];
    for (let i = 0; i < 4; i++) {
      await pollTracking(store, fakeCj({ create: [], pay: [] }), failAdmin, {
        alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
      });
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #6: tracking could not be written to Shopify');
    // A write-back that in fact reached Shopify can still be recorded as
    // failed, so the alert says what could not be confirmed and sends the
    // owner to look, rather than asserting the customer was not told.
    expect(alerts[0].text).toBe('Supplier order CJORD-O6 has shipped with tracking TRK1, but writing it to Shopify could not be confirmed on the last 4 attempts (write failed). Check the order in Shopify: if it already shows fulfilled with this tracking number the customer has been told and there is nothing to do; if it does not, tell the customer the tracking number yourself. It is retried every 15 minutes.');
    expect(alerts[0].text).not.toContain('The customer has not been told');
    const events = await store.listOrderEvents('O6');
    expect(events.filter((e) => e.kind === 'tracking-write-failed')).toHaveLength(4);
    // The trail classifies, never copies: Shopify's own error text is
    // evidence in the alert (asserted above), not in the decision record.
    for (const e of events.filter((ev) => ev.kind === 'tracking-write-failed')) expect(e.detail).toBe('write to Shopify failed');
    expect(events.map((e) => e.kind)).toContain('owner-alerted');
    expect(events.find((e) => e.kind === 'owner-alerted')?.detail).toBe(alerts[0].subject);
    expect((await store.getOrder('O6'))?.status).toBe('submitted');
  });

  it('a write-back failure whose message contains a marker word leaves no trail detail containing that word (the alert text still carries it)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O6', orderName: '#6', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O6', { cj_order_id: 'CJORD-O6' });
    const MARKER = 'ADDRESSLEAKMARKER';
    const failAdmin: AdminGraphql = (async (query: string) => {
      if (query.includes('fulfillmentOrders')) throw new Error(`write failed: ${MARKER}`);
      return {};
    }) as unknown as AdminGraphql;
    const alerts: { subject: string; text: string }[] = [];
    await pollTracking(store, fakeCj({ create: [], pay: [] }), failAdmin, {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    const events = await store.listOrderEvents('O6');
    const failure = events.find((e) => e.kind === 'tracking-write-failed');
    expect(failure?.detail).not.toContain(MARKER);
    expect(failure?.detail).toBe('write to Shopify failed');
  });

  it('a write-back that rejects with null still writes tracking-write-failed, so the fourth consecutive one still alerts', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O6', orderName: '#6', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O6', { cj_order_id: 'CJORD-O6' });
    // A non-Error rejection here used to throw a bare TypeError reading
    // .message from inside the write-back's own catch, so addOrderEvent for
    // tracking-write-failed was never reached and the trailing count never
    // moved.
    const nullFailAdmin: AdminGraphql = (async (query: string) => {
      if (query.includes('fulfillmentOrders')) return Promise.reject(null);
      return {};
    }) as unknown as AdminGraphql;
    const alerts: { subject: string; text: string }[] = [];
    for (let i = 0; i < 4; i++) {
      await pollTracking(store, fakeCj({ create: [], pay: [] }), nullFailAdmin, {
        alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
      });
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #6: tracking could not be written to Shopify');
    const events = await store.listOrderEvents('O6');
    expect(events.filter((e) => e.kind === 'tracking-write-failed')).toHaveLength(4);
    expect(events.map((e) => e.kind)).toContain('owner-alerted');
    expect((await store.getOrder('O6'))?.status).toBe('submitted');
  });

  it('a failed send at the tracking-write-failed alert leaves owner-alert-failed, not owner-alerted, and does not fire again on the very next poll (the failure marker breaks the trailing run the same way a delivered one does)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O6', orderName: '#6', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O6', { cj_order_id: 'CJORD-O6' });
    const failAdmin: AdminGraphql = (async (query: string) => {
      if (query.includes('fulfillmentOrders')) throw new Error('write failed');
      return {};
    }) as unknown as AdminGraphql;
    const alerts: { subject: string; text: string }[] = [];
    for (let i = 0; i < 4; i++) {
      await pollTracking(store, fakeCj({ create: [], pay: [] }), failAdmin, {
        alert: async (subject, text) => { alerts.push({ subject, text }); return 'failed'; }
      });
    }
    expect(alerts).toHaveLength(1);
    const events = await store.listOrderEvents('O6');
    expect(events.map((e) => e.kind)).toContain('owner-alert-failed');
    expect(events.map((e) => e.kind)).not.toContain('owner-alerted');
    expect(events.find((e) => e.kind === 'owner-alert-failed')?.detail).toBe(alerts[0].subject);

    await pollTracking(store, fakeCj({ create: [], pay: [] }), failAdmin, {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'failed'; }
    });
    expect(alerts).toHaveLength(1); // the failure marker already broke the trailing run
  });

  it('write-back succeeds: tracking-found then tracking-written; a second poll of the fulfilled order writes nothing', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O7', orderName: '#7', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O7', { cj_order_id: 'CJORD-O7' });
    const calls: { q: string; v?: any }[] = [];
    await pollTracking(store, fakeCj({ create: [], pay: [] }), fulfilAdmin(calls));
    const events = await store.listOrderEvents('O7');
    expect(events.map((e) => e.kind)).toEqual(['tracking-found', 'tracking-written']);
    expect((await store.getOrder('O7'))?.status).toBe('fulfilled');

    const calls2: { q: string; v?: any }[] = [];
    const r2 = await pollTracking(store, fakeCj({ create: [], pay: [] }), fulfilAdmin(calls2));
    expect(r2).toEqual({ checked: 0, fulfilled: 0 }); // no longer submitted/awaiting-payment - not selected
    const events2 = await store.listOrderEvents('O7');
    expect(events2).toHaveLength(2); // unchanged
  });
});

describe('Stage-B live-order gate (2026-09-19: readOrderGate/decideGate, fetched before money moves)', () => {
  // NOTE: the old 'fails OPEN when the risk read errors (order still submits)' test
  // is deliberately DELETED here, not migrated: fail-open-on-read-failure was the
  // old fetchOrderRisk behaviour, and the new gate is fail-CLOSED on a read failure
  // by design. Its replacement is the 'gate read throws' pair below.

  it('holds a CANCEL-recommended order BEFORE any CJ spend (high-risk)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { risk: { recommendation: 'CANCEL' } } }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, held: 1, errored: 0 });
    expect(spy.create.length + spy.pay.length).toBe(0);
    const o = await store.getOrder('O1');
    expect(o).toMatchObject({ status: 'held', risk_level: 'HIGH' });
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['high-risk']);
  });

  it('holds INVESTIGATE above the value threshold (medium-risk-value)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { totalPrice: 79.99 });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { risk: { recommendation: 'INVESTIGATE' } } }), cfg('pawscout'));
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length).toBe(0);
    const o = await store.getOrder('O1');
    expect(o).toMatchObject({ status: 'held', risk_level: 'MEDIUM' });
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['medium-risk-value']);
  });

  it('lets a small INVESTIGATE order flow, stamping MEDIUM for console visibility', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { totalPrice: 15 });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { risk: { recommendation: 'INVESTIGATE' } } }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0 });
    expect((await store.getOrder('O1'))).toMatchObject({ status: 'submitted', risk_level: 'MEDIUM' });
  });

  it('skips the risk check for an operator-released order (their decision wins)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    // Held at webhook time, operator released it back to queued - hold history remains.
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { holdReasons: ['high-risk'] });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { risk: { recommendation: 'CANCEL' } } }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0 }); // CANCEL recommendation had no effect - risk was skipped
  });

  it('an operator-released order that is genuinely Shopify-cancelled is NOT created (cancel beats hold history)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { holdReasons: ['high-risk'] });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, held: 1 });
    expect(spy.create.length).toBe(0);
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
  });

  it('skips the risk check on a pay-retry (CJ order already exists)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { risk: { recommendation: 'CANCEL' } } }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0 });
    expect(spy.pay).toEqual(['CJORD-O1']); // paid the existing order, no re-create
  });

  it('gate says cancelled: no createOrder, no payBalance, row cancelled, a gate-held event', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } }), cfg('pawscout'));
    expect(r).toMatchObject({ held: 1, submitted: 0 });
    expect(spy.create.length + spy.pay.length).toBe(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('cancelled');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['shopify-cancelled']);
    const events = await store.listOrderEvents('O1');
    expect(events.some((e) => e.kind === 'gate-held' && e.detail === 'shopify-cancelled')).toBe(true);
  });

  it('gate says REFUNDED: no createOrder, row held with ["refunded"]', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { displayFinancialStatus: 'REFUNDED' } }), cfg('pawscout'));
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length).toBe(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['refunded']);
  });

  it('a stop here still REPLACES the row\'s hold reasons, not merges (pinned so this default cannot drift)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { holdReasons: ['some-old-reason'] });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { displayFinancialStatus: 'REFUNDED' } }), cfg('pawscout'));
    expect(r).toMatchObject({ held: 1 });
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['refunded']); // NOT ['some-old-reason', 'refunded']
  });

  it('gate says FULFILLED: no createOrder, row held', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { displayFulfillmentStatus: 'FULFILLED' } }), cfg('pawscout'));
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length).toBe(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['already-fulfilled']);
  });

  it('gate read throws: no createOrder, row stays queued, a gate-unreadable event, no alert on the first failure', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: unknown[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ throws: 'gate api down' }), cfg('pawscout'), {
      alert: async (s, t) => { alerts.push({ s, t }); return 'sent'; }
    });
    expect(r).toMatchObject({ submitted: 0, held: 0, errored: 0 });
    expect(spy.create.length).toBe(0);
    expect((await store.getOrder('O1'))?.status).toBe('queued');
    const events = await store.listOrderEvents('O1');
    expect(events.some((e) => e.kind === 'gate-unreadable')).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  // The trail classifies, it never copies. A failed read's message can be
  // Shopify's own GraphQL error text, so only our own "Shopify HTTP <status>"
  // wording (a status code and nothing else) is kept; anything else is
  // recorded as a fixed phrase. The owner's email still carries the real
  // message, which the four-in-a-row test below pins.
  it('a gate-unreadable trail line never copies the raw error: our own HTTP status wording is kept, anything else becomes a fixed phrase', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    await processDueOrders(store, fakeCj(spy), liveAdmin({ throws: 'Field RAWMARKER does not exist on type Order' }), cfg('pawscout'), { now: atTick(0) });
    await processDueOrders(store, fakeCj(spy), liveAdmin({ throws: 'Shopify HTTP 503' }), cfg('pawscout'), { now: atTick(1) });
    const details = (await store.listOrderEvents('O1')).filter((e) => e.kind === 'gate-unreadable').map((e) => e.detail);
    expect(details).toEqual(['read failed', 'Shopify HTTP 503']);
    expect(spy.create.length).toBe(0);
  });

  it('gate read throws on four consecutive runs: exactly ONE alert, on the fourth', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const admin = liveAdmin({ throws: 'gate api down' });
    const alerts: { subject: string; text: string }[] = [];
    for (let i = 0; i < 4; i++) {
      await processDueOrders(store, fakeCj({ create: [], pay: [] }), admin, cfg('pawscout'), {
        now: atTick(i),
        alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
      });
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 cannot be checked against Shopify');
    expect(alerts[0].text).toBe('Order #O1 is due, but its state in Shopify could not be read on the last 4 checks (gate api down). Nothing has been sent to the supplier. It is retried every 15 minutes.');
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'gate-unreadable')).toHaveLength(4);
    expect(events.map((e) => e.kind)).toContain('owner-alerted');
    expect(events.find((e) => e.kind === 'owner-alerted')?.detail).toBe(alerts[0].subject);
    expect((await store.getOrder('O1'))?.status).toBe('queued');
    // The outbox row lands before the outcome marker, at this pipeline alert
    // site too - not only at the door in src/index.ts.
    const dueIdx = events.findIndex((e) => e.kind === 'owner-alert-due');
    const alertedIdx = events.findIndex((e) => e.kind === 'owner-alerted');
    expect(dueIdx).toBeGreaterThanOrEqual(0);
    expect(dueIdx).toBeLessThan(alertedIdx);
  });

  it('a failed alert on the 4th gate-unreadable failure leaves owner-alert-failed, not owner-alerted, and does not fire again on the 5th failure (the failure marker breaks the trailing run the same way a delivered one does)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const admin = liveAdmin({ throws: 'gate api down' });
    const alerts: { subject: string; text: string }[] = [];
    for (let i = 0; i < 4; i++) {
      await processDueOrders(store, fakeCj({ create: [], pay: [] }), admin, cfg('pawscout'), {
        now: atTick(i),
        alert: async (subject, text) => { alerts.push({ subject, text }); return 'failed'; }
      });
    }
    expect(alerts).toHaveLength(1);
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toContain('owner-alert-failed');
    expect(events.map((e) => e.kind)).not.toContain('owner-alerted');
    expect(events.find((e) => e.kind === 'owner-alert-failed')?.detail).toBe(alerts[0].subject);

    await processDueOrders(store, fakeCj({ create: [], pay: [] }), admin, cfg('pawscout'), {
      now: atTick(4),
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'failed'; }
    });
    expect(alerts).toHaveLength(1); // the failure marker already broke the trailing run
  });

  it('a pay retry whose gate now says cancelled: payBalance is NOT called, the alert is sent, row cancelled keeps cj_order_id', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' });
    let calls = 0;
    const admin: AdminGraphql = (async (query: string) => {
      if (query.includes('pawscoutOrderGate')) {
        calls++;
        if (calls === 1) return { order: { ...LIVE_ORDER } }; // still live at the pre-flight check
        return { order: { ...LIVE_ORDER, cancelledAt: '2026-09-19T00:00:00Z' } }; // cancelled just before pay
      }
      return {};
    }) as unknown as AdminGraphql;
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj(spy), admin, cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length).toBe(0); // no re-create (already existed)
    expect(spy.pay.length).toBe(0); // NOT paid
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1: payment to the supplier was stopped');
    // The row can be one an operator released with a supplier order the owner
    // may already have paid by hand, so the text claims nothing about that.
    expect(alerts[0].text).toBe('Order #O1 changed in Shopify (shopify-cancelled) after supplier order CJORD-EXISTING was created and before PawScout paid it. PawScout has not paid it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.');
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('cancelled');
    expect(o?.cj_order_id).toBe('CJORD-EXISTING');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toContain('owner-alerted');
    expect(events.find((e) => e.kind === 'owner-alerted')?.detail).toBe(alerts[0].subject);
  });

  it('a failed send at the payment-stopped alert leaves owner-alert-failed, not owner-alerted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' });
    let calls = 0;
    const admin: AdminGraphql = (async (query: string) => {
      if (query.includes('pawscoutOrderGate')) {
        calls++;
        if (calls === 1) return { order: { ...LIVE_ORDER } };
        return { order: { ...LIVE_ORDER, cancelledAt: '2026-09-19T00:00:00Z' } };
      }
      return {};
    }) as unknown as AdminGraphql;
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), admin, cfg('pawscout'), {
      alert: async () => 'failed'
    });
    expect(r).toMatchObject({ held: 1 });
    expect(spy.pay.length).toBe(0);
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toContain('owner-alert-failed');
    expect(events.map((e) => e.kind)).not.toContain('owner-alerted');
  });

  it('two lines resolving to different origins hold as mixed-origin (no supplier order)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1'); // origin CN
    const detailGb: CjDetail = { pid: 'CJ2', nameEn: 'Y', images: [], descriptionHtml: '', variants: [{ vid: 'v2', name: 'Blue', sellPriceUsd: 10, sku: 'S2' }], listedNum: 1, categoryName: 'Pet Toys', origin: 'GB' };
    await store.putWarehouseProduct({ cjPid: 'CJ2', category: 'pet-toys', title: 'Y', detailJson: JSON.stringify(detailGb), priceUsd: 10, listedNum: 1, stock: 50 });
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }, { sku: 'S2', quantity: 1, cjPid: 'CJ2' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: unknown[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('pawscout'), {
      alert: async (s, t) => { alerts.push({ s, t }); return 'sent'; }
    });
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length).toBe(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['mixed-origin']);
    const events = await store.listOrderEvents('O1');
    expect(events.some((e) => e.kind === 'gate-held' && e.detail?.startsWith('mixed-origin:'))).toBe(true);
    expect(alerts).toHaveLength(0); // no supplier order exists, so no alert
  });

  it('a changed Shopify address is used for creation and persisted with an address-refreshed event - a row with NO supplier order yet proceeds and creates it with the new address', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as any[], pay: [] as string[] };
    const newAddr = { name: ADDRESS.name, address1: ADDRESS.address1, address2: ADDRESS.address2, city: 'Manchester', province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { shippingAddress: newAddr } }), cfg('pawscout', true));
    expect(r).toMatchObject({ awaiting: 1, held: 0 });
    expect(spy.create[0].address).toMatchObject({ city: 'Manchester' });
    const o = await store.getOrder('O1');
    expect(JSON.parse(o!.address_json!)).toMatchObject({ city: 'Manchester' });
    const events = await store.listOrderEvents('O1');
    expect(events.some((e) => e.kind === 'address-refreshed')).toBe(true);
  });

  it('a pay-retry whose Shopify address has changed is held (not paid), the new address is stored, notify is not called, and the alert never carries the address', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' }); // a supplier order already exists
    const newAddr = { name: ADDRESS.name, address1: '99 New Road', address2: ADDRESS.address2, city: 'Manchester', province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone };
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const notifies: unknown[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { shippingAddress: newAddr } }), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; },
      notify: async (n) => { notifies.push(n); }
    });
    expect(r).toMatchObject({ held: 1, submitted: 0, awaiting: 0 });
    expect(spy.create.length).toBe(0); // no re-create
    expect(spy.pay.length).toBe(0); // not paid
    expect(notifies).toHaveLength(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['address-changed-after-supplier-order']);
    expect(JSON.parse(o!.address_json!)).toMatchObject({ city: 'Manchester', address1: '99 New Road' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1: the delivery address changed after the supplier order was created');
    expect(alerts[0].text).toBe('The delivery address of order #O1 was changed in Shopify after supplier order CJORD-EXISTING was created, so the supplier order still carries the old address. Do NOT pay it as it stands. Correct the address on the supplier order at the supplier, then release the order in the PawScout console. If the supplier cannot change it, cancel the supplier order there and handle this order by hand.');
    expect(alerts[0].text).not.toContain('99 New Road');
    expect(alerts[0].text).not.toContain(ADDRESS.address1);
    expect(alerts[0].text).not.toContain('Manchester');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toContain('address-refreshed');
    const gateHeld = events.find((e) => e.kind === 'gate-held');
    expect(gateHeld?.detail).toBe('address-changed-after-supplier-order');
    expect(events.map((e) => e.kind)).toContain('owner-alerted');
  });

  it('the pre-pay position: an address that changes between the two gate reads holds instead of paying, with the new address stored and no leak into the alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const newAddr = { name: ADDRESS.name, address1: ADDRESS.address1, address2: ADDRESS.address2, city: 'Bristol', province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone };
    let calls = 0;
    const admin: AdminGraphql = (async (query: string) => {
      if (query.includes('pawscoutOrderGate')) {
        calls++;
        if (calls === 1) return { order: { ...LIVE_ORDER } }; // unchanged at the pre-create check
        return { order: { ...LIVE_ORDER, shippingAddress: newAddr } }; // changed just before pay
      }
      return {};
    }) as unknown as AdminGraphql;
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj(spy), admin, cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ held: 1, submitted: 0 });
    expect(spy.create.length).toBe(1); // the supplier order was created before the address changed
    expect(spy.pay.length).toBe(0); // not paid
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['address-changed-after-supplier-order']);
    expect(JSON.parse(o!.address_json!)).toMatchObject({ city: 'Bristol' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain('CJORD-O1');
    expect(alerts[0].text).not.toContain('Bristol');
    expect(alerts[0].text).not.toContain(ADDRESS.address1);
  });

  it('after a release, the same row proceeds with no second hold once the stored address matches Shopify again', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' });
    const newAddr = { name: ADDRESS.name, address1: ADDRESS.address1, address2: ADDRESS.address2, city: 'Leeds', province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone };
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r1 = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { shippingAddress: newAddr } }), cfg('pawscout'), {
      now: atTick(0),
      alert: async () => 'sent'
    });
    expect(r1).toMatchObject({ held: 1 });
    expect((await store.getOrder('O1'))?.status).toBe('held');

    // Operator release: back to queued. cj_order_id and the already-updated
    // address are left as they are.
    await store.updateOrder('O1', { status: 'queued' });

    const r2 = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { shippingAddress: newAddr } }), cfg('pawscout'), {
      now: atTick(1),
      alert: async () => 'sent'
    });
    expect(r2).toMatchObject({ submitted: 1, held: 0 });
    expect(spy.pay).toEqual(['CJORD-EXISTING']);
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'gate-held')).toHaveLength(1); // no second hold
  });

  it('a happy createOnly run leaves the trail: gate-passed, stock-ok, freight-quoted, supplier-order-created, awaiting-payment', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const r = await processDueOrders(store, fakeCj({ create: [], pay: [] }), liveAdmin(), cfg('pawscout', true));
    expect(r).toMatchObject({ awaiting: 1 });
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['gate-passed', 'stock-ok', 'freight-quoted', 'supplier-order-created', 'awaiting-payment']);
    expect(events[2].detail).toBe('CN->GB, 1 unit: live USD 2.00 via CJPacket (8-12 days); allowed for USD 2.00');
  });

  it('a happy paying run writes a paid event and ends submitted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1 });
    const events = await store.listOrderEvents('O1');
    expect(events[events.length - 1].kind).toBe('paid');
    expect((await store.getOrder('O1'))?.status).toBe('submitted');
  });
});

describe('a cancelled row stays cancelled', () => {
  it('createOnly: the row is cancelled during createOrder - held not awaiting, no notify, exact alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, {
      createOrder: async (input: { orderNumber: string }) => {
        // Simulate a Shopify cancel landing WHILE createOrder is in flight.
        await store.updateOrder('O1', { status: 'cancelled', hold_reasons: JSON.stringify(['shopify-cancelled']) });
        spy.create.push(input);
        return { orderId: 'CJORD-O1', orderNum: input.orderNumber };
      }
    });
    const notifies: unknown[] = [];
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout', true), {
      notify: async (n) => { notifies.push(n); },
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ held: 1, awaiting: 0 });
    expect(notifies).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 was cancelled while its supplier order was being created');
    // Also reached by a released row whose supplier order already existed and
    // may have been paid by hand, so the text makes no claim either way.
    expect(alerts[0].text).toBe('Order #O1 was cancelled in Shopify while PawScout was working on supplier order CJORD-O1. PawScout has not paid it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.');
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('cancelled');
    const events = await store.listOrderEvents('O1');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('supplier-order-created');
    expect(kinds).not.toContain('awaiting-payment');
    expect(kinds).toContain('owner-alerted');
    expect(events.find((e) => e.kind === 'owner-alerted')?.detail).toBe(alerts[0].subject);
  });

  it('a failed send at the cancelled-during-create alert leaves owner-alert-failed, not owner-alerted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, {
      createOrder: async (input: { orderNumber: string }) => {
        await store.updateOrder('O1', { status: 'cancelled', hold_reasons: JSON.stringify(['shopify-cancelled']) });
        spy.create.push(input);
        return { orderId: 'CJORD-O1', orderNum: input.orderNumber };
      }
    });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout', true), {
      alert: async () => 'failed'
    });
    expect(r).toMatchObject({ held: 1, awaiting: 0 });
    const events = await store.listOrderEvents('O1');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('owner-alert-failed');
    expect(kinds).not.toContain('owner-alerted');
  });

  it('auto-pay: the row is cancelled during payBalance - held not submitted, paid event still written, exact alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, {
      payBalance: async (id: string) => {
        await store.updateOrder('O1', { status: 'cancelled', hold_reasons: JSON.stringify(['shopify-cancelled']) });
        spy.pay.push(id);
      }
    });
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ held: 1, submitted: 0 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 was cancelled while its supplier order was being paid');
    expect(alerts[0].text).toBe('Order #O1 was cancelled in Shopify while supplier order CJORD-O1 was being paid. The payment went through. Ask the supplier to cancel it if it has not shipped. If it has shipped, this is a return.');
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('cancelled');
    const events = await store.listOrderEvents('O1');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('paid');
    expect(kinds).toContain('owner-alerted');
    expect(events.find((e) => e.kind === 'owner-alerted')?.detail).toBe(alerts[0].subject);
  });

  it('a failed send at the cancelled-during-pay alert leaves owner-alert-failed, not owner-alerted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, {
      payBalance: async (id: string) => {
        await store.updateOrder('O1', { status: 'cancelled', hold_reasons: JSON.stringify(['shopify-cancelled']) });
        spy.pay.push(id);
      }
    });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'), {
      alert: async () => 'failed'
    });
    expect(r).toMatchObject({ held: 1, submitted: 0 });
    const events = await store.listOrderEvents('O1');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('owner-alert-failed');
    expect(kinds).not.toContain('owner-alerted');
  });

  it('the row is cancelled during createOrder and createOrder then throws: stays cancelled, not error', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, {
      createOrder: async () => {
        await store.updateOrder('O1', { status: 'cancelled', hold_reasons: JSON.stringify(['shopify-cancelled']) });
        throw new Error('CJ system error 500');
      }
    });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ errored: 1 });
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('cancelled');
    const events = await store.listOrderEvents('O1');
    expect(events.some((e) => e.kind === 'error')).toBe(true);
  });
});

describe('a gate stop on a row with an existing supplier order alerts', () => {
  it('a queued row with cj_order_id whose gate says cancelled: exact alert, row cancelled, no create/pay', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-RELEASED' }); // released back to queued, supplier order still exists
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } }), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length + spy.pay.length).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 was stopped and a supplier order exists for it');
    expect(alerts[0].text).toBe('Order #O1 was stopped by the check against Shopify (shopify-cancelled). Supplier order CJORD-RELEASED already exists for it. Do NOT pay it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.');
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('cancelled');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toContain('owner-alerted');
    expect(events.find((e) => e.kind === 'owner-alerted')?.detail).toBe(alerts[0].subject);
  });

  it('a failed send at the supplier-order-exists alert leaves owner-alert-failed, not owner-alerted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-RELEASED' });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } }), cfg('pawscout'), {
      alert: async () => 'failed'
    });
    expect(r).toMatchObject({ held: 1 });
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toContain('owner-alert-failed');
    expect(events.map((e) => e.kind)).not.toContain('owner-alerted');
  });

  it('a queued row with cj_order_id whose gate holds (refunded): same alert shape with the hold reason', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-RELEASED' });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { displayFinancialStatus: 'REFUNDED' } }), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length + spy.pay.length).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 was stopped and a supplier order exists for it');
    expect(alerts[0].text).toBe('Order #O1 was stopped by the check against Shopify (refunded). Supplier order CJORD-RELEASED already exists for it. Do NOT pay it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.');
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
  });

  it('a queued row WITHOUT cj_order_id whose gate says cancelled: no alert (nothing was ever sent to the supplier)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: unknown[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } }), cfg('pawscout'), {
      alert: async (s, t) => { alerts.push({ s, t }); return 'sent'; }
    });
    expect(r).toMatchObject({ held: 1 });
    expect(alerts).toHaveLength(0);
  });
});

describe('the gate-unreadable alert is true wherever it fires', () => {
  it('the pre-pay position: four failing pre-pay reads in a row alert once with the supplier-order text and the cj order id; nothing paid', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' }); // supplier order already exists (pay retry)
    let n = 0;
    const admin: AdminGraphql = (async (query: string) => {
      if (query.includes('pawscoutOrderGate')) {
        n++;
        if (n % 2 === 1) return { order: { ...LIVE_ORDER } }; // pre-create check: succeeds every time
        throw new Error('gate api down'); // pre-pay check: fails every time
      }
      return {};
    }) as unknown as AdminGraphql;
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    for (let i = 0; i < 4; i++) {
      await processDueOrders(store, fakeCj(spy), admin, cfg('pawscout'), {
        now: atTick(i),
        alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
      });
    }
    expect(spy.create.length).toBe(0);
    expect(spy.pay.length).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 cannot be checked against Shopify');
    expect(alerts[0].text).toBe('Order #O1 could not be checked against Shopify on the last 4 checks (gate api down). Supplier order CJORD-O1 exists for it, and PawScout will not pay it until the check succeeds. It is retried every 15 minutes.');
  });

  it('a pay-retry failing at the pre-create position also gets the supplier-order text', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' });
    const admin = liveAdmin({ throws: 'gate api down' });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    for (let i = 0; i < 4; i++) {
      await processDueOrders(store, fakeCj(spy), admin, cfg('pawscout'), {
        now: atTick(i),
        alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
      });
    }
    expect(spy.pay.length).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe('Order #O1 could not be checked against Shopify on the last 4 checks (gate api down). Supplier order CJORD-O1 exists for it, and PawScout will not pay it until the check succeeds. It is retried every 15 minutes.');
  });
});

describe('no latch - a >= 4 comparison, not === 4', () => {
  it('seeding FIVE trailing gate-unreadable events (a lost alert marker) still alerts on the next failure', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    for (let i = 0; i < 5; i++) await store.addOrderEvent('O1', 'gate-unreadable', 'prior failure');
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj({ create: [], pay: [] }), liveAdmin({ throws: 'gate api down' }), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ submitted: 0, held: 0, errored: 0 });
    expect(alerts).toHaveLength(1);
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'gate-unreadable')).toHaveLength(6);
  });

  it('seeding FIVE trailing tracking-write-failed events still alerts on the next failure', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O8', orderName: '#8', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O8', { cj_order_id: 'CJORD-O8' });
    await store.addOrderEvent('O8', 'tracking-found'); // already recorded, so pollTracking will not re-write it
    for (let i = 0; i < 5; i++) await store.addOrderEvent('O8', 'tracking-write-failed', 'prior failure');
    const failAdmin: AdminGraphql = (async (query: string) => {
      if (query.includes('fulfillmentOrders')) throw new Error('write failed');
      return {};
    }) as unknown as AdminGraphql;
    const alerts: { subject: string; text: string }[] = [];
    await pollTracking(store, fakeCj({ create: [], pay: [] }), failAdmin, {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(alerts).toHaveLength(1);
    const events = await store.listOrderEvents('O8');
    expect(events.filter((e) => e.kind === 'tracking-write-failed')).toHaveLength(6);
  });
});

describe('trail detail is classified, never a copy of the raw error', () => {
  it('a createOrder rejection holding a marker phone and street: no event detail contains either marker, and the error event reads "failed at create"', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const MARKER_PHONE = '07000000099';
    const MARKER_STREET = '221B Marker Baker Street';
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, { createOrder: async () => { throw new Error(`validation failed: recipient phone ${MARKER_PHONE}, address ${MARKER_STREET} is not deliverable`); } });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ errored: 1 });
    const events = await store.listOrderEvents('O1');
    for (const e of events) {
      expect(e.detail ?? '').not.toContain(MARKER_PHONE);
      expect(e.detail ?? '').not.toContain(MARKER_STREET);
    }
    const errorEvent = events.find((e) => e.kind === 'error');
    expect(errorEvent?.detail).toBe('failed at create');
  });

  it('a typed StockoutError keeps its own message (sku/pid only)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 2, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, { stockByPid: async () => new Map([['v1', 1]]) }); // source has 1, ordered 2
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ errored: 1 });
    const events = await store.listOrderEvents('O1');
    const stockoutEvent = events.find((e) => e.kind === 'stockout');
    expect(stockoutEvent?.detail).toBe('source stock 1 is below the ordered 2 for S1');
  });

  it('a phrase-matched rejection on a single-line order reads "supplier reported no stock for <sku>"', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy, { createOrder: async () => { throw new Error('the product is out of stock'); } });
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ errored: 1 });
    const events = await store.listOrderEvents('O1');
    const stockoutEvent = events.find((e) => e.kind === 'stockout');
    expect(stockoutEvent?.detail).toBe('supplier reported no stock for S1');
  });
});

describe('operator release skips the FRAUD check only when the hold WAS a fraud hold', () => {
  it('a released row whose history is ["mixed-origin"] and whose gate now says CANCEL on risk is HELD for high-risk', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { holdReasons: ['mixed-origin'] });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { risk: { recommendation: 'CANCEL' } } }), cfg('pawscout'));
    expect(r).toMatchObject({ held: 1, submitted: 0 });
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['high-risk']);
  });

  it('a released row whose history is ["high-risk"] still proceeds (the operator overruled the fraud gate)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { holdReasons: ['high-risk'] });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { risk: { recommendation: 'CANCEL' } } }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0 });
  });
});

describe('a mixed-origin hold on a row with an existing supplier order alerts', () => {
  it('a queued row WITH cj_order_id whose lines now resolve to two origins: held, the same stopped-order alert with the mixed-origin reason, nothing paid', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1'); // origin CN
    const detailGb: CjDetail = { pid: 'CJ2', nameEn: 'Y', images: [], descriptionHtml: '', variants: [{ vid: 'v2', name: 'Blue', sellPriceUsd: 10, sku: 'S2' }], listedNum: 1, categoryName: 'Pet Toys', origin: 'GB' };
    await store.putWarehouseProduct({ cjPid: 'CJ2', category: 'pet-toys', title: 'Y', detailJson: JSON.stringify(detailGb), priceUsd: 10, listedNum: 1, stock: 50 });
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }, { sku: 'S2', quantity: 1, cjPid: 'CJ2' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' }); // released back to queued, supplier order still exists
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length + spy.pay.length).toBe(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['mixed-origin']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 was stopped and a supplier order exists for it');
    expect(alerts[0].text).toBe('Order #O1 was stopped by the check against Shopify (mixed-origin: CN, GB). Supplier order CJORD-EXISTING already exists for it. Do NOT pay it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.');
  });
});

describe('step starts at "gate", not "resolve"', () => {
  it('invalid line_items_json throws before resolution begins: the error event reads exactly "failed at gate"', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({
      shopifyOrderId: 'O1', orderName: '#O1', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null,
      status: 'queued', holdReasons: [], addressJson: JSON.stringify(ADDRESS), lineItemsJson: 'not valid json{', fulfilAfter: PAST
    });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ errored: 1 });
    expect((await store.getOrder('O1'))?.status).toBe('error');
    const events = await store.listOrderEvents('O1');
    const errorEvent = events.find((e) => e.kind === 'error');
    expect(errorEvent?.detail).toBe('failed at gate');
  });
});

describe('what still runs for a shop whose supplier credential is gone', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // The pull check needs Shopify and nothing else, and its whole point is to
  // watch supplier orders that are already out there. A credential that was
  // removed or rotated out is exactly when one most needs watching, so the
  // check has to sit ABOVE the guard that gives up on the shop.
  it('the alert retry sweep and the pull check both run above the supplier-credential guard', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    const dek = await vault.newTenantDek();
    await store.upsertTenant({ accessTokenEnc: await vault.seal(dek, 'shpat_test'), dekWrapped: dek, scopes: 's' });
    await store.seedConfig(cfg('pawscout'));

    const seen: string[] = [];
    vi.spyOn(TenantStore.prototype, 'listOrderIdsWithPendingAlerts').mockImplementation(async () => { seen.push('sweep'); return []; });
    vi.spyOn(TenantStore.prototype, 'countUnsettledSupplierOrders').mockImplementation(async () => { seen.push('pull-check'); return 0; });
    vi.spyOn(TenantStore.prototype, 'getSupplierCredential').mockImplementation(async () => { seen.push('guard'); return null; });

    const r = await runOrderPipelineForShop(env as unknown as Env, vault, SHOP);

    expect(r).toBeNull(); // the shop is still not ready, so nothing is submitted or paid
    expect(seen).toEqual(['sweep', 'pull-check', 'guard']);
  });
});

describe('the awaiting-payment email', () => {
  const notice = (existing: boolean) => ({ shopifyOrderId: 'O1', orderName: '#O1', cjOrderId: 'CJORD-O1', total: 15, currency: 'GBP', reason: 'r', existing });

  it('says a supplier order was just created, on a first creation', async () => {
    const body = awaitingPaymentEmailBody(notice(false));
    expect(body.text).toContain('has been created in CJ and is awaiting your payment');
    expect(body.text).toContain('CJORD-O1');
    expect(body.text).not.toContain('back in the list');
  });

  it('says a released order is back in the list, unpaid by PawScout, and to check it at the supplier first', async () => {
    const body = awaitingPaymentEmailBody(notice(true));
    expect(body.text).toContain('is back in the list of CJ orders PawScout has not paid, after being released');
    expect(body.text).toContain('PawScout has not paid it');
    expect(body.text).toContain('Check its state at the supplier before you pay it, so it is not paid twice');
    expect(body.text).not.toContain('has been created in CJ and is awaiting your payment');
    expect(body.html).toContain('back in the list');
  });

  it('a first creation and a released row are told apart by whether the row already carried a supplier order', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'FRESH', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await seedOrder(store, 'RELEASED', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('RELEASED', { cj_order_id: 'CJORD-RELEASED' });
    const seen: { orderName: string; existing: boolean }[] = [];
    await processDueOrders(store, fakeCj({ create: [], pay: [] }), liveAdmin(), cfg('pawscout', true), {
      notify: async (n) => { seen.push({ orderName: n.orderName, existing: n.existing }); }
    });
    // Both rows are seeded in the same millisecond, so the order the run reads
    // them back in is not what is under test here: look each one up by name.
    expect(seen).toHaveLength(2);
    expect(seen.find((n) => n.orderName === '#FRESH')?.existing).toBe(false);
    expect(seen.find((n) => n.orderName === '#RELEASED')?.existing).toBe(true);
  });
});

describe('an order that lands in error tells the owner', () => {
  it('a failure before the supplier order was created says nothing was sent', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', [{ sku: 'MISSING', quantity: 1, cjPid: 'CJ-UNKNOWN' }]); // no warehouse row, no live detail
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj({ create: [], pay: [] }), liveAdmin(), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ errored: 1 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 could not be sent to the supplier');
    expect(alerts[0].text).toBe('Order #O1 failed at resolve and is now in error. Nothing will retry it by itself. Nothing was sent to the supplier.');
  });

  it('a failure at the create step warns that the supplier may already hold the order, and never repeats the thrown message', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const cj = fakeCj({ create: [], pay: [] }, { createOrder: async () => { throw new Error('supplier said RAWMARKER for 1 St, London'); } });
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ errored: 1 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe('Order #O1 failed at create and is now in error. Nothing will retry it by itself. The supplier may already hold an order for it. PawScout gives the supplier the order number O1 for this order. Look for that number at the supplier before anything is retried, so it is not ordered twice.');
    expect(alerts[0].text).not.toContain('RAWMARKER');
    expect(alerts[0].subject).not.toContain('RAWMARKER');
  });

  // The supplier is given the Shopify order id as the order number, never the
  // name the shop shows. Sending the owner to search the supplier for "#1002"
  // would find nothing and read as "no order exists", which is the second
  // supplier order this sentence is written to prevent.
  it('names the number PawScout actually gave the supplier, not the name the shop shows', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, '5678901234', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { orderName: '#1002' });
    const givenToSupplier: string[] = [];
    const cj = fakeCj({ create: [], pay: [] }, {
      createOrder: async (input: { orderNumber: string }) => { givenToSupplier.push(input.orderNumber); throw new Error('supplier timed out'); }
    });
    const alerts: { subject: string; text: string }[] = [];
    await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(givenToSupplier).toEqual(['5678901234']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain('PawScout gives the supplier the order number 5678901234 for this order');
    expect(alerts[0].text).not.toContain('order number #1002');
  });

  // A cancel can land while the step that fails is in flight. The row stays
  // cancelled, so the alert must not announce a status the row never took;
  // the half about looking at the supplier matters more here, not less.
  it('a row cancelled while the failing step was in flight is not called an error row', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const cj = fakeCj({ create: [], pay: [] }, {
      createOrder: async () => {
        await store.updateOrder('O1', { status: 'cancelled', hold_reasons: JSON.stringify(['shopify-cancelled']) });
        throw new Error('supplier system error 500');
      }
    });
    const alerts: { subject: string; text: string }[] = [];
    await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 could not be sent to the supplier');
    expect(alerts[0].text).toBe('Order #O1 failed at create, and it was cancelled in Shopify in the meantime, so it stays cancelled. The supplier may already hold an order for it. PawScout gives the supplier the order number O1 for this order. Look for that number at the supplier before anything is retried, so it is not ordered twice.');
    expect(alerts[0].text).not.toContain('is now in error');
  });

  it('a failure on a row that already carries a supplier order names that supplier order', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' });
    const cj = fakeCj({ create: [], pay: [] }, { payBalance: async () => { throw new Error('supplier refused the payment'); } });
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ errored: 1 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe('Order #O1 failed at pay and is now in error. Nothing will retry it by itself. The supplier may already hold an order for it: supplier order CJORD-EXISTING. PawScout gives the supplier the order number O1 for this order. Look for that number at the supplier before anything is retried, so it is not ordered twice.');
  });

  it('a stockout sends its own email and NOT this alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const cj = fakeCj({ create: [], pay: [] }, { createOrder: async () => { throw new Error('out of stock'); } });
    const alerts: unknown[] = [];
    const notices: StockoutNotice[] = [];
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; },
      notifyStockout: async (n) => { notices.push(n); }
    });
    expect(r).toMatchObject({ errored: 1 });
    expect(notices).toHaveLength(1);
    expect(alerts).toHaveLength(0);
  });
});

describe('one run owns a due row', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('two runs started together create exactly ONE supplier order and leave one supplier-order-created line', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = fakeCj(spy);

    const [a, b] = await Promise.all([
      processDueOrders(store, cj, liveAdmin(), cfg('pawscout', true)),
      processDueOrders(store, cj, liveAdmin(), cfg('pawscout', true))
    ]);

    expect(spy.create).toHaveLength(1);
    expect(a.awaiting + b.awaiting).toBe(1);
    expect(a.errored + b.errored).toBe(0);
    expect(a.held + b.held).toBe(0); // a refused claim counts as nothing
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'supplier-order-created')).toHaveLength(1);
    expect((await store.getOrder('O1'))?.status).toBe('awaiting-payment');
  });

  it('a row whose gate was unreadable is due again after 10 minutes and not before', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const admin = liveAdmin({ throws: 'gate api down' });
    const base = Date.now();

    await processDueOrders(store, fakeCj({ create: [], pay: [] }), admin, cfg('pawscout'), { now: () => base });
    expect((await store.getOrder('O1'))?.status).toBe('queued');
    expect(await store.listOrderEvents('O1')).toHaveLength(1); // one gate-unreadable

    // Nine minutes later the claim still stands: the row is not selected at all.
    await processDueOrders(store, fakeCj({ create: [], pay: [] }), admin, cfg('pawscout'), { now: () => base + 9 * 60_000 });
    expect(await store.listOrderEvents('O1')).toHaveLength(1);

    // Ten minutes on it is due again, and the check runs a second time.
    await processDueOrders(store, fakeCj({ create: [], pay: [] }), admin, cfg('pawscout'), { now: () => base + 10 * 60_000 });
    expect(await store.listOrderEvents('O1')).toHaveLength(2);
  });

  it('a claim is scoped to its own shop: the same order id in another shop is left due', async () => {
    const a = new TenantStore(env.DB, SHOP);
    const b = new TenantStore(env.DB, SHOP2);
    await seedOrder(a, 'O1', []);
    await seedOrder(b, 'O1', []);
    const now = new Date(Date.now()).toISOString();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();

    expect(await a.claimDueOrder('O1', now, until)).toBe(true);
    expect(await a.claimDueOrder('O1', now, until)).toBe(false); // already owned in this shop

    // The other shop's row of the same id was never touched.
    expect((await b.getOrder('O1'))?.fulfil_after).toBe(PAST);
    expect(await b.claimDueOrder('O1', now, until)).toBe(true);
  });

  it('a claim is refused on a row that is no longer queued', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', [], { status: 'held', holdReasons: ['not-paid'] });
    expect(await store.claimDueOrder('O1', new Date().toISOString(), new Date(Date.now() + 10 * 60_000).toISOString())).toBe(false);
  });

  // The ten minutes exist to stop a second run touching the same row, so they
  // have to start when the row is taken. Measured from the start of the run
  // instead, the last row of a slow batch keeps whatever is left of the ten
  // minutes after the run's own elapsed time.
  it('the ten minutes are counted from the moment the row is taken, not from the start of the run', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const t0 = Date.now();
    let reads = 0;
    // The run starts at T0 and does not reach this row until five minutes in.
    const now = () => (reads++ === 0 ? t0 : t0 + 5 * 60_000);

    await processDueOrders(store, fakeCj({ create: [], pay: [] }), liveAdmin({ throws: 'gate api down' }), cfg('pawscout'), { now });

    const o = await store.getOrder('O1');
    expect(o?.status).toBe('queued');
    expect(o?.fulfil_after).toBe(new Date(t0 + 15 * 60_000).toISOString());
  });

  // The database can refuse the claim write itself (locked, gone, out of
  // storage). Nothing has been done to the row at that point, so the run owes
  // it nothing: leaving it exactly as it was makes the next run pick it up.
  it('an order whose claim write throws is left untouched and runs normally on the next tick', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await seedOrder(store, 'O2', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const claim = vi.spyOn(TenantStore.prototype, 'claimDueOrder')
      .mockImplementationOnce(async () => { throw new Error('database is locked'); });
    const first = { create: [] as any[], pay: [] as string[] };
    const alerts: unknown[] = [];
    const notifies: unknown[] = [];

    const r1 = await processDueOrders(store, fakeCj(first), liveAdmin(), cfg('pawscout'), {
      now: atTick(0),
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; },
      notify: async (n) => { notifies.push(n); }
    });

    // The other order due behind it went through, so one throw does not end
    // the run; the skipped row added nothing to any count.
    expect(first.create).toHaveLength(1);
    expect(r1).toMatchObject({ submitted: 1, awaiting: 0, held: 0, errored: 0 });
    expect(alerts).toEqual([]);
    expect(notifies).toEqual([]);
    const skipped = first.create[0].orderNumber === 'O1' ? 'O2' : 'O1';
    expect((await store.getOrder(skipped))?.status).toBe('queued');
    expect(await store.listOrderEvents(skipped)).toEqual([]);

    claim.mockRestore();
    const second = { create: [] as any[], pay: [] as string[] };
    const r2 = await processDueOrders(store, fakeCj(second), liveAdmin(), cfg('pawscout'), { now: atTick(1) });
    expect(r2).toMatchObject({ submitted: 1, errored: 0 });
    expect((await store.getOrder(skipped))?.status).toBe('submitted');
  });
});

describe('recheckUnsettledSupplierOrders: unsettled supplier orders are re-read on a rotation', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** Seeded with the reason production really writes for this status, so a
   *  test can see what the console would actually print next to the row. */
  const awaitingReason = (cjOrderId: string) => `awaiting-payment: CJ order ${cjOrderId} is not paid by PawScout`;

  async function seedAwaiting(store: TenantStore, id: string, cjOrderId: string, addressJson: string | null = JSON.stringify(ADDRESS)): Promise<void> {
    await store.insertOrderIfNew({
      shopifyOrderId: id, orderName: '#' + id, totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null,
      status: 'awaiting-payment', holdReasons: [awaitingReason(cjOrderId)], addressJson, lineItemsJson: null, fulfilAfter: null
    });
    await store.updateOrder(id, { cj_order_id: cjOrderId });
  }

  it('an empty backlog answers all zeros without dividing by zero', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const admin = liveAdmin();
    const send = async () => 'sent' as const;
    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toEqual({ checked: 0, cancelled: 0, addressChanged: 0, stopped: 0, unreadable: 0 });
  });

  it('a cancelled row becomes cancelled and the do-NOT-pay alert is delivered exactly once across two runs', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1');
    const admin = liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r1 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r1).toMatchObject({ checked: 1, cancelled: 1, addressChanged: 0, stopped: 0, unreadable: 0 });
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 was cancelled: do NOT pay the supplier');

    const r2 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r2).toMatchObject({ checked: 0, cancelled: 0 }); // 'cancelled' is settled - not selected any more
    expect(alerts).toHaveLength(1); // still exactly one
  });

  it('a cancel already alerted by the webhook path (cancel-received plus a marker already in the trail) sends nothing here, but still counts as cancelled', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1');
    await store.addOrderEvent('O1', 'cancel-received', 'was awaiting-payment');
    await store.addOrderEvent('O1', 'owner-alerted', 'Order #O1 was cancelled: do NOT pay the supplier');
    const admin = liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } });
    const alerts: unknown[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toMatchObject({ checked: 1, cancelled: 1 });
    expect(alerts).toHaveLength(0);
  });

  it('a held row that is cancelled in Shopify gets the generic cancelled-with-a-supplier-order alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O1', orderName: '#O1', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'held', holdReasons: ['not-paid'], addressJson: JSON.stringify(ADDRESS), lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' });
    const admin = liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toMatchObject({ checked: 1, cancelled: 1 });
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 was cancelled and a supplier order exists for it');
  });

  it('a row with corrupt address_json does not stop it, or a later row, from being cancelled and alerted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'A-corrupt', 'CJORD-A', 'not valid json{');
    await seedAwaiting(store, 'B-normal', 'CJORD-B');
    const admin = liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } });
    const send = async () => 'sent' as const;

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toMatchObject({ checked: 2, cancelled: 2 });
    expect((await store.getOrder('A-corrupt'))?.status).toBe('cancelled');
    expect((await store.getOrder('B-normal'))?.status).toBe('cancelled');
  });

  it('a row with corrupt address_json whose gate answers hold with refunded still ends held with that reason and one stop alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1', 'not valid json{');
    const admin = liveAdmin({ order: { displayFinancialStatus: 'REFUNDED' } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toMatchObject({ checked: 1, cancelled: 0, addressChanged: 0, stopped: 1, unreadable: 0 });
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['refunded']);
    expect(alerts).toHaveLength(1);
  });

  it('a row with corrupt address_json whose gate would proceed with a different address is not alerted about an address change and its stored address is left alone', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1', 'not valid json{');
    const newAddr = { name: ADDRESS.name, address1: ADDRESS.address1, address2: ADDRESS.address2, city: 'Cardiff', province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone };
    const admin = liveAdmin({ order: { shippingAddress: newAddr } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toMatchObject({ checked: 1, cancelled: 0, addressChanged: 0, stopped: 0, unreadable: 0 });
    expect(alerts).toHaveLength(0);
    expect((await store.getOrder('O1'))?.address_json).toBe('not valid json{');
  });

  it('held and error rows carrying a supplier order are watched; without one they are not', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'HELD-WITH', orderName: '#HELD-WITH', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'held', holdReasons: ['not-paid'], addressJson: JSON.stringify(ADDRESS), lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('HELD-WITH', { cj_order_id: 'CJORD-HELD' });
    await store.insertOrderIfNew({ shopifyOrderId: 'HELD-WITHOUT', orderName: '#HELD-WITHOUT', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'held', holdReasons: ['not-paid'], addressJson: JSON.stringify(ADDRESS), lineItemsJson: null, fulfilAfter: null });
    await store.insertOrderIfNew({ shopifyOrderId: 'ERROR-WITH', orderName: '#ERROR-WITH', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'error', holdReasons: ['fulfil: x'], addressJson: JSON.stringify(ADDRESS), lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('ERROR-WITH', { cj_order_id: 'CJORD-ERROR' });
    await store.insertOrderIfNew({ shopifyOrderId: 'ERROR-WITHOUT', orderName: '#ERROR-WITHOUT', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'error', holdReasons: ['fulfil: x'], addressJson: JSON.stringify(ADDRESS), lineItemsJson: null, fulfilAfter: null });

    const admin = liveAdmin();
    const send = async () => 'sent' as const;
    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r.checked).toBe(2); // only HELD-WITH and ERROR-WITH carry a supplier order
  });

  it('a changed address is saved and alerted exactly once across two runs, and the row is never held here', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1');
    const newAddr = { name: ADDRESS.name, address1: ADDRESS.address1, address2: ADDRESS.address2, city: 'Cardiff', province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone };
    const admin = liveAdmin({ order: { shippingAddress: newAddr } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r1 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r1).toMatchObject({ checked: 1, cancelled: 0, addressChanged: 1, stopped: 0, unreadable: 0 });
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('awaiting-payment'); // the pull check never holds a row for an address change
    expect(o?.hold_reasons).toBe(JSON.stringify([awaitingReason('CJORD-O1')])); // unchanged
    expect(JSON.parse(o!.address_json!)).toMatchObject({ city: 'Cardiff' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1: the delivery address changed after the supplier order was created');
    expect(alerts[0].text).toBe(
      'The delivery address of order #O1 was changed in Shopify after supplier order CJORD-O1 was created, so the supplier order still carries the old address. If it is not paid yet, correct the address on the supplier order at the supplier before you pay it. If it is already paid, ask the supplier to change the address before it ships. If the supplier cannot change it, handle this order by hand.'
    );
    expect(alerts[0].text).not.toContain('Cardiff');
    expect(alerts[0].text).not.toContain(ADDRESS.address1);

    // The row is still watched (still awaiting-payment with a supplier order),
    // but the stored address now matches Shopify's - the saved address is the
    // dedupe, not the row leaving this check.
    const r2 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r2).toMatchObject({ checked: 1, addressChanged: 0 });
    expect(alerts).toHaveLength(1);
  });

  it('a live, unchanged row is untouched and nothing is sent', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1');
    const admin = liveAdmin();
    const alerts: unknown[] = [];
    const send = async () => { alerts.push(1); return 'sent' as const; };

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toEqual({ checked: 1, cancelled: 0, addressChanged: 0, stopped: 0, unreadable: 0 });
    expect((await store.getOrder('O1'))?.status).toBe('awaiting-payment');
    expect(await store.listOrderEvents('O1')).toEqual([]);
    expect(alerts).toHaveLength(0);
  });

  it('an order Shopify shows as fulfilled is alerted once across two runs, and nothing is held', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'F1', 'CJORD-F1');
    const admin = liveAdmin({ order: { displayFulfillmentStatus: 'FULFILLED' } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r1 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r1).toMatchObject({ checked: 1, cancelled: 0, addressChanged: 0, stopped: 0, unreadable: 0 });
    expect((await store.getOrder('F1'))?.status).toBe('awaiting-payment'); // nothing held, no status moved
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #F1 shows as fulfilled in Shopify and its supplier order is still open here');
    expect(alerts[0].text).toBe('Shopify shows order #F1 as fulfilled, but supplier order CJORD-F1 is still listed here as not paid by PawScout. If you shipped it another way, do NOT pay CJORD-F1: cancel it at the supplier. If you paid CJORD-F1 and it shipped, there is nothing to do.');

    const r2 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r2).toMatchObject({ checked: 1, stopped: 0 });
    expect(alerts).toHaveLength(1); // the due marker already in the trail is the dedupe
  });

  it('an order that can no longer be found in Shopify is alerted once across two runs, and nothing is held', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'M1', 'CJORD-M1');
    const admin = liveAdmin({ order: null });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r1 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r1).toMatchObject({ checked: 1, cancelled: 0, addressChanged: 0, stopped: 0, unreadable: 0 });
    expect((await store.getOrder('M1'))?.status).toBe('awaiting-payment');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #M1 can no longer be found in Shopify and a supplier order exists for it');
    expect(alerts[0].text).toBe('Order #M1 can no longer be found in Shopify, but supplier order CJORD-M1 is still listed here as not paid by PawScout. An order that was cancelled and then deleted in Shopify reads this way, and so does one older than 60 days. Do NOT pay CJORD-M1 until you have found out which it is. If you have already paid it, check its state at the supplier: if the order turns out to have been cancelled, ask the supplier to cancel it, and treat it as a return if it has shipped.');

    const r2 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r2).toMatchObject({ checked: 1, stopped: 0 });
    expect(alerts).toHaveLength(1);
  });

  it('a send that keeps failing is still raised only once here: the retry sweep owns it, not this check', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'F1', 'CJORD-F1');
    const admin = liveAdmin({ order: { displayFulfillmentStatus: 'FULFILLED' } });
    const sends: string[] = [];
    const send = async (subject: string) => { sends.push(subject); return 'failed' as const; };

    for (let i = 0; i < 3; i++) await recheckUnsettledSupplierOrders(store, admin, send);
    expect(sends).toHaveLength(1);
  });

  it('a held or an error row in those same two states stays silent', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'HELD', orderName: '#HELD', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'held', holdReasons: ['address-changed-after-supplier-order'], addressJson: JSON.stringify(ADDRESS), lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('HELD', { cj_order_id: 'CJORD-HELD' });
    await store.insertOrderIfNew({ shopifyOrderId: 'ERR', orderName: '#ERR', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'error', holdReasons: ['fulfil: x'], addressJson: JSON.stringify(ADDRESS), lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('ERR', { cj_order_id: 'CJORD-ERR' });
    const admin = liveAdmin({ order: { displayFulfillmentStatus: 'FULFILLED' } });
    const alerts: unknown[] = [];
    const send = async () => { alerts.push(1); return 'sent' as const; };

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toMatchObject({ checked: 2, stopped: 0 });
    expect(alerts).toHaveLength(0);
    expect(await store.listOrderEvents('HELD')).toEqual([]);
    expect(await store.listOrderEvents('ERR')).toEqual([]);
    expect((await store.getOrder('HELD'))?.status).toBe('held');
    expect((await store.getOrder('ERR'))?.status).toBe('error');
  });

  it('a gate hold such as refunded now stops and alerts, held once across two runs', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1');
    const admin = liveAdmin({ order: { displayFinancialStatus: 'REFUNDED' } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r1 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r1).toMatchObject({ checked: 1, cancelled: 0, addressChanged: 0, stopped: 1, unreadable: 0 });
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    // The reason that named a supplier order to pay is dropped: this row has
    // just been stopped, so telling the owner to pay it would be wrong. The
    // supplier order id is still on the row and on every console row.
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['refunded']);
    expect(o!.hold_reasons!).not.toContain('awaiting-payment:');
    expect(o?.cj_order_id).toBe('CJORD-O1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 was stopped and a supplier order exists for it');
    expect(alerts[0].text).toBe('Order #O1 was stopped by the check against Shopify (refunded). Supplier order CJORD-O1 already exists for it. Do NOT pay it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.');

    // Already held for this exact reason - left alone, no repeat alert.
    const r2 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r2).toMatchObject({ checked: 1, stopped: 0 });
    expect(alerts).toHaveLength(1);
  });

  it('an error row keeps its recorded failure reason when the pull check stops it: hold reasons hold both, the failure reason first', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O1', orderName: '#O1', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'error', holdReasons: ['fulfil: CJ returned 500 for order O1'], addressJson: JSON.stringify(ADDRESS), lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' });
    const admin = liveAdmin({ order: { displayFinancialStatus: 'REFUNDED' } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toMatchObject({ checked: 1, stopped: 1 });
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['fulfil: CJ returned 500 for order O1', 'refunded']);
    expect(alerts).toHaveLength(1);
  });

  it('a row held for address-changed-after-supplier-order keeps that reason when Shopify then says not-paid: both reasons, and the stop alert is delivered once across two runs', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O1', orderName: '#O1', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'held', holdReasons: ['address-changed-after-supplier-order'], addressJson: JSON.stringify(ADDRESS), lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' });
    const admin = liveAdmin({ order: { displayFinancialStatus: 'PENDING' } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    const r1 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r1).toMatchObject({ checked: 1, stopped: 1 });
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['address-changed-after-supplier-order', 'not-paid']);
    expect(alerts).toHaveLength(1);

    // The dedupe still works once the row carries more than one reason.
    const r2 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r2).toMatchObject({ checked: 1, stopped: 0 });
    expect(alerts).toHaveLength(1);
  });

  it('an unreadable gate writes gate-unreadable each tick and alerts once, on the fourth consecutive failure', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1');
    const admin = liveAdmin({ throws: 'gate api down' });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };

    let last;
    for (let i = 0; i < 4; i++) {
      last = await recheckUnsettledSupplierOrders(store, admin, send);
    }
    expect(last).toMatchObject({ checked: 1, cancelled: 0, addressChanged: 0, stopped: 0, unreadable: 1 });
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'gate-unreadable')).toHaveLength(4);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 cannot be checked against Shopify');
    expect(alerts[0].text).toBe('Order #O1 could not be checked against Shopify on the last 4 checks (gate api down). Supplier order CJORD-O1 exists for it. Check the order in Shopify before you pay or settle anything for it at the supplier. It is retried every 15 minutes.');
    expect((await store.getOrder('O1'))?.status).toBe('awaiting-payment'); // an unreadable gate never holds the row
  });

  it('one row whose handling throws does not stop the next row in the same tick', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'A-throws', 'CJORD-A');
    await seedAwaiting(store, 'B-ok', 'CJORD-B');
    const admin = liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } });
    const send = async () => 'sent' as const;

    const originalAddOrderEvent = TenantStore.prototype.addOrderEvent;
    vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockImplementation(function (this: TenantStore, id: string, kind: string, detail?: string | null) {
      if (id === 'A-throws' && kind === 'cancel-received') return Promise.resolve(false);
      return originalAddOrderEvent.call(this, id, kind as Parameters<typeof originalAddOrderEvent>[1], detail);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const r = await recheckUnsettledSupplierOrders(store, admin, send);

    expect(r.checked).toBe(2);
    expect((await store.getOrder('A-throws'))?.status).toBe('awaiting-payment'); // untouched by the throw
    expect((await store.getOrder('B-ok'))?.status).toBe('cancelled'); // the next row still processed
    expect(warnSpy).toHaveBeenCalled();
  });

  it('the address change records the intention to alert before it saves the address: a refused save leaves the marker, and the next run delivers', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1');
    const newAddr = { name: ADDRESS.name, address1: ADDRESS.address1, address2: ADDRESS.address2, city: 'Cardiff', province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone };
    const admin = liveAdmin({ order: { shippingAddress: newAddr } });
    const alerts: { subject: string; text: string }[] = [];
    const send = async (subject: string, text: string) => { alerts.push({ subject, text }); return 'sent' as const; };
    const subject = 'Order #O1: the delivery address changed after the supplier order was created';

    const realUpdateOrder = TenantStore.prototype.updateOrder;
    const spy = vi.spyOn(TenantStore.prototype, 'updateOrder').mockImplementation(function (this: TenantStore, id: string, fields: Record<string, unknown>) {
      if (fields.address_json) return Promise.reject(new Error('d1 refused'));
      return realUpdateOrder.call(this, id, fields);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const r1 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r1).toMatchObject({ checked: 1, addressChanged: 0 });
    expect(alerts).toHaveLength(0);
    expect((await store.getOrder('O1'))?.address_json).toBe(JSON.stringify(ADDRESS)); // not saved
    const trail = await store.listOrderEvents('O1');
    expect(trail.some((e) => e.kind === 'owner-alert-due' && e.detail === subject)).toBe(true);

    spy.mockRestore();
    const r2 = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r2).toMatchObject({ checked: 1, addressChanged: 1 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe(subject);
  });

  it('a due marker that cannot be recorded leaves the address change entirely undone', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1');
    const newAddr = { name: ADDRESS.name, address1: ADDRESS.address1, address2: ADDRESS.address2, city: 'Cardiff', province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone };
    const admin = liveAdmin({ order: { shippingAddress: newAddr } });
    const alerts: unknown[] = [];
    const send = async () => { alerts.push(1); return 'sent' as const; };

    const realAdd = TenantStore.prototype.addOrderEvent;
    vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockImplementation(function (this: TenantStore, id: string, kind: string, detail?: string | null) {
      if (kind === 'owner-alert-due') return Promise.resolve(false);
      return realAdd.call(this, id, kind as Parameters<typeof realAdd>[1], detail);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toMatchObject({ checked: 1, addressChanged: 0 });
    expect(alerts).toHaveLength(0);
    expect((await store.getOrder('O1'))?.address_json).toBe(JSON.stringify(ADDRESS));
    expect(await store.listOrderEvents('O1')).toEqual([]); // not even address-refreshed
  });

  it('a due marker that cannot be recorded leaves a stop entirely undone', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedAwaiting(store, 'O1', 'CJORD-O1');
    const admin = liveAdmin({ order: { displayFinancialStatus: 'REFUNDED' } });
    const alerts: unknown[] = [];
    const send = async () => { alerts.push(1); return 'sent' as const; };

    const realAdd = TenantStore.prototype.addOrderEvent;
    vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockImplementation(function (this: TenantStore, id: string, kind: string, detail?: string | null) {
      if (kind === 'owner-alert-due') return Promise.resolve(false);
      return realAdd.call(this, id, kind as Parameters<typeof realAdd>[1], detail);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const r = await recheckUnsettledSupplierOrders(store, admin, send);
    expect(r).toMatchObject({ checked: 1, stopped: 0 });
    expect(alerts).toHaveLength(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('awaiting-payment'); // never held
    expect(JSON.parse(o!.hold_reasons!)).toEqual([awaitingReason('CJORD-O1')]);
    expect(await store.listOrderEvents('O1')).toEqual([]); // no gate-held either
  });

  it('rotates through a backlog larger than one page: 25 rows with max 10, three consecutive ticks (15 minutes apart) each read a distinct page, covering every row exactly once', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (let i = 1; i <= 25; i++) {
      const id = 'O' + String(i).padStart(2, '0');
      await seedAwaiting(store, id, 'CJORD-' + id);
    }
    const seenIds: string[] = [];
    const admin: AdminGraphql = (async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('pawscoutOrderGate')) {
        const gid = (variables as { id?: string } | undefined)?.id ?? '';
        seenIds.push(gid.replace('gid://shopify/Order/', ''));
        return { order: { ...LIVE_ORDER } };
      }
      return {};
    }) as unknown as AdminGraphql;
    const send = async () => 'sent' as const;

    const TICK_MS = 900_000;
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const checkedCounts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await recheckUnsettledSupplierOrders(store, admin, send, { max: 10, now: new Date(base + i * TICK_MS) });
      checkedCounts.push(r.checked);
    }

    expect(checkedCounts.sort((a, b) => a - b)).toEqual([5, 10, 10]);
    expect(seenIds).toHaveLength(25);
    expect(new Set(seenIds).size).toBe(25); // every row read exactly once - none starved, none repeated
  });
});

// Owner rule 2026-09-22: freight is ALWAYS counter-checked against live CJ data
// before an order is booked. Until then the pipeline quoted ONE unit of the
// FIRST line to the DEFAULT destination (GB) whatever the order was, passed that
// channel name to the supplier, and never compared the figure with anything.
describe('live freight counter-check before the supplier order', () => {
  const US_ADDRESS = { ...ADDRESS, city: 'Austin', province: 'TX', zip: '73301', countryCode: 'US' };
  const US_LIVE = { shippingAddress: { ...(LIVE_ORDER.shippingAddress as Record<string, unknown>), city: 'Austin', province: 'TX', zip: '73301', countryCodeV2: 'US' } };
  type BasketCall = { products: { vid: string; quantity: number }[]; from: string; to: string };
  function quoting(spy: { create: unknown[]; pay: string[] }, calls: BasketCall[], answer: () => Promise<{ priceUsd: number; days: string; name: string } | null>) {
    return fakeCj(spy, {
      freightForBasket: async (products: { vid: string; quantity: number }[], from: string, to: string) => { calls.push({ products, from, to }); return answer(); },
      freightEstimate: async () => { throw new Error('the single-unit default-destination quote must not be used by the pipeline'); }
    });
  }

  it("quotes the WHOLE basket to the order's OWN destination, books that channel, and records the live figure on the trail", async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedWarehouse(store, 'CJ2', 'S2', 'v2');
    await seedRoute(store, 'CN', 'US', 5.5);
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 3, cjPid: 'CJ1' }, { sku: 'S2', quantity: 1, cjPid: 'CJ2' }], { addressJson: JSON.stringify(US_ADDRESS) });
    const spy = { create: [] as any[], pay: [] as string[] };
    const calls: BasketCall[] = [];
    const cj = quoting(spy, calls, async () => ({ priceUsd: 9.8, days: '12-20', name: 'Economy' }));
    const r = await processDueOrders(store, cj, liveAdmin({ order: US_LIVE }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0, errored: 0 });
    expect(calls).toEqual([{ products: [{ vid: 'v1', quantity: 3 }, { vid: 'v2', quantity: 1 }], from: 'CN', to: 'US' }]);
    expect(spy.create[0].logisticName).toBe('Economy');
    expect(spy.create[0].address.countryCode).toBe('US');
    const quoted = (await store.listOrderEvents('O1')).find((e) => e.kind === 'freight-quoted');
    expect(quoted?.detail).toBe('CN->US, 4 units: live USD 9.80 via Economy (12-20 days); allowed for USD 22.00');
  });

  it('holds as freight-mismatch, books nothing and tells the owner when the live supplier freight exceeds what was allowed for', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedRoute(store, 'CN', 'US', 5.5);
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 4, cjPid: 'CJ1' }], { addressJson: JSON.stringify(US_ADDRESS) });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    // allowed = 5.5 x 4 = 22.00; the hold line is 25% + USD 1 above it = 28.50
    const cj = quoting(spy, [], async () => ({ priceUsd: 40, days: '12-20', name: 'Economy' }));
    const r = await processDueOrders(store, cj, liveAdmin({ order: US_LIVE }), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
    });
    expect(r).toMatchObject({ submitted: 0, held: 1, errored: 0 });
    expect(spy.create).toHaveLength(0);
    expect(spy.pay).toHaveLength(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['freight-mismatch']);
    const events = await store.listOrderEvents('O1');
    expect(events.find((e) => e.kind === 'gate-held')?.detail).toBe('freight-mismatch: CN->US, 4 units: live USD 40.00 via Economy (12-20 days); allowed for USD 22.00');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe("Order #O1: the supplier's delivery cost is above what was allowed for");
    expect(alerts[0].text).toBe('Order #O1 is held. The supplier quotes USD 40.00 (Economy, 12-20 days) to deliver its 4 units CN->US, against USD 22.00 allowed for from the synced rate. Nothing has been sent to the supplier. Release the order in the console to book it at the live cost, or cancel it.');
  });

  it('a live figure inside the tolerance passes: 25% plus USD 1 above the allowed figure', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedRoute(store, 'CN', 'US', 5.5);
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 4, cjPid: 'CJ1' }], { addressJson: JSON.stringify(US_ADDRESS) });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = quoting(spy, [], async () => ({ priceUsd: 28.5, days: '12-20', name: 'Economy' }));
    const r = await processDueOrders(store, cj, liveAdmin({ order: US_LIVE }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0 });
    expect(spy.create).toHaveLength(1);
  });

  it("a released freight-mismatch hold is not held again for the same reason: the operator's decision outranks the counter-check, and the live channel is still the one booked", async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedRoute(store, 'CN', 'US', 5.5);
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 4, cjPid: 'CJ1' }], { addressJson: JSON.stringify(US_ADDRESS), holdReasons: ['freight-mismatch'] });
    const spy = { create: [] as any[], pay: [] as string[] };
    const alerts: unknown[] = [];
    const cj = quoting(spy, [], async () => ({ priceUsd: 40, days: '12-20', name: 'Economy' }));
    const r = await processDueOrders(store, cj, liveAdmin({ order: US_LIVE }), cfg('pawscout'), { alert: async (s, t) => { alerts.push({ s, t }); return 'sent'; } });
    expect(r).toMatchObject({ submitted: 1, held: 0 });
    expect(spy.create[0].logisticName).toBe('Economy');
    expect(alerts).toHaveLength(0);
    expect((await store.listOrderEvents('O1')).find((e) => e.kind === 'freight-quoted')?.detail).toContain('live USD 40.00');
  });

  it('no synced route to compare with: held as freight-mismatch with a detail that says so, rather than booked unchecked', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    // no CN->US route seeded
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { addressJson: JSON.stringify(US_ADDRESS) });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = quoting(spy, [], async () => ({ priceUsd: 7, days: '12-20', name: 'Economy' }));
    const r = await processDueOrders(store, cj, liveAdmin({ order: US_LIVE }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, held: 1 });
    expect(spy.create).toHaveLength(0);
    const o = await store.getOrder('O1');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['freight-mismatch']);
    expect((await store.listOrderEvents('O1')).find((e) => e.kind === 'gate-held')?.detail).toBe('freight-mismatch: CN->US, 1 unit: live USD 7.00 via Economy (12-20 days); no synced CN->US rate to compare with');
  });

  it('the supplier offers NO channel for this basket to that country: held as no-freight-route, nothing booked', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedRoute(store, 'CN', 'US', 5.5);
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { addressJson: JSON.stringify(US_ADDRESS) });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const cj = quoting(spy, [], async () => null);
    const r = await processDueOrders(store, cj, liveAdmin({ order: US_LIVE }), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, held: 1 });
    expect(spy.create).toHaveLength(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['no-freight-route']);
    expect((await store.listOrderEvents('O1')).find((e) => e.kind === 'gate-held')?.detail).toBe('no-freight-route: the supplier offers no delivery channel CN->US for this basket');
  });

  it('the live quote cannot be read: nothing is booked, the row stays queued for the next tick, and the owner is told on the fourth failure in a row', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const cj = quoting(spy, [], async () => { throw new Error('CJ HTTP 502 <html>raw supplier text</html>'); });
    for (let i = 0; i < 4; i++) {
      const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'), {
        now: atTick(i),
        alert: async (subject, text) => { alerts.push({ subject, text }); return 'sent'; }
      });
      expect(r).toMatchObject({ submitted: 0, held: 0, errored: 0 });
    }
    expect(spy.create).toHaveLength(0);
    expect((await store.getOrder('O1'))?.status).toBe('queued');
    const events = await store.listOrderEvents('O1');
    const unread = events.filter((e) => e.kind === 'freight-unreadable');
    expect(unread).toHaveLength(4);
    expect(unread.every((e) => e.detail === 'quote failed')).toBe(true); // never the supplier's raw text
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe("Order #O1: the supplier's delivery cost could not be checked");
    expect(alerts[0].text).toBe("Order #O1 is due, but the supplier's live delivery cost for it could not be read on the last 4 checks. Nothing has been sent to the supplier. It is retried every 15 minutes.");
  });

  it('a pay-retry (supplier order already exists) does not re-quote: the channel was booked when the order was created', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' }); // a pay-retry: created earlier, payment still owed
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const calls: BasketCall[] = [];
    const cj = quoting(spy, calls, async () => ({ priceUsd: 999, days: '1', name: 'Gold' }));
    const r = await processDueOrders(store, cj, liveAdmin(), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1 });
    expect(calls).toHaveLength(0);
    expect(spy.create).toHaveLength(0);
    expect(spy.pay).toEqual(['CJORD-EXISTING']);
  });
});
