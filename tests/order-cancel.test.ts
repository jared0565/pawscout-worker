import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore, type OrderRow } from '../src/tenant-store';
import { cancelledOrderId, refundInfo, applyCancel, applyRefund, type OwnerAlert } from '../src/order-cancel';
import { recheckUnsettledSupplierOrders } from '../src/fulfil-run';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';

async function seedOrder(
  store: TenantStore,
  id: string,
  status: OrderRow['status'],
  extra: { cjOrderId?: string; trackingNumber?: string; orderName?: string | null; addressJson?: string | null } = {}
) {
  await store.insertOrderIfNew({
    shopifyOrderId: id,
    orderName: extra.orderName === undefined ? '#' + id : extra.orderName,
    totalPrice: 20,
    currency: 'GBP',
    financialStatus: 'paid',
    riskLevel: null,
    status,
    holdReasons: [],
    addressJson: extra.addressJson === undefined ? null : extra.addressJson,
    lineItemsJson: null,
    fulfilAfter: null
  });
  if (extra.cjOrderId) await store.updateOrder(id, { cj_order_id: extra.cjOrderId });
  if (extra.trackingNumber) await store.updateOrder(id, { tracking_number: extra.trackingNumber });
}

describe('cancelledOrderId', () => {
  it('reads a numeric id as a string', () => {
    expect(cancelledOrderId({ id: 918273 })).toBe('918273');
  });

  it('reads a string id as-is', () => {
    expect(cancelledOrderId({ id: '918273' })).toBe('918273');
  });

  it('returns empty string when the id is absent or the payload is not an object', () => {
    expect(cancelledOrderId({})).toBe('');
    expect(cancelledOrderId(null)).toBe('');
    expect(cancelledOrderId(undefined)).toBe('');
    expect(cancelledOrderId('not an object')).toBe('');
  });
});

describe('refundInfo', () => {
  it('sums two refund transactions given as strings and ignores a kind: sale one', () => {
    const raw = {
      order_id: 555666,
      transactions: [
        { kind: 'refund', amount: '10.00', currency: 'GBP' },
        { kind: 'sale', amount: '50.00', currency: 'GBP' },
        { kind: 'refund', amount: '2.50', currency: 'GBP' }
      ]
    };
    expect(refundInfo(raw)).toEqual({ orderId: '555666', refundId: '', amount: 12.5, currency: 'GBP' });
  });

  it('reads a numeric order_id as a string and defaults currency to empty when there is no refund transaction', () => {
    expect(refundInfo({ order_id: 42, transactions: [{ kind: 'sale', amount: '5.00', currency: 'GBP' }] })).toEqual({
      orderId: '42',
      refundId: '',
      amount: 0,
      currency: ''
    });
  });

  it('takes the currency from the first refund transaction', () => {
    const raw = {
      order_id: 1,
      transactions: [
        { kind: 'refund', amount: 3, currency: 'USD' },
        { kind: 'refund', amount: 1, currency: 'EUR' }
      ]
    };
    expect(refundInfo(raw)).toEqual({ orderId: '1', refundId: '', amount: 4, currency: 'USD' });
  });

  it('reads a numeric refund id as a string and gives empty string when it is absent', () => {
    expect(refundInfo({ id: 998877, order_id: 1, transactions: [] }).refundId).toBe('998877');
    expect(refundInfo({ order_id: 1, transactions: [] }).refundId).toBe('');
  });
});

describe('applyCancel', () => {
  it('does nothing when there is no row for the order', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const outcome = await applyCancel(store, 'GHOST');
    expect(outcome).toEqual({ changed: false, alert: null });
    expect(await store.listOrderEvents('GHOST')).toEqual([]);
  });

  it('held, queued, received and error all become cancelled with a cancel-received event and no alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const status of ['held', 'queued', 'received', 'error'] as const) {
      const id = 'O-' + status;
      await seedOrder(store, id, status);
      const outcome = await applyCancel(store, id);
      expect(outcome).toEqual({ changed: true, alert: null });
      const order = await store.getOrder(id);
      expect(order?.status).toBe('cancelled');
      expect(order?.hold_reasons).toBe(JSON.stringify(['shopify-cancelled']));
      const events = await store.listOrderEvents(id);
      expect(events.map((e) => e.kind)).toEqual(['cancel-received']);
    }
  });

  it('held, queued, received and error WITH a supplier order get the generic cancelled-with-a-supplier-order alert on the first delivery and none on the second (once delivery is confirmed); the same statuses WITHOUT one still get no alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const status of ['held', 'queued', 'received', 'error'] as const) {
      const withId = 'W-' + status;
      await seedOrder(store, withId, status, { cjOrderId: 'CJ-' + status });
      const first = await applyCancel(store, withId);
      expect(first.changed).toBe(true);
      expect(first.alert).toEqual({
        subject: `Order #${withId} was cancelled and a supplier order exists for it`,
        text: `Order #${withId} was cancelled in Shopify. Supplier order CJ-${status} exists for it. Do NOT pay it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.`
      });
      expect((await store.getOrder(withId))?.status).toBe('cancelled');

      // Confirm delivery (what the real caller does via deliverOrderAlert)
      // before checking that a repeat delivery goes quiet.
      await store.addOrderEvent(withId, 'owner-alerted', first.alert!.subject);
      const second = await applyCancel(store, withId);
      expect(second).toEqual({ changed: false, alert: null });

      const withoutId = 'X-' + status;
      await seedOrder(store, withoutId, status);
      const noAlert = await applyCancel(store, withoutId);
      expect(noAlert.alert).toBeNull();
    }
  });

  it('the race: a supplier order created between our two reads still raises the generic alert, and the row ends cancelled', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'queued'); // no supplier order yet, per our own first read
    // A wrapper that delegates to the real store, but makes the cancel's own
    // status write race against a simulated pipeline: the pipeline creates the
    // supplier order and marks the row awaiting-payment just before our write
    // lands, so our own write (unconditional) still lands on top of it.
    const racing = {
      getOrder: (id: string) => store.getOrder(id),
      listOrderEvents: (id: string) => store.listOrderEvents(id),
      addOrderEvent: (id: string, kind: string, detail?: string | null) => store.addOrderEvent(id, kind as never, detail),
      updateOrder: async (id: string, fields: Record<string, unknown>) => {
        if (fields.status === 'cancelled') {
          await store.updateOrder(id, { cj_order_id: 'CJ-RACE', status: 'awaiting-payment' });
        }
        return store.updateOrder(id, fields as never);
      }
    } as unknown as TenantStore;

    const outcome = await applyCancel(racing, 'O1');
    expect(outcome.changed).toBe(true);
    expect(outcome.alert).toEqual({
      subject: 'Order #O1 was cancelled and a supplier order exists for it',
      text: 'Order #O1 was cancelled in Shopify. Supplier order CJ-RACE exists for it. Do NOT pay it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.'
    });
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
  });

  it('the awaiting-payment alert takes the supplier order id from the SECOND read, not the first', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-OLD' });
    const racing = {
      getOrder: (id: string) => store.getOrder(id),
      listOrderEvents: (id: string) => store.listOrderEvents(id),
      addOrderEvent: (id: string, kind: string, detail?: string | null) => store.addOrderEvent(id, kind as never, detail),
      updateOrder: async (id: string, fields: Record<string, unknown>) => {
        // Simulate the supplier order id being replaced between our first
        // read and our own write.
        await store.updateOrder(id, { cj_order_id: 'CJ-NEW' });
        return store.updateOrder(id, fields as never);
      }
    } as unknown as TenantStore;

    const outcome = await applyCancel(racing, 'O1');
    expect(outcome.alert?.text).toContain('CJ-NEW');
    expect(outcome.alert?.text).not.toContain('CJ-OLD');
  });

  it('awaiting-payment becomes cancelled, alerts do NOT pay the supplier, and writes cancel-received (the alert itself is delivered and confirmed separately)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const outcome = await applyCancel(store, 'O1');
    expect(outcome.changed).toBe(true);
    expect(outcome.alert).toEqual({
      subject: 'Order #O1 was cancelled: do NOT pay the supplier',
      text: 'Order #O1 was cancelled in Shopify. Supplier order CJ-1 was created for it and PawScout has not paid it. Do NOT pay it. If it is still unpaid, cancel it at the supplier. If you have already paid it by hand, PawScout cannot see that: ask the supplier to cancel and refund it, and treat it as a return if it has shipped.'
    });
    const order = await store.getOrder('O1');
    expect(order?.status).toBe('cancelled');
    expect(order?.hold_reasons).toBe(JSON.stringify(['shopify-cancelled']));
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['cancel-received']);
  });

  it('submitted becomes cancelled and alerts that it was cancelled after it was paid at the supplier', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-2' });
    const outcome = await applyCancel(store, 'O1');
    expect(outcome.changed).toBe(true);
    expect(outcome.alert).toEqual({
      subject: 'Order #O1 was cancelled after it was paid at the supplier',
      text: 'Order #O1 was cancelled in Shopify after supplier order CJ-2 was paid. Ask the supplier to cancel it if it has not shipped. If it has shipped, this is a return.'
    });
    const order = await store.getOrder('O1');
    expect(order?.status).toBe('cancelled');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['cancel-received']);
  });

  it('fulfilled stays fulfilled but alerts that it was cancelled after it shipped, and treats the row as changed', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'fulfilled', { cjOrderId: 'CJ-3', trackingNumber: 'TRK-9' });
    const outcome = await applyCancel(store, 'O1');
    expect(outcome.changed).toBe(true);
    expect(outcome.alert).toEqual({
      subject: 'Order #O1 was cancelled after it shipped',
      text: 'Order #O1 was cancelled in Shopify after it shipped (tracking TRK-9). Treat it as a return.'
    });
    const order = await store.getOrder('O1');
    expect(order?.status).toBe('fulfilled');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['cancel-received']);
  });

  it('a cancelled row with no trail yet takes the normal path once (writes cancel-received, no alert), then dedupes on the next delivery', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'cancelled');
    const first = await applyCancel(store, 'O1');
    expect(first).toEqual({ changed: true, alert: null });
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    expect((await store.listOrderEvents('O1')).map((e) => e.kind)).toEqual(['cancel-received']);

    const second = await applyCancel(store, 'O1');
    expect(second).toEqual({ changed: false, alert: null });
    expect((await store.listOrderEvents('O1')).map((e) => e.kind)).toEqual(['cancel-received']);
  });

  it('a row that is already cancelled keeps its own hold_reasons on the first cancel delivery (the reason it was cancelled here is not overwritten)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'C1', 'cancelled');
    await store.updateOrder('C1', { hold_reasons: JSON.stringify(['operator-cancelled']) });
    const outcome = await applyCancel(store, 'C1');
    expect(outcome.alert).toBeNull();
    const order = await store.getOrder('C1');
    expect(order?.status).toBe('cancelled');
    expect(order?.hold_reasons).toBe(JSON.stringify(['operator-cancelled']));
    expect((await store.listOrderEvents('C1')).map((e) => e.kind)).toEqual(['cancel-received']);
  });

  it('a row that is already cancelled and carries a supplier order still raises nothing on the first delivery', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'C3', 'cancelled', { cjOrderId: 'CJ-C3' });
    const outcome = await applyCancel(store, 'C3');
    expect(outcome).toEqual({ changed: true, alert: null });
  });

  it('a second applyCancel on the same order (now cancelled) returns changed: false, writes no event and returns no alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'held');
    const first = await applyCancel(store, 'O1');
    expect(first.changed).toBe(true);
    const eventsAfterFirst = await store.listOrderEvents('O1');

    const second = await applyCancel(store, 'O1');
    expect(second).toEqual({ changed: false, alert: null });
    expect(await store.listOrderEvents('O1')).toEqual(eventsAfterFirst);
  });

  it('three deliveries of the same cancel for a fulfilled row give exactly one alert and one cancel-received event, once each delivered alert is confirmed', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'F1', 'fulfilled', { cjOrderId: 'CJ-F1', trackingNumber: 'TRK-F1' });
    const alerts: (OwnerAlert | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const outcome = await applyCancel(store, 'F1');
      alerts.push(outcome.alert);
      if (outcome.alert) await store.addOrderEvent('F1', 'owner-alerted', outcome.alert.subject);
    }
    expect(alerts.filter((a) => a !== null)).toHaveLength(1);
    expect((await store.listOrderEvents('F1')).map((e) => e.kind)).toEqual(['cancel-received', 'owner-alerted']);
    expect((await store.getOrder('F1'))?.status).toBe('fulfilled');
  });

  it('three deliveries of the same cancel for an awaiting-payment row give exactly one alert and one cancel-received event, once each delivered alert is confirmed', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'F2', 'awaiting-payment', { cjOrderId: 'CJ-F2' });
    const alerts: (OwnerAlert | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const outcome = await applyCancel(store, 'F2');
      alerts.push(outcome.alert);
      if (outcome.alert) await store.addOrderEvent('F2', 'owner-alerted', outcome.alert.subject);
    }
    expect(alerts.filter((a) => a !== null)).toHaveLength(1);
    expect((await store.listOrderEvents('F2')).map((e) => e.kind)).toEqual(['cancel-received', 'owner-alerted']);
    expect((await store.getOrder('F2'))?.status).toBe('cancelled');
  });

  it('three deliveries of the same cancel for a submitted row give exactly one alert and one cancel-received event, once each delivered alert is confirmed', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'F3', 'submitted', { cjOrderId: 'CJ-F3' });
    const alerts: (OwnerAlert | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const outcome = await applyCancel(store, 'F3');
      alerts.push(outcome.alert);
      if (outcome.alert) await store.addOrderEvent('F3', 'owner-alerted', outcome.alert.subject);
    }
    expect(alerts.filter((a) => a !== null)).toHaveLength(1);
    expect((await store.listOrderEvents('F3')).map((e) => e.kind)).toEqual(['cancel-received', 'owner-alerted']);
    expect((await store.getOrder('F3'))?.status).toBe('cancelled');
  });

  it('never prints the literal word null when cj_order_id or tracking_number is not recorded; prints (not recorded) instead', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'N1', 'awaiting-payment'); // no cjOrderId
    const noCj = await applyCancel(store, 'N1');
    expect(noCj.alert?.text).toContain('(not recorded)');
    expect(noCj.alert?.text).not.toMatch(/\bnull\b/);

    await seedOrder(store, 'N2', 'fulfilled', { cjOrderId: 'CJ-N2' }); // no trackingNumber
    const noTracking = await applyCancel(store, 'N2');
    expect(noTracking.alert?.text).toContain('(not recorded)');
    expect(noTracking.alert?.text).not.toMatch(/\bnull\b/);
  });

  it('the submitted alert takes the supplier order id from the SECOND read, not the first', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-OLD' });
    const racing = {
      getOrder: (id: string) => store.getOrder(id),
      listOrderEvents: (id: string) => store.listOrderEvents(id),
      addOrderEvent: (id: string, kind: string, detail?: string | null) => store.addOrderEvent(id, kind as never, detail),
      updateOrder: async (id: string, fields: Record<string, unknown>) => {
        await store.updateOrder(id, { cj_order_id: 'CJ-NEW' });
        return store.updateOrder(id, fields as never);
      }
    } as unknown as TenantStore;

    const outcome = await applyCancel(racing, 'O1');
    expect(outcome.alert?.text).toContain('CJ-NEW');
    expect(outcome.alert?.text).not.toContain('CJ-OLD');
  });

  it('the fulfilled alert takes the tracking number from the SECOND read, not the first', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'fulfilled', { cjOrderId: 'CJ-1', trackingNumber: 'TRK-OLD' });
    // A 'fulfilled' row skips the status write entirely, so there is no
    // updateOrder call to race against - the race window here is between the
    // first read and the cancel-received write, so that write is where the
    // simulated pipeline update lands.
    const racing = {
      getOrder: (id: string) => store.getOrder(id),
      listOrderEvents: (id: string) => store.listOrderEvents(id),
      addOrderEvent: async (id: string, kind: string, detail?: string | null) => {
        if (kind === 'cancel-received') await store.updateOrder(id, { tracking_number: 'TRK-NEW' });
        return store.addOrderEvent(id, kind as never, detail);
      },
      updateOrder: (id: string, fields: Record<string, unknown>) => store.updateOrder(id, fields as never)
    } as unknown as TenantStore;

    const outcome = await applyCancel(racing, 'O1');
    expect(outcome.alert?.text).toContain('TRK-NEW');
    expect(outcome.alert?.text).not.toContain('TRK-OLD');
  });
});

describe('applyCancel writes the marker before the status', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a status write that throws leaves the marker recorded and the row unchanged; the repeat delivery finishes the cancel and hands back the alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const updateSpy = vi.spyOn(TenantStore.prototype, 'updateOrder').mockImplementationOnce(() => { throw new Error('write refused'); });
    await expect(applyCancel(store, 'O1')).rejects.toThrow('write refused');
    updateSpy.mockRestore();

    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => ({ kind: e.kind, detail: e.detail }))).toEqual([
      { kind: 'cancel-received', detail: 'was awaiting-payment' }
    ]);
    expect((await store.getOrder('O1'))?.status).toBe('awaiting-payment');

    const second = await applyCancel(store, 'O1');
    expect(second.changed).toBe(true);
    expect(second.alert).toEqual({
      subject: 'Order #O1 was cancelled: do NOT pay the supplier',
      text: 'Order #O1 was cancelled in Shopify. Supplier order CJ-1 was created for it and PawScout has not paid it. Do NOT pay it. If it is still unpaid, cancel it at the supplier. If you have already paid it by hand, PawScout cannot see that: ask the supplier to cancel and refund it, and treat it as a return if it has shipped.'
    });
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    expect((await store.listOrderEvents('O1')).filter((e) => e.kind === 'cancel-received')).toHaveLength(1);
  });

  it('a refused cancel-received write throws, leaves no marker and no status change, and the next delivery is a clean first delivery', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const addSpy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockResolvedValueOnce(false);
    await expect(applyCancel(store, 'O1')).rejects.toThrow('cancel-received could not be recorded');
    addSpy.mockRestore();

    expect(await store.listOrderEvents('O1')).toEqual([]);
    expect((await store.getOrder('O1'))?.status).toBe('awaiting-payment');

    const second = await applyCancel(store, 'O1');
    expect(second.changed).toBe(true);
    expect(second.alert).toEqual({
      subject: 'Order #O1 was cancelled: do NOT pay the supplier',
      text: 'Order #O1 was cancelled in Shopify. Supplier order CJ-1 was created for it and PawScout has not paid it. Do NOT pay it. If it is still unpaid, cancel it at the supplier. If you have already paid it by hand, PawScout cannot see that: ask the supplier to cancel and refund it, and treat it as a return if it has shipped.'
    });
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    expect((await store.listOrderEvents('O1')).filter((e) => e.kind === 'cancel-received')).toHaveLength(1);
  });

  it('the repeat branch never re-cancels a fulfilled row', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'fulfilled', { cjOrderId: 'CJ-1', trackingNumber: 'TRK-1' });
    const first = await applyCancel(store, 'O1');
    expect(first.changed).toBe(true);
    expect((await store.getOrder('O1'))?.status).toBe('fulfilled');

    const second = await applyCancel(store, 'O1');
    expect(second.changed).toBe(false);
    expect((await store.getOrder('O1'))?.status).toBe('fulfilled');
  });

  it('the repeat branch never re-cancels a row whose cancel-received recorded a fulfilled first status, even if the row status was changed since', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'fulfilled', { cjOrderId: 'CJ-1', trackingNumber: 'TRK-1' });
    const first = await applyCancel(store, 'O1');
    expect(first.changed).toBe(true);
    // Something else moves the row off 'fulfilled' afterwards (an operator
    // action, a later step) - the repeat branch must still key off the
    // RECORDED first status, not the row's current one, and never re-cancel.
    await store.updateOrder('O1', { status: 'held' });
    const second = await applyCancel(store, 'O1');
    expect(second.changed).toBe(false);
    expect((await store.getOrder('O1'))?.status).toBe('held');
  });
});

describe('a repeat delivery heals a lost alert (cancel)', () => {
  it('an alert that was never delivered is returned again on the next delivery, without writing a second cancel-received', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const first = await applyCancel(store, 'O1'); // dropped: the caller never delivers it
    expect(first.alert).not.toBeNull();
    const second = await applyCancel(store, 'O1');
    expect(second).toEqual({ changed: false, alert: first.alert });
    expect((await store.listOrderEvents('O1')).filter((e) => e.kind === 'cancel-received')).toHaveLength(1);
  });

  it('once an owner-alerted marker for the subject is in the trail, the next delivery goes quiet', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const first = await applyCancel(store, 'O1');
    await store.addOrderEvent('O1', 'owner-alerted', first.alert!.subject);
    expect(await applyCancel(store, 'O1')).toEqual({ changed: false, alert: null });
  });

  it('once an owner-alert-failed marker for the subject is in the trail, the next delivery goes quiet', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const first = await applyCancel(store, 'O1');
    await store.addOrderEvent('O1', 'owner-alert-failed', first.alert!.subject);
    expect(await applyCancel(store, 'O1')).toEqual({ changed: false, alert: null });
  });

  it('once an owner-alert-unconfigured marker for the subject is in the trail, the next delivery goes quiet', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const first = await applyCancel(store, 'O1');
    await store.addOrderEvent('O1', 'owner-alert-unconfigured', first.alert!.subject);
    expect(await applyCancel(store, 'O1')).toEqual({ changed: false, alert: null });
  });

  it('a cancel for which no alert was due stays a no-op on repeat', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'held'); // no supplier order - no alert due
    const first = await applyCancel(store, 'O1');
    expect(first.alert).toBeNull();
    expect(await applyCancel(store, 'O1')).toEqual({ changed: false, alert: null });
  });

  it('a cancel-received event written with no detail (a pre-existing marker) still re-applies the status write but raises no alert: it cannot name the status the alert would need', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    await store.addOrderEvent('O1', 'cancel-received'); // no detail
    expect(await applyCancel(store, 'O1')).toEqual({ changed: true, alert: null });
    const order = await store.getOrder('O1');
    expect(order?.status).toBe('cancelled');
    expect(order?.hold_reasons).toBe(JSON.stringify(['shopify-cancelled']));
    // A second delivery finds the row already cancelled and does nothing more.
    expect(await applyCancel(store, 'O1')).toEqual({ changed: false, alert: null });
  });

  it('a cancel whose alert was abandoned (12 failures, no delivery) IS handed back on a repeat delivery', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const first = await applyCancel(store, 'O1');
    for (let i = 0; i < 12; i++) await store.addOrderEvent('O1', 'owner-alert-failed', first.alert!.subject);
    const second = await applyCancel(store, 'O1');
    expect(second.alert).toEqual(first.alert);
  });
});

describe('a repeat delivery heals a lost alert (refund)', () => {
  it('an alert that was never delivered is returned again on the next delivery, without writing a second refund-received', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const first = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    expect(first.alert).not.toBeNull();
    const second = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    expect(second).toEqual({ changed: false, alert: first.alert });
    expect((await store.listOrderEvents('O1')).filter((e) => e.kind === 'refund-received')).toHaveLength(1);
  });

  it('once a marker for the subject is in the trail, the next delivery of the same refund id goes quiet', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const first = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    await store.addOrderEvent('O1', 'owner-alerted', first.alert!.subject);
    const second = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    expect(second).toEqual({ changed: false, alert: null });
  });

  it('a refund for which no alert was due (no supplier order) stays a no-op on repeat', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'held'); // no supplier order
    const first = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    expect(first.alert).toBeNull();
    const second = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    expect(second).toEqual({ changed: false, alert: null });
  });

  it('once an owner-alert-failed marker for the subject is in the trail (still within its retry budget), the next delivery of the same refund id goes quiet', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const first = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    await store.addOrderEvent('O1', 'owner-alert-failed', first.alert!.subject);
    const second = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    expect(second).toEqual({ changed: false, alert: null });
  });

  it('once an owner-alert-unconfigured marker for the subject is in the trail, the next delivery of the same refund id goes quiet', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const first = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    await store.addOrderEvent('O1', 'owner-alert-unconfigured', first.alert!.subject);
    const second = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    expect(second).toEqual({ changed: false, alert: null });
  });

  it('a refund whose alert was abandoned (12 failures, no delivery) IS handed back on a repeat delivery of the same refund id', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const first = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    for (let i = 0; i < 12; i++) await store.addOrderEvent('O1', 'owner-alert-failed', first.alert!.subject);
    const second = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
    expect(second.alert).toEqual(first.alert);
  });

  // Before the refund id was folded into the subject, two refunds of the same
  // amount and currency produced the IDENTICAL subject text, so delivering
  // the earlier one's alert cleared the later one's pending state too - a
  // subject is an alert's retry identity, and identical subjects collide.
  // Now each refund's subject carries its own refund id, so they are
  // distinct identities from the start; the slice the repeat branch takes
  // (events after THIS refund's own refund-received) still guards the case
  // where a refund carries no id at all and falls back to the shared subject.
  it('two refunds of the same amount and currency now get different subjects (their own refund id), so delivering one never masks the other', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });

    const first = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 10, currency: 'GBP' });
    expect(first.alert).not.toBeNull();
    await store.addOrderEvent('O1', 'owner-alerted', first.alert!.subject); // R-1's alert confirmed delivered

    const second = await applyRefund(store, { orderId: 'O1', refundId: 'R-2', amount: 10, currency: 'GBP' });
    expect(second.alert).not.toBeNull();
    expect(second.alert!.subject).not.toBe(first.alert!.subject); // distinct subjects: each carries its own refund id
    // R-2's own alert is never confirmed delivered - simulate its webhook being redelivered.
    const secondRepeat = await applyRefund(store, { orderId: 'O1', refundId: 'R-2', amount: 10, currency: 'GBP' });
    expect(secondRepeat.alert).toEqual(second.alert);
  });
});

describe('applyRefund', () => {
  it('does nothing when there is no row for the order', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const outcome = await applyRefund(store, { orderId: 'GHOST', refundId: 'R-1', amount: 5, currency: 'GBP' });
    expect(outcome).toEqual({ changed: false, alert: null });
    expect(await store.listOrderEvents('GHOST')).toEqual([]);
  });

  it('a cancelled row writes a refund-received event but no status change and no alert, whether or not a supplier order exists', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'C1', 'cancelled');
    const outcome1 = await applyRefund(store, { orderId: 'C1', refundId: 'R-C1', amount: 5, currency: 'GBP' });
    expect(outcome1).toEqual({ changed: false, alert: null });
    expect((await store.getOrder('C1'))?.status).toBe('cancelled');
    expect((await store.listOrderEvents('C1')).map((e) => e.kind)).toEqual(['refund-received']);

    await seedOrder(store, 'C2', 'cancelled', { cjOrderId: 'CJ-C2' });
    const outcome2 = await applyRefund(store, { orderId: 'C2', refundId: 'R-C2', amount: 5, currency: 'GBP' });
    expect(outcome2).toEqual({ changed: false, alert: null });
    expect((await store.getOrder('C2'))?.status).toBe('cancelled');
    expect((await store.listOrderEvents('C2')).map((e) => e.kind)).toEqual(['refund-received']);
  });

  it('held, queued and received with no supplier order yet go to held with hold_reasons refunded, no alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const status of ['held', 'queued', 'received'] as const) {
      const id = 'O-' + status;
      await seedOrder(store, id, status);
      const outcome = await applyRefund(store, { orderId: id, refundId: 'R-' + id, amount: 9.99, currency: 'GBP' });
      expect(outcome).toEqual({ changed: true, alert: null });
      const order = await store.getOrder(id);
      expect(order?.status).toBe('held');
      expect(order?.hold_reasons).toBe(JSON.stringify(['refunded']));
      const events = await store.listOrderEvents(id);
      expect(events.map((e) => e.kind)).toEqual(['refund-received']);
    }
  });

  it('no supplier order and a status outside held/queued/received (e.g. error) still records refund-received with no status change and no alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'E1', 'error');
    const outcome = await applyRefund(store, { orderId: 'E1', refundId: 'R-E1', amount: 5, currency: 'GBP' });
    expect(outcome).toEqual({ changed: false, alert: null });
    expect((await store.getOrder('E1'))?.status).toBe('error');
    expect((await store.listOrderEvents('E1')).map((e) => e.kind)).toEqual(['refund-received']);
  });

  it('a row with a supplier order is left unchanged but alerts, regardless of status', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const status of ['submitted', 'fulfilled', 'awaiting-payment'] as const) {
      const id = 'O-' + status;
      await seedOrder(store, id, status, { cjOrderId: 'CJ-' + status });
      const outcome = await applyRefund(store, { orderId: id, refundId: 'R-' + id, amount: 12.5, currency: 'GBP' });
      expect(outcome.changed).toBe(true);
      expect(outcome.alert).toEqual({
        subject: `Order #${id} was refunded GBP 12.50 (refund R-${id})`,
        text: `Order #${id} was refunded GBP 12.50 in Shopify. Supplier order CJ-${status} exists for it (status here: ${status}). Decide whether the supplier order should still go ahead.`
      });
      const order = await store.getOrder(id);
      expect(order?.status).toBe(status);
      const events = await store.listOrderEvents(id);
      expect(events.map((e) => e.kind)).toEqual(['refund-received']);
    }
  });

  it('the refund subject includes the refund id when Shopify sent one, and omits it when Shopify sent none (the text is unchanged either way)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const withId = await applyRefund(store, { orderId: 'O1', refundId: 'R-99', amount: 5, currency: 'GBP' });
    expect(withId.alert).toEqual({
      subject: 'Order #O1 was refunded GBP 5.00 (refund R-99)',
      text: 'Order #O1 was refunded GBP 5.00 in Shopify. Supplier order CJ-1 exists for it (status here: submitted). Decide whether the supplier order should still go ahead.'
    });

    await seedOrder(store, 'O2', 'submitted', { cjOrderId: 'CJ-2' });
    const noId = await applyRefund(store, { orderId: 'O2', refundId: '', amount: 5, currency: 'GBP' });
    expect(noId.alert).toEqual({
      subject: 'Order #O2 was refunded GBP 5.00',
      text: 'Order #O2 was refunded GBP 5.00 in Shopify. Supplier order CJ-2 exists for it (status here: submitted). Decide whether the supplier order should still go ahead.'
    });
  });

  it('five identical deliveries of one refund on a row with a supplier order give exactly one alert and one refund-received event, once the alert is confirmed delivered', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const alerts: (OwnerAlert | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const outcome = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' });
      alerts.push(outcome.alert);
      if (outcome.alert) await store.addOrderEvent('O1', 'owner-alerted', outcome.alert.subject);
    }
    expect(alerts.filter((a) => a !== null)).toHaveLength(1);
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['refund-received', 'owner-alerted']);
  });

  it('two different refunds (different ids) of the same amount and currency both alert (dedup keys on refund id, not amount)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const first = await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 10, currency: 'GBP' });
    const second = await applyRefund(store, { orderId: 'O1', refundId: 'R-2', amount: 10, currency: 'GBP' });
    expect(first.alert).not.toBeNull();
    expect(second.alert).not.toBeNull();
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['refund-received', 'refund-received']);
  });

  it('when refundId is empty, dedup falls back to an exact match on currency and amount', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const first = await applyRefund(store, { orderId: 'O1', refundId: '', amount: 7.25, currency: 'GBP' });
    expect(first.alert).not.toBeNull();
    await store.addOrderEvent('O1', 'owner-alerted', first.alert!.subject); // confirm delivery

    const second = await applyRefund(store, { orderId: 'O1', refundId: '', amount: 7.25, currency: 'GBP' });
    expect(second.alert).toBeNull();

    const third = await applyRefund(store, { orderId: 'O1', refundId: '', amount: 3.0, currency: 'GBP' });
    expect(third.alert).not.toBeNull();

    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['refund-received', 'owner-alerted', 'refund-received']);
  });

  it('refund-received detail is exactly "refund <id>: <currency> <amount>", using unknown when the id is empty', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'held');
    await applyRefund(store, { orderId: 'O1', refundId: 'R-77', amount: 3, currency: 'GBP' });
    const events1 = await store.listOrderEvents('O1');
    expect(events1[0].detail).toBe('refund R-77: GBP 3.00');

    await seedOrder(store, 'O2', 'held');
    await applyRefund(store, { orderId: 'O2', refundId: '', amount: 3, currency: 'GBP' });
    const events2 = await store.listOrderEvents('O2');
    expect(events2[0].detail).toBe('refund unknown: GBP 3.00');
  });

  it('a non-finite or negative refund amount is treated as 0', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const nanOutcome = await applyRefund(store, { orderId: 'O1', refundId: 'R-NaN', amount: NaN, currency: 'GBP' });
    expect(nanOutcome.alert?.text).toContain('GBP 0.00');

    await seedOrder(store, 'O2', 'submitted', { cjOrderId: 'CJ-2' });
    const negOutcome = await applyRefund(store, { orderId: 'O2', refundId: 'R-Neg', amount: -5, currency: 'GBP' });
    expect(negOutcome.alert?.text).toContain('GBP 0.00');
  });
});

// Built at runtime so this test file contains no literal em/en dash glyph.
const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);

/** A minimal AdminGraphql fake that answers the live-order gate query with a
 *  live, paid, unfulfilled order carrying `newAddress` - just enough to drive
 *  recheckUnsettledSupplierOrders (src/fulfil-run.ts) into raising its own
 *  address-changed alert, so this file's two sweeps can cover the
 *  address-changed alert text that lives outside order-cancel.ts. */
function addressChangeAdmin(newAddress: { name: string; address1: string; city: string; zip: string; countryCode: string; phone: string }): AdminGraphql {
  const order = {
    cancelledAt: null, closed: false, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    risk: { recommendation: 'ACCEPT' },
    shippingAddress: { name: newAddress.name, address1: newAddress.address1, address2: '', city: newAddress.city, province: '', zip: newAddress.zip, countryCodeV2: newAddress.countryCode, phone: newAddress.phone }
  };
  return (async () => ({ order })) as unknown as AdminGraphql;
}

/** Seeds one awaiting-payment row with `storedAddress` and runs the pull
 *  check against a gate reporting `newAddress`, capturing the address-changed
 *  alert it raises. */
async function pullCheckAddressChangeAlert(
  store: TenantStore, id: string,
  storedAddress: Record<string, string>, newAddress: { name: string; address1: string; city: string; zip: string; countryCode: string; phone: string }
): Promise<OwnerAlert> {
  await seedOrder(store, id, 'awaiting-payment', { cjOrderId: 'CJ-' + id, addressJson: JSON.stringify(storedAddress) });
  let captured: OwnerAlert | null = null;
  await recheckUnsettledSupplierOrders(store, addressChangeAdmin(newAddress), async (subject, text) => { captured = { subject, text }; return 'sent'; });
  if (!captured) throw new Error('pull check did not raise the address-changed alert in this test setup');
  return captured;
}

const OLD_ADDRESS = { name: 'Old Name', address1: 'Old Street', address2: '', city: 'Oldtown', province: '', zip: 'X1 1XX', countryCode: 'GB', phone: '0000000000' };

describe('owner alert text is safe to send as-is', () => {
  it('contains no em or en dash across every alerting path', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const alerts: OwnerAlert[] = [];

    await seedOrder(store, 'A1', 'awaiting-payment', { cjOrderId: 'CJ-A1' });
    alerts.push((await applyCancel(store, 'A1')).alert as OwnerAlert);

    await seedOrder(store, 'A2', 'submitted', { cjOrderId: 'CJ-A2' });
    alerts.push((await applyCancel(store, 'A2')).alert as OwnerAlert);

    await seedOrder(store, 'A3', 'fulfilled', { cjOrderId: 'CJ-A3', trackingNumber: 'TRK-A3' });
    alerts.push((await applyCancel(store, 'A3')).alert as OwnerAlert);

    await seedOrder(store, 'A4', 'submitted', { cjOrderId: 'CJ-A4' });
    alerts.push((await applyRefund(store, { orderId: 'A4', refundId: 'R-A4', amount: 4.4, currency: 'GBP' })).alert as OwnerAlert);

    // A5: the generic cancel alert (any status other than awaiting-payment,
    // submitted, fulfilled or cancelled, with a supplier order on the row).
    await seedOrder(store, 'A5', 'held', { cjOrderId: 'CJ-A5' });
    alerts.push((await applyCancel(store, 'A5')).alert as OwnerAlert);

    // A6: the pull check's own address-changed alert (src/fulfil-run.ts).
    alerts.push(await pullCheckAddressChangeAlert(store, 'A6', OLD_ADDRESS, { name: 'New Name', address1: 'New Street', city: 'Newtown', zip: 'Y1 1YY', countryCode: 'GB', phone: '1111111111' }));

    expect(alerts.length).toBe(6);
    for (const alert of alerts) {
      expect(alert).not.toBeNull();
      const combined = alert.subject + ' ' + alert.text;
      expect(combined).not.toContain(EM_DASH);
      expect(combined).not.toContain(EN_DASH);
    }
  });

  // Proven able to fail: the implementation was temporarily edited to
  // interpolate the seeded address name into one alert, this test went red
  // on that build, then the edit was reverted.
  it('never leaks the order address (name, street, postcode, phone) into an alert or an event detail, across every alerting path', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const pii = { name: 'Jane Example', address1: '42 Example Street', zip: 'SW1A 1AA', phone: '020 7123 4567' };
    const forbidden = [pii.name, pii.address1, pii.zip, pii.phone];
    const addressJson = JSON.stringify(pii);

    await seedOrder(store, 'P1', 'awaiting-payment', { cjOrderId: 'CJ-P1', addressJson });
    await seedOrder(store, 'P2', 'submitted', { cjOrderId: 'CJ-P2', addressJson });
    await seedOrder(store, 'P3', 'fulfilled', { cjOrderId: 'CJ-P3', trackingNumber: 'TRK-P3', addressJson });
    await seedOrder(store, 'P4', 'submitted', { cjOrderId: 'CJ-P4', addressJson });
    // P5: the generic cancel alert, seeded WITH the same PII address on the row
    // (cancelAlertFor's generic branch never reads the address at all, but the
    // sweep should still prove it for this path rather than assume it).
    await seedOrder(store, 'P5', 'held', { cjOrderId: 'CJ-P5', addressJson });

    const alerts: OwnerAlert[] = [];
    alerts.push((await applyCancel(store, 'P1')).alert as OwnerAlert);
    alerts.push((await applyCancel(store, 'P2')).alert as OwnerAlert);
    alerts.push((await applyCancel(store, 'P3')).alert as OwnerAlert);
    alerts.push((await applyRefund(store, { orderId: 'P4', refundId: 'R-P4', amount: 4.4, currency: 'GBP' })).alert as OwnerAlert);
    alerts.push((await applyCancel(store, 'P5')).alert as OwnerAlert);

    // P6: the pull check's own address-changed alert - the incoming Shopify
    // address (what the alert text could plausibly leak) IS the PII address.
    alerts.push(await pullCheckAddressChangeAlert(store, 'P6', OLD_ADDRESS, { name: pii.name, address1: pii.address1, city: 'Exampleton', zip: pii.zip, countryCode: 'GB', phone: pii.phone }));

    for (const alert of alerts) {
      expect(alert).not.toBeNull();
      const combined = alert.subject + ' ' + alert.text;
      for (const word of forbidden) expect(combined).not.toContain(word);
    }

    for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
      const events = await store.listOrderEvents(id);
      for (const event of events) {
        if (!event.detail) continue;
        for (const word of forbidden) expect(event.detail).not.toContain(word);
      }
    }
  });
});
