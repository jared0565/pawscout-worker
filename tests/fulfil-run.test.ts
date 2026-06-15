import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { processDueOrders, pollTracking } from '../src/fulfil-run';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
function cfg(mode: 'manual' | 'pawscout' | 'cj', createOnly = false): TenantConfig {
  return { collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: { mode, createOnly }, target: 12 };
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
    createOrder: async (input: { orderNumber: string }) => { spy.create.push(input); return { orderId: 'CJORD-' + input.orderNumber, orderNum: input.orderNumber }; },
    payBalance: async (id: string) => { spy.pay.push(id); },
    getOrderDetail: async (id: string) => ({ orderId: id, orderNum: '', trackNumber: 'TRK1', logisticName: 'CJPacket', status: 'shipped' }),
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

describe('pollTracking', () => {
  function fulfilAdmin(calls: { q: string }[]): AdminGraphql {
    return (async (query: string) => {
      calls.push({ q: query });
      if (query.includes('fulfillmentOrders')) return { order: { fulfillmentOrders: { nodes: [{ id: 'gid://fo/1', status: 'OPEN' }] } } };
      if (query.includes('fulfillmentCreateV2')) return { fulfillmentCreateV2: { fulfillment: { id: 'f1', status: 'SUCCESS' }, userErrors: [] } };
      throw new Error('unexpected: ' + query.slice(0, 30));
    }) as unknown as AdminGraphql;
  }

  it('writes tracking to Shopify and marks fulfilled when a track number appears', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O1', orderName: '#1', totalPrice: 15, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('O1', { cj_order_id: 'CJORD-O1' });
    const calls: { q: string }[] = [];
    const r = await pollTracking(store, fakeCj({ create: [], pay: [] }), fulfilAdmin(calls));
    expect(r).toEqual({ checked: 1, fulfilled: 1 });
    expect(calls.some((c) => c.q.includes('fulfillmentCreateV2'))).toBe(true);
    expect(await store.getOrder('O1')).toMatchObject({ status: 'fulfilled', tracking_number: 'TRK1' });
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
    const cj = fakeCj({ create: [], pay: [] }, { getOrderDetail: async (id: string) => ({ orderId: id, orderNum: '', trackNumber: '', logisticName: '', status: 'processing' }) });
    const r = await pollTracking(store, cj, fulfilAdmin([]));
    expect(r).toEqual({ checked: 1, fulfilled: 0 });
    expect((await store.getOrder('O1'))?.status).toBe('submitted');
  });
});
