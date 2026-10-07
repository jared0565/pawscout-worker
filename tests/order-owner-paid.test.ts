/// <reference types="@cloudflare/vitest-pool-workers" />
// "I paid this" (aramid 87a8dc74, owner 2026-10-07): the owner can tell
// PawScout that a supplier order it did not pay has been paid by hand. The row
// keeps its awaiting-payment status, so the 15 minute cancellation re-check
// and the tracking poll both still watch it; what changes is that nothing asks
// the owner to pay it any more, and nothing in PawScout ever pays it.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { TenantStore, type OrderRow } from '../src/tenant-store';
import { applyCancel } from '../src/order-cancel';
import { getGlance } from '../src/console/routes';
import { app } from '../src/index';
import type { Env } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'op.myshopify.com';
const AT = '2026-10-07T16:00:00.000Z';

async function seed(store: TenantStore, id: string, status: OrderRow['status'], cj: string | null = `CJ-${id}`) {
  await store.insertOrderIfNew({
    shopifyOrderId: id, orderName: '#' + id, totalPrice: 20, currency: 'GBP', financialStatus: 'paid', riskLevel: null,
    status, holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null
  });
  if (cj) await store.updateOrder(id, { cj_order_id: cj, hold_reasons: JSON.stringify([`awaiting-payment: CJ order ${cj} is not paid by PawScout`]) });
}

describe('marking a supplier order paid by hand', () => {
  it('marks an awaiting-payment row that has a supplier order: the status stays, the reason says who paid', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seed(store, 'O1', 'awaiting-payment');
    expect(await store.markOrderPaidByOwner('O1', AT)).toBe(true);
    const o = (await store.getOrder('O1'))!;
    expect(o.status).toBe('awaiting-payment');
    expect(o.owner_paid_at).toBe(AT);
    expect(JSON.parse(o.hold_reasons!)).toEqual(['owner-paid: CJ order CJ-O1 was paid by you at the supplier']);
  });

  it('refuses a row in any other status, one with no supplier order, and one already marked', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const s of ['held', 'queued', 'submitted', 'fulfilled', 'cancelled', 'error'] as const) {
      await seed(store, `S-${s}`, s);
      expect(await store.markOrderPaidByOwner(`S-${s}`, AT)).toBe(false);
      expect((await store.getOrder(`S-${s}`))!.owner_paid_at).toBeNull();
    }
    await seed(store, 'NOCJ', 'awaiting-payment', null);
    expect(await store.markOrderPaidByOwner('NOCJ', AT)).toBe(false);
    await seed(store, 'TWICE', 'awaiting-payment');
    expect(await store.markOrderPaidByOwner('TWICE', AT)).toBe(true);
    expect(await store.markOrderPaidByOwner('TWICE', '2026-10-08T00:00:00.000Z')).toBe(false);
    expect((await store.getOrder('TWICE'))!.owner_paid_at).toBe(AT);
  });

  it('can be undone while the row is still awaiting payment: the mark goes and the not-paid-by-PawScout reason comes back', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seed(store, 'O1', 'awaiting-payment');
    expect(await store.unmarkOrderPaidByOwner('O1')).toBe(false); // nothing to undo yet
    await store.markOrderPaidByOwner('O1', AT);
    expect(await store.unmarkOrderPaidByOwner('O1')).toBe(true);
    const o = (await store.getOrder('O1'))!;
    expect(o.status).toBe('awaiting-payment');
    expect(o.owner_paid_at).toBeNull();
    expect(JSON.parse(o.hold_reasons!)).toEqual(['awaiting-payment: CJ order CJ-O1 is not paid by PawScout']);
  });

  it('a marked row is still watched: the cancellation re-check and the tracking poll both still select it', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seed(store, 'O1', 'awaiting-payment');
    await store.markOrderPaidByOwner('O1', AT);
    expect((await store.listUnsettledSupplierOrders(20, 0)).map((o) => o.shopify_order_id)).toEqual(['O1']);
    expect(await store.countUnsettledSupplierOrders()).toBe(1);
    expect((await store.listOrders('awaiting-payment', 30)).map((o) => o.shopify_order_id)).toEqual(['O1']);
  });

  it('only unmarked rows count as waiting for the owner to pay', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seed(store, 'O1', 'awaiting-payment');
    await seed(store, 'O2', 'awaiting-payment');
    expect(await store.countAwaitingOwnerPayment()).toBe(2);
    await store.markOrderPaidByOwner('O1', AT);
    expect(await store.countAwaitingOwnerPayment()).toBe(1);
  });
});

describe('what the owner is told about a marked row', () => {
  it('the console overview stops listing it among the orders PawScout has not paid', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    await seed(store, 'O1', 'awaiting-payment');
    await seed(store, 'O2', 'awaiting-payment');
    const title = async () => (await getGlance(env.DB, SHOP)).attention.find((a) => /PawScout has not paid/.test(a.title))?.title;
    expect(await title()).toBe('2 CJ orders PawScout has not paid');
    await store.markOrderPaidByOwner('O1', AT);
    expect(await title()).toBe('1 CJ order PawScout has not paid');
    await store.markOrderPaidByOwner('O2', AT);
    expect(await title()).toBeUndefined();
  });

  it('a cancellation says the owner marked it paid, and never that PawScout cannot see the payment', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seed(store, 'O1', 'awaiting-payment');
    await store.markOrderPaidByOwner('O1', AT);
    const outcome = await applyCancel(store, 'O1');
    expect(outcome.alert).toEqual({
      subject: 'Order #O1 was cancelled after you paid its supplier order',
      text: 'Order #O1 was cancelled in Shopify. Supplier order CJ-O1 was created for it, and on 2026-10-07 you marked it as paid by you at the supplier. Ask the supplier to cancel and refund it, and treat it as a return if it has shipped. If it was not paid after all, do NOT pay it now: cancel it at the supplier.'
    });
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

describe('the console actions', () => {
  it('"paid" marks the row and records it in the timeline; "unpaid" undoes it', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    await seed(store, 'O1', 'awaiting-payment');
    const r = await post('/api/order-action', { id: 'O1', action: 'paid' });
    expect(r).toMatchObject({ status: 200, json: { ok: true, status: 'awaiting-payment' } });
    expect((await store.getOrder('O1'))!.owner_paid_at).not.toBeNull();
    const listed = await post('/api/orders', {});
    const row = (listed.json.orders as Array<Record<string, unknown>>).find((o) => o.id === 'O1')!;
    expect(row.ownerPaidAt).toBe((await store.getOrder('O1'))!.owner_paid_at);
    const u = await post('/api/order-action', { id: 'O1', action: 'unpaid' });
    expect(u).toMatchObject({ status: 200, json: { ok: true, status: 'awaiting-payment' } });
    expect((await store.getOrder('O1'))!.owner_paid_at).toBeNull();
    const kinds = (await store.listOrderEvents('O1')).map((e) => [e.kind, e.detail]);
    expect(kinds).toEqual([['owner-paid', 'CJ-O1'], ['owner-paid-undone', 'CJ-O1']]);
  });

  it('refuses to mark a row that is not waiting for payment, and changes nothing', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    await seed(store, 'H1', 'held');
    const r = await post('/api/order-action', { id: 'H1', action: 'paid' });
    expect(r.status).toBe(409);
    expect(r.json.ok).toBe(false);
    expect((await store.getOrder('H1'))!.owner_paid_at).toBeNull();
    expect(await store.listOrderEvents('H1')).toEqual([]);
    expect((await post('/api/order-action', { id: 'H1', action: 'unpaid' })).status).toBe(409);
    expect((await post('/api/order-action', { id: 'NOPE', action: 'paid' })).status).toBe(404);
  });
});
