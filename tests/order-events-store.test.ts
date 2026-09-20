import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  it('addOrderEvent does not throw when the database throws, and answers false', async () => {
    const fakeDb = { prepare: () => { throw new Error('db unavailable'); } };
    const store = new TenantStore(fakeDb as unknown as D1Database, SHOP);
    await expect(store.addOrderEvent('O1', 'error')).resolves.toBe(false);
  });

  // A rejection is not always an Error. Every trail write in the order loop
  // leans on "answers false, never throws", so the catch itself must survive
  // being handed nothing at all.
  it('addOrderEvent answers false when the database rejects with null or undefined', async () => {
    for (const nothing of [null, undefined]) {
      const fakeDb = { prepare: () => ({ bind: () => ({ run: () => Promise.reject(nothing) }) }) };
      const store = new TenantStore(fakeDb as unknown as D1Database, SHOP);
      await expect(store.addOrderEvent('O1', 'error')).resolves.toBe(false);
    }
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

  // Both deletes go out together, the way redactShop already does it: the
  // route that calls this swallows a failure and answers 200, so a refusal
  // between two separate statements would leave trail rows behind for erased
  // orders and nothing would ever come back for them.
  it('redactOrders erases the orders and their trail in ONE batch', async () => {
    const batches: number[] = [];
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') {
          return (stmts: D1PreparedStatement[]) => { batches.push(stmts.length); return target.batch(stmts); };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      }
    }) as D1Database;
    const store = new TenantStore(db, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: 'O1', orderName: '#O1', totalPrice: 1, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'queued', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.addOrderEvent('O1', 'received');

    const removed = await store.redactOrders(['O1']);

    expect(removed).toBe(1);
    expect(batches).toEqual([2]); // one batch, holding both deletes
    expect(await store.listOrderEvents('O1')).toEqual([]);
    expect(await store.getOrder('O1')).toBeNull();
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

  const EPOCH = new Date(0).toISOString();

  it('listOrderIdsWithPendingAlerts excludes a subject once delivered, and includes it again if it fails after that delivery', async () => {
    const store = new TenantStore(env.DB, SHOP);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await store.addOrderEvent('O1', 'owner-alert-failed', 'S');
      expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O1']);

      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      await store.addOrderEvent('O1', 'owner-alerted', 'S');
      expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual([]);

      vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
      await store.addOrderEvent('O1', 'owner-alert-failed', 'S');
      expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an order with two subjects, one delivered and one still pending, is returned once', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // the delivery of A comes AFTER B's failure, so a delivery-match that
    // ignored the subject (matched by order id alone) would wrongly count
    // as delivering B too.
    await store.addOrderEvent('O1', 'owner-alert-failed', 'A');
    await store.addOrderEvent('O1', 'owner-alert-failed', 'B');
    await store.addOrderEvent('O1', 'owner-alerted', 'A');
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O1']);
  });

  it('maxAttempts failures since the last delivery excludes a subject, but the same total spread across a delivery still counts as pending', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // three consecutive failures, no delivery: excluded once the count reaches maxAttempts (3)
    await store.addOrderEvent('O1', 'owner-alert-failed', 'A');
    await store.addOrderEvent('O1', 'owner-alert-failed', 'A');
    await store.addOrderEvent('O1', 'owner-alert-failed', 'A');
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 3)).toEqual([]);

    // 2 failures, delivered, 2 more failures: only 2 failures SINCE the delivery, still under maxAttempts (3)
    await store.addOrderEvent('O2', 'owner-alert-failed', 'B');
    await store.addOrderEvent('O2', 'owner-alert-failed', 'B');
    await store.addOrderEvent('O2', 'owner-alerted', 'B');
    await store.addOrderEvent('O2', 'owner-alert-failed', 'B');
    await store.addOrderEvent('O2', 'owner-alert-failed', 'B');
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 3)).toEqual(['O2']);
  });

  it('a subject whose first undelivered failure is older than sinceIso is excluded, even with a later failure inside the window', async () => {
    const store = new TenantStore(env.DB, SHOP);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await store.addOrderEvent('O1', 'owner-alert-failed', 'S');
      vi.setSystemTime(new Date('2026-01-01T23:00:00.000Z'));
      await store.addOrderEvent('O1', 'owner-alert-failed', 'S');
    } finally {
      vi.useRealTimers();
    }
    const sinceIso = new Date('2026-01-01T01:00:00.000Z').toISOString();
    expect(await store.listOrderIdsWithPendingAlerts(sinceIso, 12)).toEqual([]);
  });

  it('the squat case: orders whose alerts have all been delivered never occupy a slot, even with a tight limit', async () => {
    const store = new TenantStore(env.DB, SHOP);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      for (const id of ['R1', 'R2', 'R3']) await store.addOrderEvent(id, 'owner-alert-failed', 'S');
      vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
      for (const id of ['R1', 'R2', 'R3']) await store.addOrderEvent(id, 'owner-alerted', 'S');
      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      await store.addOrderEvent('LIVE', 'owner-alert-failed', 'S');
    } finally {
      vi.useRealTimers();
    }
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12, 2)).toEqual(['LIVE']);
  });

  it('orders pending alerts oldest first (not by order id), and ignores a failure row with a null detail', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.addOrderEvent('O1', 'owner-alert-failed', null); // no subject recorded - must never become a candidate
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // O3 fails FIRST and O2 fails SECOND, so alphabetical and chronological
      // order disagree: the assertion below can only pass if the ordering is
      // genuinely by time, not by id.
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await store.addOrderEvent('O3', 'owner-alert-failed', 'S');
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      await store.addOrderEvent('O2', 'owner-alert-failed', 'S');
    } finally {
      vi.useRealTimers();
    }
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O3', 'O2']);
  });

  it('never returns another shop\'s orders (different order ids per shop)', async () => {
    const storeA = new TenantStore(env.DB, SHOP);
    const storeB = new TenantStore(env.DB, SHOP2);
    await storeA.addOrderEvent('O1', 'owner-alert-failed', 'S');
    await storeB.addOrderEvent('B1', 'owner-alert-failed', 'S');
    expect(await storeA.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O1']);
    expect(await storeB.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['B1']);
  });

  it('another shop\'s delivery never clears this shop\'s pending alert, even under the same order id', async () => {
    // The trail's key is (shop, order id, seq), so two shops may hold the same
    // order id. Shop B's later delivery of the same subject must not make shop
    // A's failed alert look delivered: that would silently drop a "do not pay"
    // alert because of another tenant's data.
    const storeA = new TenantStore(env.DB, SHOP);
    const storeB = new TenantStore(env.DB, SHOP2);
    await storeA.addOrderEvent('O1', 'owner-alert-failed', 'S');
    await storeB.addOrderEvent('O1', 'received');
    await storeB.addOrderEvent('O1', 'owner-alerted', 'S');
    expect(await storeA.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O1']);
    expect(await storeB.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual([]);
  });

  // An alert's trail marker is now written BEFORE it is attempted
  // (owner-alert-due), so the candidate query must also find an order whose
  // ONLY pending row is a due one - not just a failed one - while still
  // counting failed sends only against maxAttempts.
  it('an order whose only pending row is a due one is returned', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.addOrderEvent('O1', 'owner-alert-due', 'S');
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O1']);
  });

  it('a due-only order is not returned once owner-alerted follows', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.addOrderEvent('O1', 'owner-alert-due', 'S');
    await store.addOrderEvent('O1', 'owner-alerted', 'S');
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual([]);
  });

  it('maxAttempts counts failures only: a due plus maxAttempts - 1 failures IS returned, a due plus maxAttempts failures is not', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.addOrderEvent('O1', 'owner-alert-due', 'S');
    for (let i = 0; i < 2; i++) await store.addOrderEvent('O1', 'owner-alert-failed', 'S'); // maxAttempts - 1
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 3)).toEqual(['O1']);

    await store.addOrderEvent('O1', 'owner-alert-failed', 'S'); // now maxAttempts (3) failures
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 3)).toEqual([]);
  });

  it('tenant isolation holds for a due row: different order ids per shop, and the same order id in two shops where the other shop\'s delivery must not clear this shop\'s due', async () => {
    const storeA = new TenantStore(env.DB, SHOP);
    const storeB = new TenantStore(env.DB, SHOP2);
    await storeA.addOrderEvent('O1', 'owner-alert-due', 'S');
    await storeB.addOrderEvent('B1', 'owner-alert-due', 'S');
    expect(await storeA.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O1']);
    expect(await storeB.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['B1']);

    // Same order id under both shops - shop B delivering its own copy must
    // not clear shop A's still-due alert.
    await storeA.addOrderEvent('O2', 'owner-alert-due', 'T');
    await storeB.addOrderEvent('O2', 'owner-alert-due', 'T');
    await storeB.addOrderEvent('O2', 'owner-alerted', 'T');
    expect(await storeA.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O1', 'O2']);
    expect(await storeB.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['B1']);
  });

  // Nobody was ever able to tell this alert (no address or key configured),
  // recorded as its own trail kind rather than matched on error text - the
  // query's anti-join needs to know about it too, the same way it already
  // knows about owner-alerted, or an unconfigured shop's dead candidates
  // would sit in the query's result for the full 24 hour window.
  it('a due-then-unconfigured order is not returned, and is returned again once a later due follows it', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.addOrderEvent('O1', 'owner-alert-due', 'S');
    await store.addOrderEvent('O1', 'owner-alert-unconfigured', 'S');
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual([]);

    // Alerting was configured since - a fresh due row for the same subject
    // makes it a candidate again, exactly as the in-code walk treats it.
    await store.addOrderEvent('O1', 'owner-alert-due', 'S');
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual(['O1']);
  });

  it('the squat case for unconfigured: three older unconfigured orders are excluded, leaving only the live pending one, even under a tight limit', async () => {
    const store = new TenantStore(env.DB, SHOP);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      for (const id of ['R1', 'R2', 'R3']) await store.addOrderEvent(id, 'owner-alert-due', 'S');
      vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
      for (const id of ['R1', 'R2', 'R3']) await store.addOrderEvent(id, 'owner-alert-unconfigured', 'S');
      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      await store.addOrderEvent('LIVE', 'owner-alert-failed', 'S');
    } finally {
      vi.useRealTimers();
    }
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12, 2)).toEqual(['LIVE']);
  });

  // The old text-matching approach (an 'error' line reading "owner alert not
  // configured: <subject>") truncated the due row's detail and the error
  // line's detail at different points past 272 characters, so a long enough
  // subject was never cleared. Both rows now store the SAME raw subject
  // through the SAME 300 character truncation, so a 290 character subject
  // truncates identically on both sides and the exclusion holds.
  it('a 290 character subject is excluded by the query once ruled unconfigured', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const subject = 'Order #O1 ' + 'x'.repeat(280);
    expect(subject.length).toBe(290);
    await store.addOrderEvent('O1', 'owner-alert-due', subject);
    await store.addOrderEvent('O1', 'owner-alert-unconfigured', subject);
    expect(await store.listOrderIdsWithPendingAlerts(EPOCH, 12)).toEqual([]);
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
