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
const noAdmin: AdminGraphql = (async () => ({})) as unknown as AdminGraphql;

describe('processDueOrders', () => {
  it('is a no-op when autopay is OFF (orders stay queued, nothing paid)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), noAdmin, cfg('manual'));
    expect(r).toMatchObject({ skipped: true, submitted: 0 });
    expect(spy.create.length + spy.pay.length).toBe(0);
    expect((await store.getOrder('O1'))?.status).toBe('queued');
  });

  it('creates + pays a due order and resolves the vid from the sku', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 2, cjPid: 'CJ1' }]);
    const spy = { create: [] as any[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), noAdmin, cfg('pawscout'));
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
    const r = await processDueOrders(store, cj, noAdmin, cfg('pawscout', true));
    expect(r).toMatchObject({ awaiting: 1, errored: 0 });
    expect(spy.create[0].products).toEqual([{ vid: 'vLIVE', quantity: 1 }]);
  });

  it('errors (no pay) when the vid cannot be resolved', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', [{ sku: 'MISSING', quantity: 1, cjPid: 'CJ-UNKNOWN' }]); // no warehouse row
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), noAdmin, cfg('pawscout'));
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
    const r = await processDueOrders(store, cj, noAdmin, cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, errored: 1 });
    expect(spy.pay.length).toBe(0);
    expect((await store.getOrder('O1'))?.status).toBe('error');
  });

  it('createOnly: creates the CJ order but does NOT pay (awaiting-payment)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), noAdmin, cfg('pawscout', true));
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
    const r = await processDueOrders(store, fakeCj({ create: [], pay: [] }), noAdmin, cfg('pawscout', true), {
      notify: async (n) => { notes.push({ cjOrderId: n.cjOrderId, orderName: n.orderName }); }
    });
    expect(r).toMatchObject({ awaiting: 1 });
    expect(notes).toEqual([{ cjOrderId: 'CJORD-O1', orderName: '#O1' }]);
  });

  it('a notify failure does not fail the order (still awaiting-payment)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const r = await processDueOrders(store, fakeCj({ create: [], pay: [] }), noAdmin, cfg('pawscout', true), {
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
    const r = await processDueOrders(store, cj, noAdmin, cfg('pawscout'));
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
    const r = await processDueOrders(store, cj, noAdmin, cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 0, awaiting: 0, errored: 1 });
    expect((await store.getOrder('O1'))?.status).toBe('error');
  });

  it('skips re-create and only pays when cj_order_id is already set (retry-safe)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { cjOrderId: undefined });
    await store.updateOrder('O1', { cj_order_id: 'CJORD-EXISTING' }); // simulate created-but-unpaid
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), noAdmin, cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1 });
    expect(spy.create.length).toBe(0); // did NOT duplicate the CJ order
    expect(spy.pay).toEqual(['CJORD-EXISTING']);
  });
});

describe('source-stockout handling (sold out at CJ after we sold it)', () => {
  interface Call { query: string; variables?: Record<string, unknown> }
  /** Admin mock that answers the inventory-zero flow (location -> variants -> set 0). */
  function zeroAdmin(calls: Call[]): AdminGraphql {
    return (async (query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables });
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
    const r = await processDueOrders(store, cj, noAdmin, cfg('pawscout'));
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
    const r = await processDueOrders(store, cj, noAdmin, cfg('pawscout'), { notifyStockout: async (n) => { notices.push(n); } });
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
      if (query.includes('fulfillmentCreateV2')) return { fulfillmentCreateV2: { fulfillment: { id: 'f1', status: 'SUCCESS' }, userErrors: [] } };
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
    const fulfil = calls.find((c) => c.q.includes('fulfillmentCreateV2'));
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
    const fulfil = calls.find((c) => c.q.includes('fulfillmentCreateV2'));
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
});

describe('Stage-B risk gate (2026-07-19: risk fetched before money moves)', () => {
  // AdminGraphql that answers the order-risk query with a fixed recommendation
  // and records every query it receives.
  function riskAdmin(recommendation: string | null, calls: string[] = []): AdminGraphql {
    return (async (q: string) => {
      calls.push(q);
      if (q.includes('risk')) {
        if (recommendation === null) throw new Error('risk api down');
        return { order: { risk: { recommendation } } };
      }
      return {};
    }) as unknown as AdminGraphql;
  }

  it('holds a CANCEL-recommended order BEFORE any CJ spend (high-risk)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), riskAdmin('CANCEL'), cfg('pawscout'));
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
    const r = await processDueOrders(store, fakeCj(spy), riskAdmin('INVESTIGATE'), cfg('pawscout'));
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
    const r = await processDueOrders(store, fakeCj(spy), riskAdmin('INVESTIGATE'), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0 });
    expect((await store.getOrder('O1'))).toMatchObject({ status: 'submitted', risk_level: 'MEDIUM' });
  });

  it('fails OPEN when the risk read errors (order still submits)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), riskAdmin(null), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0, errored: 0 });
  });

  it('skips the risk check for an operator-released order (their decision wins)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    // Held at webhook time, operator released it back to queued - hold history remains.
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }], { holdReasons: ['high-risk'] });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const calls: string[] = [];
    const r = await processDueOrders(store, fakeCj(spy), riskAdmin('CANCEL', calls), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0 });
    expect(calls.some((q) => q.includes('risk'))).toBe(false); // never even asked
  });

  it('skips the risk check on a pay-retry (CJ order already exists)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedWarehouse(store, 'CJ1', 'S1', 'v1');
    await seedOrder(store, 'O1', [{ sku: 'S1', quantity: 1, cjPid: 'CJ1' }]);
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' });
    const spy = { create: [] as unknown[], pay: [] as string[] };
    const r = await processDueOrders(store, fakeCj(spy), riskAdmin('CANCEL'), cfg('pawscout'));
    expect(r).toMatchObject({ submitted: 1, held: 0 });
    expect(spy.pay).toEqual(['CJORD-O1']); // paid the existing order, no re-create
  });
});
