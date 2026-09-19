import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  deliverOrderAlert, retryOrderAlerts, pendingAlerts,
  MAX_ALERT_ATTEMPTS, MAX_ALERT_RESENDS_PER_TICK,
  type AlertResult, type AlertSend
} from '../src/order-alert';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';

async function seedOrder(
  store: TenantStore, id: string, extra: { cjOrderId?: string; trackingNumber?: string; status?: 'submitted' | 'held' } = {}
): Promise<void> {
  await store.insertOrderIfNew({
    shopifyOrderId: id, orderName: '#' + id, totalPrice: 20, currency: 'GBP', financialStatus: 'paid', riskLevel: null,
    status: extra.status ?? 'submitted', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null
  });
  if (extra.cjOrderId) await store.updateOrder(id, { cj_order_id: extra.cjOrderId });
  if (extra.trackingNumber) await store.updateOrder(id, { tracking_number: extra.trackingNumber });
}

function sendAnswering(result: AlertResult): AlertSend {
  return async () => result;
}

function throwingSend(): AlertSend {
  return async () => { throw new Error('network down'); };
}

describe('deliverOrderAlert', () => {
  it('sent writes one owner-alerted whose detail is the subject', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, sendAnswering('sent'));
    expect(result).toBe('sent');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => ({ kind: e.kind, detail: e.detail }))).toEqual([
      { kind: 'owner-alerted', detail: 'Order #O1 needs attention' }
    ]);
  });

  it('failed writes one owner-alert-failed whose detail is the subject, and no owner-alerted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, sendAnswering('failed'));
    expect(result).toBe('failed');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-failed']);
    expect(events[0].detail).toBe('Order #O1 needs attention');
  });

  it('unconfigured writes one error with detail "owner alert not configured: <subject>" and nothing else', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, sendAnswering('unconfigured'));
    expect(result).toBe('unconfigured');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => ({ kind: e.kind, detail: e.detail }))).toEqual([
      { kind: 'error', detail: 'owner alert not configured: Order #O1 needs attention' }
    ]);
  });

  it('a send that throws is treated as failed, and deliverOrderAlert does not throw', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, throwingSend());
    expect(result).toBe('failed');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-failed']);
  });

  it('a send that rejects with null still answers failed, writes owner-alert-failed, and does not throw', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const nullRejectingSend: AlertSend = () => Promise.reject(null);
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, nullRejectingSend);
    expect(result).toBe('failed');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-failed']);
  });

  it('no alert TEXT ever appears in the trail', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const MARKER = 'MARKERWORD';
    await deliverOrderAlert(store, 'O1', { subject: 'Subject one', text: `body containing ${MARKER}` }, sendAnswering('sent'));
    await deliverOrderAlert(store, 'O1', { subject: 'Subject two', text: `body containing ${MARKER}` }, sendAnswering('failed'));
    await deliverOrderAlert(store, 'O1', { subject: 'Subject three', text: `body containing ${MARKER}` }, sendAnswering('unconfigured'));
    const events = await store.listOrderEvents('O1');
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.detail ?? '').not.toContain(MARKER);
  });
});

describe('retryOrderAlerts', () => {
  it('re-sends a failed alert once, with the same subject and the text built from the row (a row with a supplier order id and no tracking number)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    const subject = 'Order #O1 was cancelled: do NOT pay the supplier';
    await deliverOrderAlert(store, 'O1', { subject, text: 'original text, never re-sent' }, sendAnswering('failed'));
    const failedEvent = (await store.listOrderEvents('O1')).find((e) => e.kind === 'owner-alert-failed')!;
    const firstAt = failedEvent.at;

    const sent: { subject: string; text: string }[] = [];
    const send: AlertSend = async (s, t) => { sent.push({ subject: s, text: t }); return 'sent'; };
    const r = await retryOrderAlerts(store, send);
    expect(r).toEqual({ retried: 1, delivered: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(subject);
    expect(sent[0].text).toBe(
      `This alert was first raised at ${firstAt} and could not be delivered then.\n\n${subject}.\n\nSupplier order: CJ-1. Tracking: (not recorded). Status here: submitted.\n\nDo not pay or settle anything for this order at the supplier until you have read its trail: open the PawScout console, Orders, and open this order's trail for the full history.`
    );
  });

  it('after a retry answers sent, a second retryOrderAlerts sends nothing', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('failed'));
    const r1 = await retryOrderAlerts(store, sendAnswering('sent'));
    expect(r1).toEqual({ retried: 1, delivered: 1 });
    const r2 = await retryOrderAlerts(store, sendAnswering('sent'));
    expect(r2).toEqual({ retried: 0, delivered: 0 });
  });

  it('two different failed subjects on one order are both retried; delivering one leaves the other pending', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    await deliverOrderAlert(store, 'O1', { subject: 'Subject A', text: 'a' }, sendAnswering('failed'));
    await deliverOrderAlert(store, 'O1', { subject: 'Subject B', text: 'b' }, sendAnswering('failed'));

    const sent: string[] = [];
    const send: AlertSend = async (s) => { sent.push(s); return s === 'Subject A' ? 'sent' : 'failed'; };
    const r = await retryOrderAlerts(store, send);
    expect(r).toEqual({ retried: 2, delivered: 1 });
    expect(sent.sort()).toEqual(['Subject A', 'Subject B']);

    const events = await store.listOrderEvents('O1');
    expect(events.some((e) => e.kind === 'owner-alerted' && e.detail === 'Subject A')).toBe(true);
    expect(events.filter((e) => e.kind === 'owner-alert-failed' && e.detail === 'Subject B')).toHaveLength(2);
  });

  it('a subject with 12 failures is not retried, and the 12th failure wrote exactly one abandoned line', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    const subject = 'Order #O1 needs attention';
    for (let i = 0; i < MAX_ALERT_ATTEMPTS; i++) {
      await deliverOrderAlert(store, 'O1', { subject, text: 'body' }, sendAnswering('failed'));
    }
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'owner-alert-failed')).toHaveLength(MAX_ALERT_ATTEMPTS);
    const abandoned = events.filter((e) => e.kind === 'error');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].detail).toBe(`owner alert abandoned after ${MAX_ALERT_ATTEMPTS} attempts: ${subject}`);

    const r = await retryOrderAlerts(store, sendAnswering('sent'));
    expect(r).toEqual({ retried: 0, delivered: 0 });
  });

  it('a failure whose FIRST failure is older than 24 hours is not retried, even when a second, recent subject on the same order keeps the order itself a candidate', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });

    // A single-subject version of this scenario is no longer discriminating:
    // listOrderIdsWithPendingAlerts's own HAVING MIN(f.at) >= sinceIso would
    // already exclude a subject whose only failures are all outside the
    // window, so the order would never reach the loop at all and the
    // in-code check below would go untested. Giving the order a SECOND,
    // recent subject keeps the order itself a query candidate (because of
    // that subject), so only the in-code firstAt check can still exclude
    // the old one.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      await deliverOrderAlert(store, 'O1', { subject: 'Old alert', text: 'x' }, sendAnswering('failed'));
      vi.setSystemTime(new Date('2026-01-01T23:00:00.000Z')); // 23 hours after the first failure, same subject
      await deliverOrderAlert(store, 'O1', { subject: 'Old alert', text: 'x' }, sendAnswering('failed'));
      vi.setSystemTime(new Date('2026-01-02T00:30:00.000Z')); // a different subject, only 30 minutes old
      await deliverOrderAlert(store, 'O1', { subject: 'Recent alert', text: 'y' }, sendAnswering('failed'));
    } finally {
      vi.useRealTimers();
    }

    // now is 25 hours after "Old alert"'s FIRST failure, so the store's
    // HAVING bound already excludes it on its own; "Recent alert" is only
    // 30 minutes old, so the order is still a candidate through it, and
    // only the in-code firstAt check decides that "Old alert" specifically
    // must not be resent while "Recent alert" is.
    const now = new Date('2026-01-02T01:00:00.000Z');
    const sent: string[] = [];
    const r = await retryOrderAlerts(store, async (s) => { sent.push(s); return 'sent'; }, now);
    expect(r).toEqual({ retried: 1, delivered: 1 });
    expect(sent).toEqual(['Recent alert']);
  });

  it('an owner-alerted for subject A does not clear a pending subject B', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    await deliverOrderAlert(store, 'O1', { subject: 'Subject A', text: 'a' }, sendAnswering('sent'));
    await deliverOrderAlert(store, 'O1', { subject: 'Subject B', text: 'b' }, sendAnswering('failed'));

    const sent: string[] = [];
    const send: AlertSend = async (s) => { sent.push(s); return 'sent'; };
    const r = await retryOrderAlerts(store, send);
    expect(r).toEqual({ retried: 1, delivered: 1 });
    expect(sent).toEqual(['Subject B']);
  });

  it('a sweep re-sends at most MAX_ALERT_RESENDS_PER_TICK alerts, and the rest wait for the next one', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (let i = 1; i <= 12; i++) {
      const id = `O${i}`;
      await seedOrder(store, id);
      await deliverOrderAlert(store, id, { subject: `Order #${id} needs attention`, text: 'x' }, sendAnswering('failed'));
    }

    const sent1: string[] = [];
    const r1 = await retryOrderAlerts(store, async (s) => { sent1.push(s); return 'sent'; });
    expect(r1).toEqual({ retried: MAX_ALERT_RESENDS_PER_TICK, delivered: MAX_ALERT_RESENDS_PER_TICK });
    expect(sent1).toHaveLength(MAX_ALERT_RESENDS_PER_TICK);

    const sent2: string[] = [];
    const r2 = await retryOrderAlerts(store, async (s) => { sent2.push(s); return 'sent'; });
    expect(r2).toEqual({ retried: 2, delivered: 2 });
    expect(sent2).toHaveLength(2);
  });
});

describe('retryOrderAlerts uses the query to filter candidates, not just the walk', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('re-sends exactly the live order among a delivered, an abandoned and an expired one, and asks the store for only that order', async () => {
    const store = new TenantStore(env.DB, SHOP);

    // delivered: failed once, then delivered - no longer pending
    await seedOrder(store, 'DELIVERED');
    await deliverOrderAlert(store, 'DELIVERED', { subject: 'Order #DELIVERED needs attention', text: 'x' }, sendAnswering('failed'));
    await deliverOrderAlert(store, 'DELIVERED', { subject: 'Order #DELIVERED needs attention', text: 'x' }, sendAnswering('sent'));

    // abandoned: failed MAX_ALERT_ATTEMPTS times since the last (in this case, only) delivery
    await seedOrder(store, 'ABANDONED');
    for (let i = 0; i < MAX_ALERT_ATTEMPTS; i++) {
      await deliverOrderAlert(store, 'ABANDONED', { subject: 'Order #ABANDONED needs attention', text: 'x' }, sendAnswering('failed'));
    }

    // expired: its only, undelivered failure is older than the 24 hour window
    await seedOrder(store, 'EXPIRED');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() - 25 * 3_600_000));
      await deliverOrderAlert(store, 'EXPIRED', { subject: 'Order #EXPIRED needs attention', text: 'x' }, sendAnswering('failed'));
    } finally {
      vi.useRealTimers();
    }

    // live: currently pending, within the window, fewer than max attempts
    await seedOrder(store, 'LIVE');
    await deliverOrderAlert(store, 'LIVE', { subject: 'Order #LIVE needs attention', text: 'x' }, sendAnswering('failed'));

    const getOrderSpy = vi.spyOn(TenantStore.prototype, 'getOrder');
    const sent: string[] = [];
    const r = await retryOrderAlerts(store, async (s) => { sent.push(s); return 'sent'; });

    expect(r).toEqual({ retried: 1, delivered: 1 });
    expect(sent).toEqual(['Order #LIVE needs attention']);
    // the query, not the walk, kept the other three orders out: getOrder was
    // asked for ONLY the live one
    expect(getOrderSpy.mock.calls.map((c) => c[0])).toEqual(['LIVE']);
  });
});

describe('deliverOrderAlert timeout (a send cannot hang forever)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a send that never settles is treated as failed once the timeout passes, and leaves owner-alert-failed', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const hangingSend: AlertSend = () => new Promise<AlertResult>(() => { /* never settles */ });
    const result = await deliverOrderAlert(
      store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, hangingSend, { timeoutMs: 20 }
    );
    expect(result).toBe('failed');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-failed']);
  });

  it('a send that answers within the timeout is unaffected, and the timer is cleared', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const result = await deliverOrderAlert(
      store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('sent'), { timeoutMs: 20 }
    );
    expect(result).toBe('sent');
    expect(clearSpy).toHaveBeenCalled();
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alerted']);
  });

  it('a send that throws synchronously (not async) answers failed, does not throw, and the timer is cleared', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const syncThrowingSend: AlertSend = () => { throw new Error('boom'); };
    const result = await deliverOrderAlert(
      store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, syncThrowingSend, { timeoutMs: 20 }
    );
    expect(result).toBe('failed');
    expect(clearSpy).toHaveBeenCalled();
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-failed']);
  });
});

describe('pendingAlerts', () => {
  it('counts failures for a subject since its last delivery, resetting on owner-alerted', () => {
    const trail = [
      { kind: 'owner-alert-failed', detail: 'S', at: 't1' },
      { kind: 'owner-alert-failed', detail: 'S', at: 't2' },
      { kind: 'owner-alerted', detail: 'S', at: 't3' },
      { kind: 'owner-alert-failed', detail: 'S', at: 't4' }
    ];
    const pending = pendingAlerts(trail);
    expect(pending.get('S')).toEqual({ firstAt: 't4', failures: 1 });
  });

  it('tracks independent subjects separately, and a delivery of one leaves another pending', () => {
    const trail = [
      { kind: 'owner-alert-failed', detail: 'A', at: 't1' },
      { kind: 'owner-alert-failed', detail: 'B', at: 't2' },
      { kind: 'owner-alerted', detail: 'A', at: 't3' }
    ];
    const pending = pendingAlerts(trail);
    expect(pending.has('A')).toBe(false);
    expect(pending.get('B')).toEqual({ firstAt: 't2', failures: 1 });
  });
});

describe('deliverOrderAlert and retryOrderAlerts share one walk (a subject can be abandoned more than once)', () => {
  it('the abandoned line is written only when the sweep would also stop retrying, and a second abandonment after a second delivery is recorded too', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const subject = 'Order #O1 needs attention';
    const fail = () => deliverOrderAlert(store, 'O1', { subject, text: 'x' }, sendAnswering('failed'));
    const deliver = () => deliverOrderAlert(store, 'O1', { subject, text: 'x' }, sendAnswering('sent'));

    for (let i = 0; i < 5; i++) await fail();
    await deliver();
    for (let i = 0; i < 7; i++) await fail();
    let events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0); // 7 failures since the delivery, not 12 - no abandoned line yet

    for (let i = 0; i < 5; i++) await fail(); // 12 failures since the delivery now
    events = await store.listOrderEvents('O1');
    const abandonedOnce = events.filter((e) => e.kind === 'error');
    expect(abandonedOnce).toHaveLength(1);
    expect(abandonedOnce[0].detail).toBe(`owner alert abandoned after ${MAX_ALERT_ATTEMPTS} attempts: ${subject}`);

    await deliver();
    for (let i = 0; i < 12; i++) await fail();
    events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(2); // the second real give-up is recorded too
  });
});

describe('deliverOrderAlert marker durability (a lost marker write is retried once, then loud)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('failed: a marker write refused once then landing leaves exactly one owner-alert-failed row and logs no error', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const addSpy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('failed'));
    expect(result).toBe('failed');
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(errSpy).not.toHaveBeenCalled();
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'owner-alert-failed')).toHaveLength(1);
  });

  it('failed: both marker writes refused logs exactly one console.error, and the send result is still returned', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const addSpy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('failed'));
    expect(result).toBe('failed');
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = errSpy.mock.calls[0][0] as string;
    expect(message).toContain('O1');
    expect(message).toContain('owner-alert-failed');
    expect(message).toContain('Order #O1 needs attention');
  });

  it('sent: a marker write refused once then landing leaves exactly one owner-alerted row and logs no error', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const addSpy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('sent'));
    expect(result).toBe('sent');
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(errSpy).not.toHaveBeenCalled();
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'owner-alerted')).toHaveLength(1);
  });

  it('sent: both marker writes refused logs exactly one console.error, and the send result is still returned', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const addSpy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('sent'));
    expect(result).toBe('sent');
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = errSpy.mock.calls[0][0] as string;
    expect(message).toContain('O1');
    expect(message).toContain('owner-alerted');
    expect(message).toContain('Order #O1 needs attention');
  });
});
