import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const SHOP2 = 'b.myshopify.com';

describe('order events (order trail)', () => {
  it('numbers events 1, 2, 3 for one order, and a second order starts again at 1', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.addOrderEvent('O1', 'received');
    await store.addOrderEvent('O1', 'held');
    await store.addOrderEvent('O1', 'released');
    await store.addOrderEvent('O2', 'received');
    const o1 = await store.listOrderEvents('O1');
    const o2 = await store.listOrderEvents('O2');
    expect(o1.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(o2.map((e) => e.seq)).toEqual([1]);
  });

  it('listOrderEvents returns them in seq order with the kinds and details given', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.addOrderEvent('O1', 'received', 'first');
    await store.addOrderEvent('O1', 'gate-passed', 'second');
    const rows = await store.listOrderEvents('O1');
    expect(rows.map((e) => ({ kind: e.kind, detail: e.detail }))).toEqual([
      { kind: 'received', detail: 'first' },
      { kind: 'gate-passed', detail: 'second' }
    ]);
  });

  it('two shops with the same order id do not see each others events', async () => {
    const storeA = new TenantStore(env.DB, SHOP);
    const storeB = new TenantStore(env.DB, SHOP2);
    await storeA.addOrderEvent('O1', 'received');
    await storeB.addOrderEvent('O1', 'held');
    const rowsA = await storeA.listOrderEvents('O1');
    const rowsB = await storeB.listOrderEvents('O1');
    expect(rowsA.map((e) => e.kind)).toEqual(['received']);
    expect(rowsB.map((e) => e.kind)).toEqual(['held']);
  });

  it('detail longer than 300 characters is stored cut to 300', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // Head and tail differ, so keeping the LAST 300 characters would fail too.
    const long = 'a'.repeat(300) + 'b'.repeat(100);
    await store.addOrderEvent('O1', 'error', long);
    const rows = await store.listOrderEvents('O1');
    expect(rows[0].detail).toBe('a'.repeat(300));
  });

  it('addOrderEvent does not throw when the database throws', async () => {
    const fakeDb = { prepare: () => { throw new Error('db unavailable'); } };
    const store = new TenantStore(fakeDb as unknown as D1Database, SHOP);
    await expect(store.addOrderEvent('O1', 'error')).resolves.toBeUndefined();
  });

  it('countTrailingOrderEvents counts the run of a matching kind at the tail', async () => {
    const store = new TenantStore(env.DB, SHOP);
    expect(await store.countTrailingOrderEvents('O1', 'gate-unreadable')).toBe(0);
    await store.addOrderEvent('O1', 'gate-passed');
    await store.addOrderEvent('O1', 'gate-unreadable');
    await store.addOrderEvent('O1', 'gate-unreadable');
    expect(await store.countTrailingOrderEvents('O1', 'gate-unreadable')).toBe(2);
    await store.addOrderEvent('O1', 'gate-passed');
    expect(await store.countTrailingOrderEvents('O1', 'gate-unreadable')).toBe(0);
  });

  it('redactOrders removes O1 events and leaves O2 events', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.addOrderEvent('O1', 'received');
    await store.addOrderEvent('O2', 'received');
    await store.redactOrders(['O1']);
    expect(await store.listOrderEvents('O1')).toEqual([]);
    expect((await store.listOrderEvents('O2')).length).toBe(1);
  });

  it('redactShop removes every event for the shop and leaves another shop untouched', async () => {
    const storeA = new TenantStore(env.DB, SHOP);
    const storeB = new TenantStore(env.DB, SHOP2);
    await storeA.addOrderEvent('O1', 'received');
    await storeB.addOrderEvent('O1', 'received');
    await storeA.redactShop();
    expect(await storeA.listOrderEvents('O1')).toEqual([]);
    expect((await storeB.listOrderEvents('O1')).length).toBe(1);
  });

  it('updateOrder changes address_json and leaves status alone', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({
      shopifyOrderId: 'O1', orderName: '#1', totalPrice: 10, currency: 'GBP', financialStatus: 'paid',
      riskLevel: null, status: 'queued', holdReasons: [], addressJson: '{"city":"A"}', lineItemsJson: null, fulfilAfter: null
    });
    await store.updateOrder('O1', { address_json: '{"city":"X"}' });
    const order = await store.getOrder('O1');
    expect(order?.address_json).toBe('{"city":"X"}');
    expect(order?.status).toBe('queued');
  });
});

describe('updateOrderUnlessCancelled', () => {
  it('writes a queued row and answers true', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({
      shopifyOrderId: 'O1', orderName: '#1', totalPrice: 10, currency: 'GBP', financialStatus: 'paid',
      riskLevel: null, status: 'queued', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null
    });
    const wrote = await store.updateOrderUnlessCancelled('O1', { status: 'submitted' });
    expect(wrote).toBe(true);
    expect((await store.getOrder('O1'))?.status).toBe('submitted');
  });

  it('leaves a cancelled row byte for byte and answers false', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({
      shopifyOrderId: 'O1', orderName: '#1', totalPrice: 10, currency: 'GBP', financialStatus: 'paid',
      riskLevel: null, status: 'cancelled', holdReasons: ['shopify-cancelled'], addressJson: null, lineItemsJson: null, fulfilAfter: null
    });
    await store.updateOrder('O1', { cj_order_id: 'CJORD-1' });
    const before = await store.getOrder('O1');
    const wrote = await store.updateOrderUnlessCancelled('O1', { status: 'submitted', hold_reasons: JSON.stringify(['x']), cj_order_id: 'CJORD-2' });
    expect(wrote).toBe(false);
    const after = await store.getOrder('O1');
    expect(after?.status).toBe(before?.status);
    expect(after?.hold_reasons).toBe(before?.hold_reasons);
    expect(after?.cj_order_id).toBe(before?.cj_order_id);
  });

  it('an unknown order answers false', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const wrote = await store.updateOrderUnlessCancelled('NOPE', { status: 'submitted' });
    expect(wrote).toBe(false);
  });

  it('does not touch another shop\'s row with the same order id', async () => {
    const storeA = new TenantStore(env.DB, SHOP);
    const storeB = new TenantStore(env.DB, SHOP2);
    await storeA.insertOrderIfNew({
      shopifyOrderId: 'O1', orderName: '#1', totalPrice: 10, currency: 'GBP', financialStatus: 'paid',
      riskLevel: null, status: 'queued', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null
    });
    const wrote = await storeB.updateOrderUnlessCancelled('O1', { status: 'submitted' });
    expect(wrote).toBe(false);
    expect((await storeA.getOrder('O1'))?.status).toBe('queued');
  });
});
