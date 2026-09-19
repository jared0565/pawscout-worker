import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  deliverOrderAlert, retryOrderAlerts, pendingAlerts, alertState, recordAlertDue,
  MAX_ALERT_ATTEMPTS, MAX_ALERT_RESENDS_PER_TICK, ALERT_DUE_GRACE_MS,
  type AlertResult, type AlertSend, type TrailEvent
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
  it('sent writes owner-alert-due then owner-alerted, both detailed with the subject', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, sendAnswering('sent'));
    expect(result).toBe('sent');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => ({ kind: e.kind, detail: e.detail }))).toEqual([
      { kind: 'owner-alert-due', detail: 'Order #O1 needs attention' },
      { kind: 'owner-alerted', detail: 'Order #O1 needs attention' }
    ]);
  });

  it('failed writes owner-alert-due then owner-alert-failed, and no owner-alerted', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, sendAnswering('failed'));
    expect(result).toBe('failed');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-due', 'owner-alert-failed']);
    expect(events[1].detail).toBe('Order #O1 needs attention');
  });

  it('unconfigured writes owner-alert-due then owner-alert-unconfigured, both detailed with the subject, and nothing else', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, sendAnswering('unconfigured'));
    expect(result).toBe('unconfigured');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => ({ kind: e.kind, detail: e.detail }))).toEqual([
      { kind: 'owner-alert-due', detail: 'Order #O1 needs attention' },
      { kind: 'owner-alert-unconfigured', detail: 'Order #O1 needs attention' }
    ]);
  });

  it('a send that throws is treated as failed, and deliverOrderAlert does not throw', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, throwingSend());
    expect(result).toBe('failed');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-due', 'owner-alert-failed']);
  });

  it('a send that rejects with null still answers failed, writes owner-alert-failed, and does not throw', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const nullRejectingSend: AlertSend = () => Promise.reject(null);
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'body text' }, nullRejectingSend);
    expect(result).toBe('failed');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-due', 'owner-alert-failed']);
  });

  // The whole point of this door: the DUE marker lands before the attempt,
  // not after it settles. A send that reads the trail from the inside sees
  // exactly one due row and nothing else - proof that the write already
  // landed before send was ever invoked, not merely that it lands eventually.
  it('writes owner-alert-due BEFORE calling send: a send that reads the trail sees exactly one due row', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    let seenAtSendTime: string[] = [];
    const send: AlertSend = async () => {
      seenAtSendTime = (await store.listOrderEvents('O1')).map((e) => e.kind);
      return 'sent';
    };
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, send);
    expect(result).toBe('sent');
    expect(seenAtSendTime).toEqual(['owner-alert-due']);
  });

  it('with dueRecorded: true, it writes no due row at all', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('sent'), { dueRecorded: true });
    expect(result).toBe('sent');
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['owner-alerted']);
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

  // deliverOrderAlert's due write is best-effort: a refused write must never
  // block the send that follows it, the same way a refused outcome marker
  // (see the durability describe below) never blocks answering the result.
  // This is the no-opts shape every fulfil-run.ts call site actually uses,
  // deliberately distinct from the durability describe's dueRecorded: true
  // calls, which point at the OUTCOME marker instead.
  it('a refused owner-alert-due write does not stop the send, and the outcome marker is still written', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const original = TenantStore.prototype.addOrderEvent;
    const spy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockImplementation(
      function (this: TenantStore, id: string, kind: string, detail?: string | null) {
        if (kind === 'owner-alert-due') return Promise.resolve(false);
        return original.call(this, id, kind as never, detail);
      }
    );
    try {
      const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('sent'));
      expect(result).toBe('sent');
    } finally {
      spy.mockRestore();
    }
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'owner-alerted')).toHaveLength(1);
  });
});

describe('retryOrderAlerts', () => {
  it('re-sends a failed alert once, with the same subject and the text built from the row (a row with a supplier order id and no tracking number)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    const subject = 'Order #O1 was cancelled: do NOT pay the supplier';

    // The due row is now written strictly before the failed row, so
    // "first raised at" should read the DUE row's timestamp, not the failed
    // row's. addOrderEvent stamps to the millisecond and the two writes
    // happen back to back, so without forcing them apart a test reading
    // either timestamp could pass by coincidence - advance the fake clock
    // between every write so the two are unambiguously different, and the
    // assertion below can only pass by reading the due row specifically.
    // (The pendingAlerts unit tests further below, with hand-built trails at
    // clearly distinct t1/t2/t3, are the other, simpler proof of this.)
    vi.useFakeTimers({ toFake: ['Date'] });
    const originalAdd = TenantStore.prototype.addOrderEvent;
    const addSpy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockImplementation(
      function (this: TenantStore, id: string, kind: string, detail?: string | null) {
        const p = originalAdd.call(this, id, kind as never, detail);
        vi.setSystemTime(new Date(Date.now() + 1000));
        return p;
      }
    );
    try {
      await deliverOrderAlert(store, 'O1', { subject, text: 'original text, never re-sent' }, sendAnswering('failed'));
    } finally {
      addSpy.mockRestore();
      vi.useRealTimers();
    }
    const dueEvent = (await store.listOrderEvents('O1')).find((e) => e.kind === 'owner-alert-due')!;
    const failedEvent = (await store.listOrderEvents('O1')).find((e) => e.kind === 'owner-alert-failed')!;
    expect(dueEvent.at).not.toBe(failedEvent.at); // the two writes are genuinely distinguishable
    const firstAt = dueEvent.at;

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

  // The sweep re-sends with dueRecorded: true - the pending state already
  // exists from the original attempt, so a second due row per retry would
  // only be noise, never information the retry identity needs.
  it('a sweep re-send writes no second due row, however many times it retries', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    const subject = 'Order #O1 needs attention';
    await deliverOrderAlert(store, 'O1', { subject, text: 'x' }, sendAnswering('failed'));
    await retryOrderAlerts(store, sendAnswering('failed'));
    await retryOrderAlerts(store, sendAnswering('failed'));
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'owner-alert-due')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'owner-alert-failed')).toHaveLength(3);
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

// An alert that was never told to anyone (no address or key configured) must
// never be resent by the sweep either - alertState already calls this
// 'nobody-to-tell' for a repeat delivery, and the sweep must agree, or a due
// row with no failure ever attached to it (the 'unconfigured' branch writes
// only an owner-alert-unconfigured marker, never owner-alert-failed) would
// sit in pendingAlerts forever and the sweep would re-send it, and its own
// unconfigured marker, on every tick for the rest of the retry window.
describe('the sweep must not resend an alert nobody was ever able to tell (unconfigured)', () => {
  it('a due alert whose send answers unconfigured is not resent once the grace window passes, and no second marker appears', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    const subject = 'Order #O1 needs attention';
    await deliverOrderAlert(store, 'O1', { subject, text: 'x' }, sendAnswering('unconfigured'));
    const before = await store.listOrderEvents('O1');
    expect(before.map((e) => e.kind)).toEqual(['owner-alert-due', 'owner-alert-unconfigured']);

    const past = new Date(Date.now() + ALERT_DUE_GRACE_MS + 60_000);
    const r = await retryOrderAlerts(store, sendAnswering('sent'), past);
    expect(r).toEqual({ retried: 0, delivered: 0 });

    const after = await store.listOrderEvents('O1');
    expect(after).toEqual(before); // nothing new was written
  });

  // One level below the store: the query already does the filtering
  // (tests/order-events-store.test.ts pins the SQL itself), so the sweep
  // must never even ask getOrder for an order whose only pending row has
  // since been ruled unconfigured.
  it('a sweep over a store holding only an unconfigured order asks getOrder for nothing', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('unconfigured'));
    const getOrderSpy = vi.spyOn(TenantStore.prototype, 'getOrder');
    try {
      const r = await retryOrderAlerts(store, sendAnswering('sent'));
      expect(r).toEqual({ retried: 0, delivered: 0 });
      expect(getOrderSpy).not.toHaveBeenCalled();
    } finally {
      getOrderSpy.mockRestore();
    }
  });
});

// End-to-end proof that a recorded-as-due alert survives a killed deferred
// send: recordAlertDue lands, and then NOTHING - the deferred task that
// would have sent the alert is killed before it ever runs (an evicted
// isolate at the webhook door). The due row is the only thing the retry
// sweep has to find, and it must not act on it too eagerly (the send might
// still be genuinely in flight elsewhere) nor too late (ALERT_RETRY_WINDOW_HOURS
// is 24 hours away).
describe('the kill: recordAlertDue lands but the send that would follow it never runs', () => {
  it('a sweep inside the grace window sends nothing; a sweep past it re-sends and delivers; a third sweep is quiet', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    const alert = { subject: 'Order #O1 was cancelled: do NOT pay the supplier', text: 'never sent - the deferred task died before this ran' };

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = new Date('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(start);
      const landed = await recordAlertDue(store, 'O1', alert);
      expect(landed).toBe(true);
      // Nothing else happens here - the deferred send is simulated as never
      // having run at all.

      const at30s = new Date(start.getTime() + 30_000);
      const sweep1 = await retryOrderAlerts(store, sendAnswering('sent'), at30s);
      expect(sweep1).toEqual({ retried: 0, delivered: 0 });

      const at2min = new Date(start.getTime() + 120_000);
      const sent: { subject: string; text: string }[] = [];
      const send: AlertSend = async (s, t) => { sent.push({ subject: s, text: t }); return 'sent'; };
      const sweep2 = await retryOrderAlerts(store, send, at2min);
      expect(sweep2).toEqual({ retried: 1, delivered: 1 });
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe(alert.subject);

      const events = await store.listOrderEvents('O1');
      expect(events.map((e) => e.kind)).toEqual(['owner-alert-due', 'owner-alerted']); // exactly one due row throughout

      const at3min = new Date(start.getTime() + 180_000);
      const sweep3 = await retryOrderAlerts(store, sendAnswering('sent'), at3min);
      expect(sweep3).toEqual({ retried: 0, delivered: 0 });
    } finally {
      vi.useRealTimers();
    }
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
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-due', 'owner-alert-failed']);
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
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-due', 'owner-alerted']);
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
    expect(events.map((e) => e.kind)).toEqual(['owner-alert-due', 'owner-alert-failed']);
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

  it('a due alone is pending with 0 failures', () => {
    const trail = [{ kind: 'owner-alert-due', detail: 'S', at: 't1' }];
    expect(pendingAlerts(trail).get('S')).toEqual({ firstAt: 't1', failures: 0 });
  });

  it('due then two failed keeps the due\'s at and counts 2', () => {
    const trail = [
      { kind: 'owner-alert-due', detail: 'S', at: 't1' },
      { kind: 'owner-alert-failed', detail: 'S', at: 't2' },
      { kind: 'owner-alert-failed', detail: 'S', at: 't3' }
    ];
    expect(pendingAlerts(trail).get('S')).toEqual({ firstAt: 't1', failures: 2 });
  });

  it('failed then due keeps the failed\'s at and counts 1 (a second due for an already-pending subject changes nothing)', () => {
    const trail = [
      { kind: 'owner-alert-failed', detail: 'S', at: 't1' },
      { kind: 'owner-alert-due', detail: 'S', at: 't2' }
    ];
    expect(pendingAlerts(trail).get('S')).toEqual({ firstAt: 't1', failures: 1 });
  });

  it('owner-alerted clears a due-only subject exactly as it does a failed one', () => {
    const trail = [
      { kind: 'owner-alert-due', detail: 'S', at: 't1' },
      { kind: 'owner-alerted', detail: 'S', at: 't2' }
    ];
    expect(pendingAlerts(trail).has('S')).toBe(false);
  });

  // See "the sweep must not resend..." above for the end-to-end proof: an
  // 'unconfigured' send writes only an owner-alert-unconfigured marker,
  // never owner-alert-failed, so a due row alone would otherwise sit in
  // pendingAlerts forever.
  it('an owner-alert-unconfigured row clears a due-only subject, the same as owner-alerted', () => {
    const trail = [
      { kind: 'owner-alert-due', detail: 'S', at: 't1' },
      { kind: 'owner-alert-unconfigured', detail: 'S', at: 't2' }
    ];
    expect(pendingAlerts(trail).has('S')).toBe(false);
  });

  // A LATER due row for the same subject (alerting was configured since)
  // re-creates the entry - the clear above is not sticky.
  it('a due row after an owner-alert-unconfigured row makes the subject pending again', () => {
    const trail = [
      { kind: 'owner-alert-due', detail: 'S', at: 't1' },
      { kind: 'owner-alert-unconfigured', detail: 'S', at: 't2' },
      { kind: 'owner-alert-due', detail: 'S', at: 't3' }
    ];
    expect(pendingAlerts(trail).get('S')).toEqual({ firstAt: 't3', failures: 0 });
  });

  // The abandoned line is still a plain 'error' kind row, which pendingAlerts
  // no longer parses at all (it only ever matched owner-alerted or
  // owner-alert-unconfigured by KIND now, never by text), so it can never be
  // mistaken for a clearing marker regardless of what its detail reads.
  it('the abandoned line (kind "error") is never treated as a clearing marker', () => {
    const trail = [
      { kind: 'owner-alert-due', detail: 'S', at: 't1' },
      { kind: 'owner-alert-failed', detail: 'S', at: 't2' },
      { kind: 'error', detail: 'owner alert abandoned after 12 attempts: S', at: 't3' }
    ];
    expect(pendingAlerts(trail).get('S')).toEqual({ firstAt: 't1', failures: 1 });
  });

  // Both rows now carry the SAME raw subject through addOrderEvent's
  // identical 300 character truncation, so a 290 character subject clears
  // exactly the same as a short one, unlike the earlier text-matched prefix
  // approach where the due row and the marker row truncated at different
  // points. The store-level test in tests/order-events-store.test.ts is the
  // one that could not have passed under that earlier approach.
  it('a 290 character subject is still cleared by the walk once ruled unconfigured', () => {
    const subject = 'Order #O1 ' + 'x'.repeat(280);
    expect(subject.length).toBe(290);
    const trail = [
      { kind: 'owner-alert-due', detail: subject, at: 't1' },
      { kind: 'owner-alert-unconfigured', detail: subject, at: 't2' }
    ];
    expect(pendingAlerts(trail).has(subject)).toBe(false);
  });
});

describe('recordAlertDue', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('answers true and writes one owner-alert-due row whose detail is the subject', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const landed = await recordAlertDue(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' });
    expect(landed).toBe(true);
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => ({ kind: e.kind, detail: e.detail }))).toEqual([
      { kind: 'owner-alert-due', detail: 'Order #O1 needs attention' }
    ]);
  });

  it('answers false after two refused writes, and logs exactly one console.error', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const addSpy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const landed = await recordAlertDue(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' });
    expect(landed).toBe(false);
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect((await store.listOrderEvents('O1')).filter((e) => e.kind === 'owner-alert-due')).toHaveLength(0);
  });
});

describe('alertState', () => {
  const now = new Date('2026-01-02T00:00:00.000Z');

  it('delivered: an owner-alerted whose detail is the subject', () => {
    const trail: TrailEvent[] = [{ kind: 'owner-alerted', detail: 'S', at: 't1' }];
    expect(alertState(trail, 'S', now)).toBe('delivered');
  });

  it('nobody-to-tell: an owner-alert-unconfigured row whose detail is exactly the subject', () => {
    const trail: TrailEvent[] = [{ kind: 'owner-alert-unconfigured', detail: 'S', at: 't1' }];
    expect(alertState(trail, 'S', now)).toBe('nobody-to-tell');
  });

  it('retrying: a failed send is still within its attempt budget and retry window', () => {
    const trail: TrailEvent[] = [{ kind: 'owner-alert-failed', detail: 'S', at: now.toISOString() }];
    expect(alertState(trail, 'S', now)).toBe('retrying');
  });

  it('untold: no trail event for this subject at all (a clean first delivery)', () => {
    expect(alertState([], 'S', now)).toBe('untold');
  });

  it('untold: 12 failures have reached the abandonment cap', () => {
    const trail: TrailEvent[] = Array.from({ length: MAX_ALERT_ATTEMPTS }, () => ({ kind: 'owner-alert-failed', detail: 'S', at: now.toISOString() }));
    expect(alertState(trail, 'S', now)).toBe('untold');
  });

  it('untold: the first failure is 25 hours older than now, outside the retry window', () => {
    const firstAt = new Date(now.getTime() - 25 * 3_600_000).toISOString();
    const trail: TrailEvent[] = [{ kind: 'owner-alert-failed', detail: 'S', at: firstAt }];
    expect(alertState(trail, 'S', now)).toBe('untold');
  });

  it('delivered takes precedence over a failure of the same subject regardless of order', () => {
    const trail: TrailEvent[] = [
      { kind: 'owner-alert-failed', detail: 'S', at: 't1' },
      { kind: 'owner-alerted', detail: 'S', at: 't2' }
    ];
    expect(alertState(trail, 'S', now)).toBe('delivered');
  });

  it('defaults now to the current time when omitted', () => {
    const recent = new Date().toISOString();
    const trail: TrailEvent[] = [{ kind: 'owner-alert-failed', detail: 'S', at: recent }];
    expect(alertState(trail, 'S')).toBe('retrying');
  });

  // A subject with only a due row (no failure yet) needs no code change here:
  // pendingAlerts already gives it a { firstAt, failures: 0 } entry, and
  // failures (0) < MAX_ALERT_ATTEMPTS is trivially true, so the existing
  // window check alone decides retrying vs untold. Pinned explicitly so a
  // future change to either function cannot quietly break it.
  it('retrying: a fresh due-only subject (no failure yet) is still within its window', () => {
    const trail: TrailEvent[] = [{ kind: 'owner-alert-due', detail: 'S', at: now.toISOString() }];
    expect(alertState(trail, 'S', now)).toBe('retrying');
  });

  it('untold: a due-only subject whose due row is older than 24 hours', () => {
    const firstAt = new Date(now.getTime() - 25 * 3_600_000).toISOString();
    const trail: TrailEvent[] = [{ kind: 'owner-alert-due', detail: 'S', at: firstAt }];
    expect(alertState(trail, 'S', now)).toBe('untold');
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

// The sweep's own shape: one due row up front, then repeat deliveries all
// passing dueRecorded: true (as retryOrderAlerts itself does). Proves the
// abandonment count and the due-row count are independent of each other.
describe('12 failures after a due', () => {
  it('still write exactly one abandoned line, on the 12th FAILURE, and exactly one due row throughout', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1', { cjOrderId: 'CJ-1' });
    const subject = 'Order #O1 needs attention';
    await recordAlertDue(store, 'O1', { subject, text: 'x' });
    for (let i = 0; i < MAX_ALERT_ATTEMPTS; i++) {
      await deliverOrderAlert(store, 'O1', { subject, text: 'x' }, sendAnswering('failed'), { dueRecorded: true });
    }
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'owner-alert-due')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'owner-alert-failed')).toHaveLength(MAX_ALERT_ATTEMPTS);
    const abandoned = events.filter((e) => e.kind === 'error');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].detail).toBe(`owner alert abandoned after ${MAX_ALERT_ATTEMPTS} attempts: ${subject}`);
  });
});

describe('deliverOrderAlert marker durability (a lost marker write is retried once, then loud)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // These pin the write-twice-then-log durability of the SEND OUTCOME
  // marker specifically (owner-alerted / owner-alert-failed) - a concern
  // distinct from the due marker's own durability, which recordAlertDue's
  // own tests above cover directly. dueRecorded: true keeps that separation
  // honest: without it, a mock that answers false once would land on the
  // due write instead of the outcome write, silently testing the wrong
  // line. The cost is that these calls no longer mirror the no-opts shape
  // fulfil-run.ts actually uses at its call sites - an accepted trade for
  // keeping each durability test pointed at one write.
  it('failed: a marker write refused once then landing leaves exactly one owner-alert-failed row and logs no error', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const addSpy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('failed'), { dueRecorded: true });
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
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('failed'), { dueRecorded: true });
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
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('sent'), { dueRecorded: true });
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
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('sent'), { dueRecorded: true });
    expect(result).toBe('sent');
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = errSpy.mock.calls[0][0] as string;
    expect(message).toContain('O1');
    expect(message).toContain('owner-alerted');
    expect(message).toContain('Order #O1 needs attention');
  });

  // owner-alert-unconfigured now goes through the same durable helper as the
  // other two outcome markers (it used to be a single unchecked write), so
  // it gets the same write-twice-then-log guarantee.
  it('unconfigured: a marker write refused once then landing leaves exactly one owner-alert-unconfigured row and logs no error', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'O1');
    const addSpy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await deliverOrderAlert(store, 'O1', { subject: 'Order #O1 needs attention', text: 'x' }, sendAnswering('unconfigured'), { dueRecorded: true });
    expect(result).toBe('unconfigured');
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(errSpy).not.toHaveBeenCalled();
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'owner-alert-unconfigured')).toHaveLength(1);
  });
});
