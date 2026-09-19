import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { processDueOrders, pollTracking, isStockoutError, type StockoutNotice } from '../src/fulfil-run';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_INBOX, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
function cfg(mode: 'manual' | 'pawscout' | 'cj', createOnly = false): TenantConfig {
  return { collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: { mode, createOnly }, inbox: DEFAULT_INBOX, target: 12 };
}
const ADDRESS = { name: 'Jane', phone: '07000', address1: '1 St', address2: '', city: 'London', province: 'England', zip: 'E1 1AA', countryCode: 'GB' };
const PAST = new Date(Date.now() - 1000).toISOString();

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
    freightEstimate: async () => ({ priceUsd: 2, days: '8-12', name: 'CJPacket' }),
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
        alert: async (subject, text) => { alerts.push({ subject, text }); }
      });
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #6: tracking could not be written to Shopify');
    expect(alerts[0].text).toBe('Supplier order CJORD-O6 has shipped with tracking TRK1, but writing it to Shopify failed on the last 4 attempts (write failed). The customer has not been told. It is retried every 15 minutes.');
    const events = await store.listOrderEvents('O6');
    expect(events.filter((e) => e.kind === 'tracking-write-failed')).toHaveLength(4);
    expect(events.map((e) => e.kind)).toContain('owner-alerted');
    expect((await store.getOrder('O6'))?.status).toBe('submitted');
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
      alert: async (s, t) => { alerts.push({ s, t }); }
    });
    expect(r).toMatchObject({ submitted: 0, held: 0, errored: 0 });
    expect(spy.create.length).toBe(0);
    expect((await store.getOrder('O1'))?.status).toBe('queued');
    const events = await store.listOrderEvents('O1');
    expect(events.some((e) => e.kind === 'gate-unreadable')).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  it('gate read throws on four consecutive runs: exactly ONE alert, on the fourth', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const admin = liveAdmin({ throws: 'gate api down' });
    const alerts: { subject: string; text: string }[] = [];
    for (let i = 0; i < 4; i++) {
      await processDueOrders(store, fakeCj({ create: [], pay: [] }), admin, cfg('pawscout'), {
        alert: async (subject, text) => { alerts.push({ subject, text }); }
      });
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 cannot be checked against Shopify');
    expect(alerts[0].text).toBe('Order #O1 is due, but its state in Shopify could not be read on the last 4 checks (gate api down). Nothing has been sent to the supplier. It is retried every 15 minutes.');
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'gate-unreadable')).toHaveLength(4);
    expect(events.map((e) => e.kind)).toContain('owner-alerted');
    expect((await store.getOrder('O1'))?.status).toBe('queued');
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
      alert: async (subject, text) => { alerts.push({ subject, text }); }
    });
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length).toBe(0); // no re-create (already existed)
    expect(spy.pay.length).toBe(0); // NOT paid
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1: payment to the supplier was stopped');
    expect(alerts[0].text).toContain('CJORD-EXISTING');
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('cancelled');
    expect(o?.cj_order_id).toBe('CJORD-EXISTING');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toContain('owner-alerted');
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
      alert: async (s, t) => { alerts.push({ s, t }); }
    });
    expect(r).toMatchObject({ held: 1 });
    expect(spy.create.length).toBe(0);
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('held');
    expect(JSON.parse(o!.hold_reasons!)).toEqual(['mixed-origin']);
    const events = await store.listOrderEvents('O1');
    expect(events.some((e) => e.kind === 'gate-held' && e.detail?.startsWith('mixed-origin:'))).toBe(true);
    expect(alerts).toHaveLength(0); // fix round 2, NEW-1: no supplier order exists, so no alert
  });

  it('a changed Shopify address is used for creation and persisted with an address-refreshed event', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as any[], pay: [] as string[] };
    const newAddr = { name: ADDRESS.name, address1: ADDRESS.address1, address2: ADDRESS.address2, city: 'Manchester', province: ADDRESS.province, zip: ADDRESS.zip, countryCodeV2: 'GB', phone: ADDRESS.phone };
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { shippingAddress: newAddr } }), cfg('pawscout', true));
    expect(r).toMatchObject({ awaiting: 1 });
    expect(spy.create[0].address).toMatchObject({ city: 'Manchester' });
    const o = await store.getOrder('O1');
    expect(JSON.parse(o!.address_json!)).toMatchObject({ city: 'Manchester' });
    const events = await store.listOrderEvents('O1');
    expect(events.some((e) => e.kind === 'address-refreshed')).toBe(true);
  });

  it('a happy createOnly run leaves the trail: gate-passed, stock-ok, supplier-order-created, awaiting-payment', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const r = await processDueOrders(store, fakeCj({ create: [], pay: [] }), liveAdmin(), cfg('pawscout', true));
    expect(r).toMatchObject({ awaiting: 1 });
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['gate-passed', 'stock-ok', 'supplier-order-created', 'awaiting-payment']);
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

describe('I-3 (fix round 1): a cancelled row stays cancelled', () => {
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
      alert: async (subject, text) => { alerts.push({ subject, text }); }
    });
    expect(r).toMatchObject({ held: 1, awaiting: 0 });
    expect(notifies).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('Order #O1 was cancelled while its supplier order was being created');
    expect(alerts[0].text).toBe('Order #O1 was cancelled in Shopify while supplier order CJORD-O1 was being created. Do NOT pay it. Cancel it at the supplier.');
    const o = await store.getOrder('O1');
    expect(o?.status).toBe('cancelled');
    const events = await store.listOrderEvents('O1');
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('supplier-order-created');
    expect(kinds).not.toContain('awaiting-payment');
    expect(kinds).toContain('owner-alerted');
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
      alert: async (subject, text) => { alerts.push({ subject, text }); }
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

describe('I-1 (fix round 1): a gate stop on a row with an existing supplier order alerts', () => {
  it('a queued row with cj_order_id whose gate says cancelled: exact alert, row cancelled, no create/pay', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-RELEASED' }); // released back to queued, supplier order still exists
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { cancelledAt: '2026-09-19T00:00:00Z' } }), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); }
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
  });

  it('a queued row with cj_order_id whose gate holds (refunded): same alert shape with the hold reason', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-RELEASED' });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin({ order: { displayFinancialStatus: 'REFUNDED' } }), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); }
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
      alert: async (s, t) => { alerts.push({ s, t }); }
    });
    expect(r).toMatchObject({ held: 1 });
    expect(alerts).toHaveLength(0);
  });
});

describe('I-2 (fix round 1): the gate-unreadable alert is true wherever it fires', () => {
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
        alert: async (subject, text) => { alerts.push({ subject, text }); }
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
        alert: async (subject, text) => { alerts.push({ subject, text }); }
      });
    }
    expect(spy.pay.length).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe('Order #O1 could not be checked against Shopify on the last 4 checks (gate api down). Supplier order CJORD-O1 exists for it, and PawScout will not pay it until the check succeeds. It is retried every 15 minutes.');
  });
});

describe('M-2 (fix round 1): no latch - a >= 4 comparison, not === 4', () => {
  it('seeding FIVE trailing gate-unreadable events (a lost alert marker) still alerts on the next failure', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    for (let i = 0; i < 5; i++) await store.addOrderEvent('O1', 'gate-unreadable', 'prior failure');
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj({ create: [], pay: [] }), liveAdmin({ throws: 'gate api down' }), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); }
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
      alert: async (subject, text) => { alerts.push({ subject, text }); }
    });
    expect(alerts).toHaveLength(1);
    const events = await store.listOrderEvents('O8');
    expect(events.filter((e) => e.kind === 'tracking-write-failed')).toHaveLength(6);
  });
});

describe('I-4 (fix round 1): trail detail is classified, never a copy of the raw error', () => {
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

describe('M-7 (fix round 1): operator release skips the FRAUD check only when the hold WAS a fraud hold', () => {
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

describe('NEW-1 (fix round 2): a mixed-origin hold on a row with an existing supplier order alerts', () => {
  it('a queued row WITH cj_order_id whose lines now resolve to two origins: held, the exact I-1 alert with the mixed-origin reason, nothing paid', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1'); // origin CN
    const detailGb: CjDetail = { pid: 'CJ2', nameEn: 'Y', images: [], descriptionHtml: '', variants: [{ vid: 'v2', name: 'Blue', sellPriceUsd: 10, sku: 'S2' }], listedNum: 1, categoryName: 'Pet Toys', origin: 'GB' };
    await store.putWarehouseProduct({ cjPid: 'CJ2', category: 'pet-toys', title: 'Y', detailJson: JSON.stringify(detailGb), priceUsd: 10, listedNum: 1, stock: 50 });
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }, { sku: 'S2', quantity: 1, cjPid: 'CJ2' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' }); // released back to queued, supplier order still exists
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const alerts: { subject: string; text: string }[] = [];
    const r = await processDueOrders(store, fakeCj(spy), liveAdmin(), cfg('pawscout'), {
      alert: async (subject, text) => { alerts.push({ subject, text }); }
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

describe('NEW-3 (fix round 2): step starts at "gate", not "resolve"', () => {
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
