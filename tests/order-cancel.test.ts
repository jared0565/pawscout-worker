import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore, type OrderRow } from '../src/tenant-store';
import { cancelledOrderId, refundInfo, applyCancel, applyRefund, type OwnerAlert } from '../src/order-cancel';

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

  it('awaiting-payment becomes cancelled, alerts do NOT pay the supplier, and writes cancel-received then owner-alerted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const outcome = await applyCancel(store, 'O1');
    expect(outcome.changed).toBe(true);
    expect(outcome.alert).toEqual({
      subject: 'Order #O1 was cancelled: do NOT pay the supplier',
      text: 'Order #O1 was cancelled in Shopify. Supplier order CJ-1 was created for it and is still unpaid. Do NOT pay it. Cancel it at the supplier. Nothing has been spent.'
    });
    const order = await store.getOrder('O1');
    expect(order?.status).toBe('cancelled');
    expect(order?.hold_reasons).toBe(JSON.stringify(['shopify-cancelled']));
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['cancel-received', 'owner-alerted']);
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
    expect(events.map((e) => e.kind)).toEqual(['cancel-received', 'owner-alerted']);
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
    expect(events.map((e) => e.kind)).toEqual(['cancel-received', 'owner-alerted']);
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

  it('three deliveries of the same cancel for a fulfilled row give exactly one alert and one cancel-received/owner-alerted pair', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'F1', 'fulfilled', { cjOrderId: 'CJ-F1', trackingNumber: 'TRK-F1' });
    const alerts: (OwnerAlert | null)[] = [];
    for (let i = 0; i < 3; i++) alerts.push((await applyCancel(store, 'F1')).alert);
    expect(alerts.filter((a) => a !== null)).toHaveLength(1);
    expect((await store.listOrderEvents('F1')).map((e) => e.kind)).toEqual(['cancel-received', 'owner-alerted']);
    expect((await store.getOrder('F1'))?.status).toBe('fulfilled');
  });

  it('three deliveries of the same cancel for an awaiting-payment row give exactly one alert and one cancel-received/owner-alerted pair', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'F2', 'awaiting-payment', { cjOrderId: 'CJ-F2' });
    const alerts: (OwnerAlert | null)[] = [];
    for (let i = 0; i < 3; i++) alerts.push((await applyCancel(store, 'F2')).alert);
    expect(alerts.filter((a) => a !== null)).toHaveLength(1);
    expect((await store.listOrderEvents('F2')).map((e) => e.kind)).toEqual(['cancel-received', 'owner-alerted']);
    expect((await store.getOrder('F2'))?.status).toBe('cancelled');
  });

  it('three deliveries of the same cancel for a submitted row give exactly one alert and one cancel-received/owner-alerted pair', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'F3', 'submitted', { cjOrderId: 'CJ-F3' });
    const alerts: (OwnerAlert | null)[] = [];
    for (let i = 0; i < 3; i++) alerts.push((await applyCancel(store, 'F3')).alert);
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
        subject: `Order #${id} was refunded GBP 12.50`,
        text: `Order #${id} was refunded GBP 12.50 in Shopify. Supplier order CJ-${status} exists for it (status here: ${status}). Decide whether the supplier order should still go ahead.`
      });
      const order = await store.getOrder(id);
      expect(order?.status).toBe(status);
      const events = await store.listOrderEvents(id);
      expect(events.map((e) => e.kind)).toEqual(['refund-received', 'owner-alerted']);
    }
  });

  it('five identical deliveries of one refund on a row with a supplier order give exactly one alert, one refund-received and one owner-alerted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const alerts: (OwnerAlert | null)[] = [];
    for (let i = 0; i < 5; i++) {
      alerts.push((await applyRefund(store, { orderId: 'O1', refundId: 'R-1', amount: 7.25, currency: 'GBP' })).alert);
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
    expect(events.map((e) => e.kind)).toEqual(['refund-received', 'owner-alerted', 'refund-received', 'owner-alerted']);
  });

  it('when refundId is empty, dedup falls back to an exact match on currency and amount', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const first = await applyRefund(store, { orderId: 'O1', refundId: '', amount: 7.25, currency: 'GBP' });
    expect(first.alert).not.toBeNull();

    const second = await applyRefund(store, { orderId: 'O1', refundId: '', amount: 7.25, currency: 'GBP' });
    expect(second.alert).toBeNull();

    const third = await applyRefund(store, { orderId: 'O1', refundId: '', amount: 3.0, currency: 'GBP' });
    expect(third.alert).not.toBeNull();

    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['refund-received', 'owner-alerted', 'refund-received', 'owner-alerted']);
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

    expect(alerts.length).toBe(4);
    for (const alert of alerts) {
      expect(alert).not.toBeNull();
      const combined = alert.subject + ' ' + alert.text;
      expect(combined).not.toContain(EM_DASH);
      expect(combined).not.toContain(EN_DASH);
    }
  });

  // Proven able to fail (see task-4-report.md, "Fix round 1"): the implementation
  // was temporarily edited to interpolate the seeded address name into one alert,
  // this test went red on that build, then the edit was reverted.
  it('never leaks the order address (name, street, postcode, phone) into an alert or an event detail, across every alerting path', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const pii = { name: 'Jane Example', address1: '42 Example Street', zip: 'SW1A 1AA', phone: '020 7123 4567' };
    const forbidden = [pii.name, pii.address1, pii.zip, pii.phone];
    const addressJson = JSON.stringify(pii);

    await seedOrder(store, 'P1', 'awaiting-payment', { cjOrderId: 'CJ-P1', addressJson });
    await seedOrder(store, 'P2', 'submitted', { cjOrderId: 'CJ-P2', addressJson });
    await seedOrder(store, 'P3', 'fulfilled', { cjOrderId: 'CJ-P3', trackingNumber: 'TRK-P3', addressJson });
    await seedOrder(store, 'P4', 'submitted', { cjOrderId: 'CJ-P4', addressJson });

    const alerts: OwnerAlert[] = [];
    alerts.push((await applyCancel(store, 'P1')).alert as OwnerAlert);
    alerts.push((await applyCancel(store, 'P2')).alert as OwnerAlert);
    alerts.push((await applyCancel(store, 'P3')).alert as OwnerAlert);
    alerts.push((await applyRefund(store, { orderId: 'P4', refundId: 'R-P4', amount: 4.4, currency: 'GBP' })).alert as OwnerAlert);

    for (const alert of alerts) {
      expect(alert).not.toBeNull();
      const combined = alert.subject + ' ' + alert.text;
      for (const word of forbidden) expect(combined).not.toContain(word);
    }

    for (const id of ['P1', 'P2', 'P3', 'P4']) {
      const events = await store.listOrderEvents(id);
      for (const event of events) {
        if (!event.detail) continue;
        for (const word of forbidden) expect(event.detail).not.toContain(word);
      }
    }
  });
});
