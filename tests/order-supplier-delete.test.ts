/// <reference types="@cloudflare/vitest-pool-workers" />
// "Delete at CJ" (owner 2026-10-09): a cancelled order's supplier order can be
// removed at CJ from the console, so it can never be paid by mistake. CJ's
// Order Delete takes only an order that is CREATED or IN_CART; an order CJ
// shows as paid, or in any later state, is refused here before CJ is asked.
// The order is found by the order number PawScout gave CJ, because a failed
// create can leave a supplier order PawScout never recorded (#1002).
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { TenantStore, type OrderRow } from '../src/tenant-store';
import { deleteSupplierOrder, supplierDeleteRefusal, type SupplierOrderDeleter } from '../src/order-supplier-delete';
import { app } from '../src/index';
import type { Env } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'del.myshopify.com';

async function seed(store: TenantStore, id: string, status: OrderRow['status'], cj: string | null = null, ownerPaidAt: string | null = null): Promise<OrderRow> {
  // A paid mark is made the only way it can be: "I paid this" on an
  // awaiting-payment row, which then moves on to the status asked for.
  await store.insertOrderIfNew({
    shopifyOrderId: id, orderName: '#' + id, totalPrice: 9.99, currency: 'GBP', financialStatus: 'paid', riskLevel: null,
    status: ownerPaidAt ? 'awaiting-payment' : status, holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null
  });
  if (cj) await store.updateOrder(id, { cj_order_id: cj });
  if (ownerPaidAt) {
    expect(await store.markOrderPaidByOwner(id, ownerPaidAt)).toBe(true);
    await store.updateOrder(id, { status });
  }
  return (await store.getOrder(id))!;
}

type Found = Awaited<ReturnType<SupplierOrderDeleter['findOrderByNumber']>>;
function held(id: string, status: string, extra: Partial<NonNullable<Found>> = {}): Found {
  return { cjOrderId: `SD-${id}`, numericId: `N-${id}`, orderNum: id, status, paymentDate: null, ...extra };
}
// A fake CJ: answers the lookups in turn (the last one repeats), records deletes.
function fakeCj(answers: Array<Found | Error>, deleteError?: Error) {
  const lookups: string[] = [];
  const deletes: string[] = [];
  const cj: SupplierOrderDeleter = {
    async findOrderByNumber(n: string) {
      lookups.push(n);
      const a = answers[Math.min(lookups.length - 1, answers.length - 1)];
      if (a instanceof Error) throw a;
      return a;
    },
    async deleteOrder(id: string) {
      deletes.push(id);
      if (deleteError) throw deleteError;
    }
  };
  return { cj, lookups, deletes };
}

describe('supplierDeleteRefusal', () => {
  it('refuses any order that is not cancelled, and a cancelled one the owner marked paid', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const s of ['held', 'queued', 'submitted', 'awaiting-payment', 'fulfilled', 'error'] as const) {
      expect(supplierDeleteRefusal(await seed(store, `S-${s}`, s, 'SD1'))).toMatch(/Only a cancelled order/);
    }
    expect(supplierDeleteRefusal(await seed(store, 'P1', 'cancelled', 'SD1', '2026-10-08T00:00:00.000Z'))).toMatch(/marked this order as paid/);
    expect(supplierDeleteRefusal(await seed(store, 'C1', 'cancelled', 'SD1'))).toBeNull();
    expect(supplierDeleteRefusal(await seed(store, 'C2', 'cancelled', null))).toBeNull();
  });
});

describe('deleteSupplierOrder', () => {
  it('deletes a cancelled order CJ holds as CREATED, by its numeric id, then reads it back and records it', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const o = await seed(store, '8506621854034', 'cancelled', 'SD2610081831150667400');
    const { cj, lookups, deletes } = fakeCj([held('8506621854034', 'CREATED'), held('8506621854034', 'TRASH')]);
    expect(await deleteSupplierOrder(store, cj, o)).toEqual({ ok: true, cjOrderId: 'SD-8506621854034', before: 'CREATED', after: 'TRASH', readBack: true });
    expect(lookups).toEqual(['8506621854034', '8506621854034']);
    expect(deletes).toEqual(['N-8506621854034']);
    expect((await store.listOrderEvents('8506621854034')).map((e) => [e.kind, e.detail])).toEqual([['supplier-order-deleted', 'SD-8506621854034']]);
    expect((await store.getOrder('8506621854034'))!.status).toBe('cancelled');
  });

  it('finds an order PawScout never recorded a supplier id for (#1002), and takes IN_CART too', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const o = await seed(store, '8505727222098', 'cancelled', null);
    const { cj, deletes } = fakeCj([held('8505727222098', 'IN_CART'), null]);
    expect(await deleteSupplierOrder(store, cj, o)).toEqual({ ok: true, cjOrderId: 'SD-8505727222098', before: 'IN_CART', after: null, readBack: true });
    expect(deletes).toEqual(['N-8505727222098']);
  });

  it('still reports the delete, and its trail, when reading it back fails', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const o = await seed(store, 'R1', 'cancelled');
    const { cj } = fakeCj([held('R1', 'CREATED'), new Error('timeout')]);
    expect(await deleteSupplierOrder(store, cj, o)).toEqual({ ok: true, cjOrderId: 'SD-R1', before: 'CREATED', after: null, readBack: false });
    expect((await store.listOrderEvents('R1')).map((e) => e.kind)).toEqual(['supplier-order-deleted']);
  });

  it('asks CJ nothing for an order the store-side check refuses', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const o = await seed(store, 'H1', 'held', 'SD1');
    const { cj, lookups, deletes } = fakeCj([held('H1', 'CREATED')]);
    const r = await deleteSupplierOrder(store, cj, o);
    expect(r).toMatchObject({ ok: false, code: 409 });
    expect(lookups).toEqual([]);
    expect(deletes).toEqual([]);
  });

  const refusals: Array<[string, Found | Error, RegExp, 409 | 502]> = [
    ['CJ holds nothing under the number', null, /holds no order under order number X1/, 409],
    ['CJ answers a different number', held('OTHER', 'CREATED'), /answered with order number OTHER/, 409],
    ['CJ already shows it as TRASH', held('X1', 'TRASH'), /already shows this order as TRASH/, 409],
    ['CJ already shows it as CANCELLED', held('X1', 'cancelled'), /already shows this order as CANCELLED/, 409],
    ['CJ shows it UNPAID', held('X1', 'UNPAID'), /shows this order as UNPAID.*only an order that is CREATED or IN_CART/, 409],
    ['CJ shows it shipped', held('X1', 'SHIPPED'), /shows this order as SHIPPED/, 409],
    ['CJ shows a payment', held('X1', 'CREATED', { paymentDate: '2026-10-09 10:00:00' }), /shows a payment on this order/, 409],
    ['CJ gives no numeric id', held('X1', 'CREATED', { numericId: null }), /no order id to delete it by/, 409],
    ['the lookup fails', new Error('CJ down'), /Could not read the order at CJ \(CJ down\)/, 502]
  ];
  for (const [name, answer, message, code] of refusals) {
    it(`deletes nothing and records nothing when ${name}`, async () => {
      const store = new TenantStore(env.DB, SHOP);
      const o = await seed(store, 'X1', 'cancelled', 'SD-X1');
      const { cj, deletes } = fakeCj([answer]);
      const r = await deleteSupplierOrder(store, cj, o);
      expect(r).toMatchObject({ ok: false, code });
      expect(r.ok ? '' : r.error).toMatch(message);
      expect(deletes).toEqual([]);
      expect(await store.listOrderEvents('X1')).toEqual([]);
    });
  }

  it("passes on CJ's refusal of the delete and records nothing", async () => {
    const store = new TenantStore(env.DB, SHOP);
    const o = await seed(store, 'X2', 'cancelled');
    const { cj, deletes } = fakeCj([held('X2', 'CREATED')], new Error('Param error (CJ code 1600100, /shopping/order/deleteOrder)'));
    const r = await deleteSupplierOrder(store, cj, o);
    expect(r).toEqual({ ok: false, code: 502, error: 'CJ refused the delete: Param error (CJ code 1600100, /shopping/order/deleteOrder). Nothing changed in PawScout.' });
    expect(deletes).toEqual(['N-X2']);
    expect(await store.listOrderEvents('X2')).toEqual([]);
  });
});

const OP_SECRET = 'test-shopify-secret';
async function bearer(shop: string): Promise<string> {
  return new SignJWT({ dest: `https://${shop}`, sub: '1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience((env as unknown as Env).SHOPIFY_API_KEY)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(OP_SECRET));
}
async function post(path: string, body: unknown) {
  const e = { ...env, SHOPIFY_API_SECRET: OP_SECRET } as unknown as Env;
  const res = await app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await bearer(SHOP)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, e);
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

describe('the console action', () => {
  it('refuses an unknown order, a row that is not cancelled, and a cancelled one while CJ is not connected', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    await seed(store, 'H1', 'held', 'SD1');
    await seed(store, 'C1', 'cancelled', 'SD2');
    expect((await post('/api/order-action', { id: 'NOPE', action: 'cj-delete' })).status).toBe(404);
    const h = await post('/api/order-action', { id: 'H1', action: 'cj-delete' });
    expect(h.status).toBe(409);
    expect(String(h.json.error)).toMatch(/Only a cancelled order/);
    const c = await post('/api/order-action', { id: 'C1', action: 'cj-delete' });
    expect(c).toMatchObject({ status: 409, json: { ok: false, error: 'CJ not connected' } });
    expect((await store.getOrder('H1'))!.status).toBe('held');
    expect(await store.listOrderEvents('C1')).toEqual([]);
  });
});
