/// <reference types="@cloudflare/vitest-pool-workers" />
// The two new Shopify order webhook routes (orders-cancelled, refunds-create)
// plus HTTP-level coverage of orders-paid's new trail writes. Drives the real
// Hono app with HMAC-signed requests, same pattern as
// tests/affiliate-console.test.ts (see hmacBase64 there, from line 240 -
// copied here since no shared test helper module exists for it).
//
// Also pins the seam-closing rule that every entry in REQUIRED_TOPICS must
// answer 401 (never 404) to an unsigned POST, so a topic added later without
// a route is caught here rather than in production.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { TenantStore, type OrderRow } from '../src/tenant-store';
import {
  DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, type TenantConfig, type Env
} from '../src/types';
import { REQUIRED_TOPICS } from '../src/webhooks';
import { JOB_STAMP_ORDER_HOOKS, JOB_STAMP_TTL_DAYS } from '../src/jobs';
import { app, parseStoredHooks, orderEventsForOrder, projectHooks, manualCheckConsecutiveFailures } from '../src/index';

// Every waitUntil call across a request is recorded here so a test can
// assert exactly how many alert sends a route made. On a SUCCESSFUL delivery
// of orders-cancelled or refunds-create, this count is exactly the alert-send
// count for that route (both call waitUntil only through sendOrderAlert on
// success). On a FAILED delivery, any of the three order routes can also hand
// the give-up alert to waitUntil, through the shared failure helper. Reset
// per test.
let waitUntilCalls: Promise<unknown>[] = [];

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  waitUntilCalls = [];
});

const SHOP = 'a.myshopify.com';
const WEBHOOK_SECRET = 'test-webhook-secret';
const APP_URL = 'https://pawscout.example.com';

function webhookEnv(): Env {
  return { ...env, SHOPIFY_API_SECRET: WEBHOOK_SECRET, SHOPIFY_APP_URL: APP_URL } as unknown as Env;
}

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  let binary = '';
  for (const b of new Uint8Array(sig)) binary += String.fromCharCode(b);
  return btoa(binary);
}

// A stub ExecutionContext (same pattern as tests/inbox-handler.test.ts): without
// one, Hono's app.request leaves c.executionCtx unset and a handler's own
// c.executionCtx.waitUntil(...) throws "This context has no ExecutionContext" -
// caught by the handler's try/catch, but that would silently skip every write
// that happens to be coded after the throwing line. A stub keeps the route's
// real control flow intact instead of relying on an incidental catch, and
// records what it is handed so a test can pin the alert door.
const FAKE_CTX = { waitUntil: (p: Promise<unknown>) => { waitUntilCalls.push(p); } } as unknown as ExecutionContext;

async function postWebhook(path: string, rawBody: string, opts: { topic?: string; badSignature?: boolean; webhookId?: string } = {}): Promise<Response> {
  const hmac = opts.badSignature ? 'not-a-real-signature==' : await hmacBase64(WEBHOOK_SECRET, rawBody);
  return app.request(`${APP_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Topic': opts.topic ?? '',
      'X-Shopify-Shop-Domain': SHOP,
      'X-Shopify-Webhook-Id': opts.webhookId ?? 'whk-1',
      'X-Shopify-API-Version': '2025-07',
    },
    body: rawBody,
  }, webhookEnv(), FAKE_CTX);
}

const MIN_CFG: TenantConfig = {
  collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, target: 12
} as TenantConfig;

async function seedConfig(): Promise<TenantStore> {
  const store = new TenantStore(env.DB, SHOP);
  await store.seedConfig(MIN_CFG);
  return store;
}

async function seedOrder(
  store: TenantStore, id: string, status: OrderRow['status'], extra: { cjOrderId?: string } = {}
): Promise<void> {
  await store.insertOrderIfNew({
    shopifyOrderId: id, orderName: '#' + id, totalPrice: 20, currency: 'GBP', financialStatus: 'paid', riskLevel: null,
    status, holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null
  });
  if (extra.cjOrderId) await store.updateOrder(id, { cj_order_id: extra.cjOrderId });
}

// --- orchestrator decision 1: every REQUIRED_TOPICS path answers 401, never
// 404, to an unsigned request. Iterates the real list so a future topic added
// without a route fails this test instead of shipping unrouted. ---
describe('REQUIRED_TOPICS routes: unsigned POST always 401, never 404', () => {
  for (const { topic, path } of REQUIRED_TOPICS) {
    it(`${path} (${topic})`, async () => {
      const res = await app.request(`${APP_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Shop-Domain': SHOP },
        body: '{}',
      }, webhookEnv(), FAKE_CTX);
      expect(res.status).toBe(401);
    });
  }
});

describe('POST /webhooks/orders-cancelled', () => {
  it('a bad signature answers 401 and changes nothing', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'queued');
    const res = await postWebhook('/webhooks/orders-cancelled', JSON.stringify({ id: 'O1' }), { topic: 'orders/cancelled', badSignature: true });
    expect(res.status).toBe(401);
    expect((await store.getOrder('O1'))?.status).toBe('queued');
    expect(await store.listOrderEvents('O1')).toEqual([]);
  });

  it('a valid cancel for a queued order makes it cancelled and sends no alert', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'queued');
    const res = await postWebhook('/webhooks/orders-cancelled', JSON.stringify({ id: 'O1' }), { topic: 'orders/cancelled' });
    expect(res.status).toBe(200);
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    // A queued row with no supplier order carries no alert (see
    // src/order-cancel.ts's applyCancel) - the alert door must stay shut.
    expect(waitUntilCalls).toHaveLength(0);
  });

  it('the same valid cancel delivered twice leaves one cancel-received event', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'queued');
    const payload = JSON.stringify({ id: 'O1' });
    await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled' });
    await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled' });
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'cancel-received')).toHaveLength(1);
  });

  it('a valid cancel for an unknown order answers 200 and creates no row or trail', async () => {
    await seedConfig();
    const res = await postWebhook('/webhooks/orders-cancelled', JSON.stringify({ id: 'GHOST' }), { topic: 'orders/cancelled' });
    expect(res.status).toBe(200);
    expect(await new TenantStore(env.DB, SHOP).getOrder('GHOST')).toBeNull();
    expect(await new TenantStore(env.DB, SHOP).listOrderEvents('GHOST')).toEqual([]);
  });

  it('a valid cancel for an awaiting-payment order makes it cancelled and sends exactly one alert; with no Resend key in this test env, delivery leaves owner-alert-unconfigured rather than owner-alerted', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const res = await postWebhook('/webhooks/orders-cancelled', JSON.stringify({ id: 'O1' }), { topic: 'orders/cancelled' });
    expect(res.status).toBe(200);
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    // this is the alert the whole route exists to send ("do NOT pay the
    // supplier") - it must actually reach the alert door.
    expect(waitUntilCalls).toHaveLength(1);
    // delivery itself now runs inside waitUntil, so it must be awaited before
    // the trail write it produces can be read. The alert is recorded as DUE
    // before the route even answers - see the dedicated test below - so the
    // settled trail carries that marker too, ahead of the send outcome.
    await Promise.all(waitUntilCalls);
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['cancel-received', 'owner-alert-due', 'owner-alert-unconfigured']);
    expect(events[2].detail).toBe('Order #O1 was cancelled: do NOT pay the supplier');
  });

  // The whole point of this route's alert door: the alert's trail marker is
  // recorded as DUE before the route answers, not only after the deferred
  // send settles. This asserts on the trail BEFORE awaiting the deferred
  // promise handed to waitUntil, so it can only pass if recordAlertDue
  // already landed while the route itself was still running.
  it('an alerting cancel leaves owner-alert-due in the trail before the deferred delivery promise is awaited, and its own outcome marker after', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const res = await postWebhook('/webhooks/orders-cancelled', JSON.stringify({ id: 'O1' }), { topic: 'orders/cancelled' });
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1); // still exactly ONE promise handed to waitUntil
    const beforeAwait = await store.listOrderEvents('O1');
    expect(beforeAwait.map((e) => e.kind)).toEqual(['cancel-received', 'owner-alert-due']);

    await Promise.all(waitUntilCalls);
    const afterAwait = await store.listOrderEvents('O1');
    expect(afterAwait.map((e) => e.kind)).toEqual(['cancel-received', 'owner-alert-due', 'owner-alert-unconfigured']);
  });

  it('a malformed JSON body still answers 200', async () => {
    await seedConfig();
    const res = await postWebhook('/webhooks/orders-cancelled', 'not json {{{', { topic: 'orders/cancelled' });
    expect(res.status).toBe(200);
  });

  // End-to-end proof that a repeat delivery heals a lost alert: the trail
  // already holds cancel-received (from a first delivery) but no marker for
  // the alert it raised - the process could have died, or the route could
  // have failed, between that write and delivery. A second delivery (a
  // genuinely new webhook id, since Shopify's own redelivery of the SAME id
  // would just be deduped upstream of this route by the webhook id cache)
  // must still hand the alert to the alert door, and a third must go quiet
  // once that delivery leaves its own marker.
  it('a repeat cancel delivery heals a lost alert: the trail holds cancel-received but no marker, a second delivery raises it, a third goes quiet', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    await store.addOrderEvent('O1', 'cancel-received', 'was awaiting-payment');
    expect(await store.listOrderEvents('O1')).toHaveLength(1); // no alert marker yet

    const res2 = await postWebhook('/webhooks/orders-cancelled', JSON.stringify({ id: 'O1' }), { topic: 'orders/cancelled', webhookId: 'whk-heal-2' });
    expect(res2.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
    await Promise.all(waitUntilCalls);
    const eventsAfterSecond = await store.listOrderEvents('O1');
    expect(eventsAfterSecond.map((e) => e.kind)).toEqual(['cancel-received', 'owner-alert-due', 'owner-alert-unconfigured']);
    expect(eventsAfterSecond[2].detail).toBe('Order #O1 was cancelled: do NOT pay the supplier');

    const waitUntilBeforeThird = waitUntilCalls.length;
    const res3 = await postWebhook('/webhooks/orders-cancelled', JSON.stringify({ id: 'O1' }), { topic: 'orders/cancelled', webhookId: 'whk-heal-3' });
    expect(res3.status).toBe(200);
    expect(waitUntilCalls.length).toBe(waitUntilBeforeThird); // nothing new handed to waitUntil
    const eventsAfterThird = await store.listOrderEvents('O1');
    expect(eventsAfterThird).toEqual(eventsAfterSecond); // unchanged
  });
});

describe('POST /webhooks/refunds-create', () => {
  it('a bad signature answers 401 and changes nothing (mirrors the orders-cancelled twin)', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'queued');
    const res = await postWebhook('/webhooks/refunds-create', JSON.stringify({ id: 1, order_id: 'O1', transactions: [] }), { topic: 'refunds/create', badSignature: true });
    expect(res.status).toBe(401);
    expect((await store.getOrder('O1'))?.status).toBe('queued');
    expect(await store.listOrderEvents('O1')).toEqual([]);
  });

  it('a valid refund for a queued order with no supplier order makes it held with ["refunded"] and sends no alert', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'queued');
    const payload = JSON.stringify({ id: 555, order_id: 'O1', transactions: [{ kind: 'refund', amount: '5.00', currency: 'GBP' }] });
    const res = await postWebhook('/webhooks/refunds-create', payload, { topic: 'refunds/create' });
    expect(res.status).toBe(200);
    const order = await store.getOrder('O1');
    expect(order?.status).toBe('held');
    expect(JSON.parse(order?.hold_reasons ?? '[]')).toEqual(['refunded']);
    // No supplier order exists yet, so applyRefund raises no alert.
    expect(waitUntilCalls).toHaveLength(0);
  });

  it('a valid refund for a row with a supplier order sends exactly one alert; with no Resend key in this test env, delivery leaves owner-alert-unconfigured rather than owner-alerted', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const payload = JSON.stringify({ id: 777, order_id: 'O1', transactions: [{ kind: 'refund', amount: '12.50', currency: 'GBP' }] });
    const res = await postWebhook('/webhooks/refunds-create', payload, { topic: 'refunds/create' });
    expect(res.status).toBe(200);
    expect((await store.getOrder('O1'))?.status).toBe('submitted'); // applyRefund leaves it as-is, alerts instead
    // this is the alert the route exists to send when money already left for
    // the supplier - it must actually reach the alert door.
    expect(waitUntilCalls).toHaveLength(1);
    // delivery itself now runs inside waitUntil, so it must be awaited before
    // the trail write it produces can be read. The alert is recorded as DUE
    // before the route even answers, so the settled trail carries that
    // marker too, ahead of the send outcome.
    await Promise.all(waitUntilCalls);
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['refund-received', 'owner-alert-due', 'owner-alert-unconfigured']);
    expect(events[2].detail).toBe('Order #O1 was refunded GBP 12.50 (refund 777)');
  });

  // Same shape as the orders-cancelled pair above, for the refund door.
  it('an alerting refund leaves owner-alert-due in the trail before the deferred delivery promise is awaited, and its own outcome marker after', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const payload = JSON.stringify({ id: 778, order_id: 'O1', transactions: [{ kind: 'refund', amount: '12.50', currency: 'GBP' }] });
    const res = await postWebhook('/webhooks/refunds-create', payload, { topic: 'refunds/create' });
    expect(res.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
    const beforeAwait = await store.listOrderEvents('O1');
    expect(beforeAwait.map((e) => e.kind)).toEqual(['refund-received', 'owner-alert-due']);

    await Promise.all(waitUntilCalls);
    const afterAwait = await store.listOrderEvents('O1');
    expect(afterAwait.map((e) => e.kind)).toEqual(['refund-received', 'owner-alert-due', 'owner-alert-unconfigured']);
  });

  it('a malformed JSON body still answers 200', async () => {
    await seedConfig();
    const res = await postWebhook('/webhooks/refunds-create', 'not json {{{', { topic: 'refunds/create' });
    expect(res.status).toBe(200);
  });
});

// A refused owner-alert-due write must stop the route the same way a refused
// cancel-received or refund-received write does: 500, nothing handed to
// waitUntil, and a redelivery of the SAME webhook id finishes the job. Its
// own describe (with an afterEach safety net) because the spy answers false
// for only one event kind and calls through to the real implementation for
// every other - if an assertion above a missing mockRestore() ever throws,
// the spy must not leak into a later test.
describe('a refused owner-alert-due write', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function refuseDueWrites(): ReturnType<typeof vi.spyOn> {
    const original = TenantStore.prototype.addOrderEvent;
    return vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockImplementation(
      function (this: TenantStore, id: string, kind: string, detail?: string | null) {
        if (kind === 'owner-alert-due') return Promise.resolve(false);
        return original.call(this, id, kind as never, detail);
      }
    );
  }

  it('orders-cancelled: answers 500 and hands nothing to waitUntil; the same delivery id again answers 200 and the alert goes out', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'awaiting-payment', { cjOrderId: 'CJ-1' });
    const payload = JSON.stringify({ id: 'O1' });

    const spy = refuseDueWrites();
    const res1 = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-due-refused-1' });
    expect(res1.status).toBe(500);
    expect(waitUntilCalls).toHaveLength(0);
    spy.mockRestore();

    // Nothing but the (unconditional) cancel-received marker was written by
    // the failed attempt - the due write itself never landed.
    expect((await store.listOrderEvents('O1')).map((e) => e.kind)).toEqual(['cancel-received']);

    const res2 = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-due-refused-1' });
    expect(res2.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
    await Promise.all(waitUntilCalls);
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['cancel-received', 'owner-alert-due', 'owner-alert-unconfigured']);
  });

  it('refunds-create: answers 500 and hands nothing to waitUntil; the same delivery id again answers 200 and the alert goes out', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const payload = JSON.stringify({ id: 779, order_id: 'O1', transactions: [{ kind: 'refund', amount: '12.50', currency: 'GBP' }] });

    const spy = refuseDueWrites();
    const res1 = await postWebhook('/webhooks/refunds-create', payload, { topic: 'refunds/create', webhookId: 'whk-refund-due-refused-1' });
    expect(res1.status).toBe(500);
    expect(waitUntilCalls).toHaveLength(0);
    spy.mockRestore();

    expect((await store.listOrderEvents('O1')).map((e) => e.kind)).toEqual(['refund-received']);

    const res2 = await postWebhook('/webhooks/refunds-create', payload, { topic: 'refunds/create', webhookId: 'whk-refund-due-refused-1' });
    expect(res2.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
    await Promise.all(waitUntilCalls);
    const events = await store.listOrderEvents('O1');
    expect(events.map((e) => e.kind)).toEqual(['refund-received', 'owner-alert-due', 'owner-alert-unconfigured']);
  });
});

describe('POST /webhooks/orders-paid (HTTP level)', () => {
  const ORDERS_PAID_PAYLOAD = {
    id: 999001,
    name: '#1001',
    total_price: '25.00',
    currency: 'GBP',
    financial_status: 'paid',
    shipping_address: { name: 'A B', address1: '1 St', city: 'London', zip: 'E1 1AA', country_code: 'GB' },
    line_items: []
  };

  it('a valid body writes received then queued', async () => {
    const store = await seedConfig();
    const res = await postWebhook('/webhooks/orders-paid', JSON.stringify(ORDERS_PAID_PAYLOAD), { topic: 'orders/paid' });
    expect(res.status).toBe(200);
    const order = await store.getOrder('999001');
    expect(order?.status).toBe('queued');
    const events = await store.listOrderEvents('999001');
    expect(events.map((e) => e.kind)).toEqual(['received', 'queued']);
    expect(events[1].detail).toMatch(/^fulfil after /);
  });

  it('a hold writes received then held with the hold reasons joined by a comma', async () => {
    const store = await seedConfig(); // a config is required for the route to proceed past its config check
    const payload = { ...ORDERS_PAID_PAYLOAD, id: 999002, name: '#1002', shipping_address: null }; // incomplete-address hold
    const res = await postWebhook('/webhooks/orders-paid', JSON.stringify(payload), { topic: 'orders/paid' });
    expect(res.status).toBe(200);
    const events = await store.listOrderEvents('999002');
    expect(events.map((e) => e.kind)).toEqual(['received', 'held']);
    expect(events[1].detail).toBe('incomplete-address');
  });

  it('a malformed JSON body still answers 200', async () => {
    await seedConfig();
    const res = await postWebhook('/webhooks/orders-paid', 'not json {{{', { topic: 'orders/paid' });
    expect(res.status).toBe(200);
  });
});

// Before this, all three routes answered 200 even when their own processing
// threw, so Shopify never redelivered and a database blip lost a paid order,
// a cancel or a refund for good. These force a genuine throw with vi.spyOn on
// the TenantStore prototype and check the app under test actually took the
// stubbed rejection (asserting the 500) rather than assuming it did; every
// spy is restored, most in afterEach as a backstop.
describe('order webhook routes answer for a retry when processing throws', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('orders-cancelled: a valid cancel whose processing throws answers 500, and the same delivery id sent again, now succeeding, answers 200 with one cancel-received event', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'queued');
    const payload = JSON.stringify({ id: 'O1' });

    const spy = vi.spyOn(TenantStore.prototype, 'getOrder').mockRejectedValueOnce(new Error('D1 is down'));
    const res1 = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-retry-1' });
    expect(res1.status).toBe(500);
    expect(spy).toHaveBeenCalled(); // confirms the stub really ran inside the app under test
    spy.mockRestore();

    // Nothing was written by the throwing attempt.
    expect((await store.getOrder('O1'))?.status).toBe('queued');
    expect(await store.listOrderEvents('O1')).toEqual([]);

    const res2 = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-retry-1' });
    expect(res2.status).toBe(200);
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'cancel-received')).toHaveLength(1);
  });

  it('orders-cancelled: a refused cancel-received write answers 500, and the same delivery id sent again, now succeeding, answers 200 with one cancel-received event', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'queued');
    const payload = JSON.stringify({ id: 'O1' });

    const spy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockResolvedValueOnce(false);
    const res1 = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-marker-refused-1' });
    expect(res1.status).toBe(500);
    expect(spy).toHaveBeenCalled(); // confirms the stub really ran inside the app under test
    spy.mockRestore();

    // Nothing was written by the throwing attempt.
    expect((await store.getOrder('O1'))?.status).toBe('queued');
    expect(await store.listOrderEvents('O1')).toEqual([]);

    const res2 = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-marker-refused-1' });
    expect(res2.status).toBe(200);
    expect((await store.getOrder('O1'))?.status).toBe('cancelled');
    const events = await store.listOrderEvents('O1');
    expect(events.filter((e) => e.kind === 'cancel-received')).toHaveLength(1);
  });

  it('orders-cancelled: five failures of one delivery id answer 500, 500, 500, 200, 200, and the give-up alert reaches waitUntil exactly once, on the 4th, not before and not again on the 5th', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'queued');
    const payload = JSON.stringify({ id: 'O1' });
    const spy = vi.spyOn(TenantStore.prototype, 'getOrder').mockRejectedValue(new Error('D1 is down'));

    const statuses: number[] = [];
    const waitUntilCountAfterEach: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-retry-4' });
      statuses.push(res.status);
      waitUntilCountAfterEach.push(waitUntilCalls.length);
    }
    expect(statuses).toEqual([500, 500, 500, 200, 200]);
    expect(waitUntilCountAfterEach).toEqual([0, 0, 0, 1, 1]);
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('refunds-create: a valid refund whose processing throws answers 500 (the same first-failure contract as orders-cancelled)', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'submitted', { cjOrderId: 'CJ-1' });
    const payload = JSON.stringify({ id: 900, order_id: 'O1', transactions: [{ kind: 'refund', amount: '9.00', currency: 'GBP' }] });

    const spy = vi.spyOn(TenantStore.prototype, 'getOrder').mockRejectedValueOnce(new Error('D1 is down'));
    const res = await postWebhook('/webhooks/refunds-create', payload, { topic: 'refunds/create', webhookId: 'whk-retry-2' });
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalled();
  });

  // orders-paid's own processing never calls TenantStore.getOrder (it inserts
  // a NEW row rather than reading an existing one), so getOrder is not a spy
  // target here - insertOrderIfNew is stubbed instead, an honest throw inside
  // this route's own real processing path.
  it('orders-paid: a valid body whose processing throws answers 500', async () => {
    await seedConfig();
    const payload = {
      id: 999003, name: '#1003', total_price: '25.00', currency: 'GBP', financial_status: 'paid',
      shipping_address: { name: 'A B', address1: '1 St', city: 'London', zip: 'E1 1AA', country_code: 'GB' },
      line_items: []
    };
    const spy = vi.spyOn(TenantStore.prototype, 'insertOrderIfNew').mockRejectedValueOnce(new Error('D1 is down'));
    const res = await postWebhook('/webhooks/orders-paid', JSON.stringify(payload), { topic: 'orders/paid', webhookId: 'whk-retry-3' });
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalled();
  });

  it('a bad signature still answers 401 and counts nothing (no whfail cache row is created)', async () => {
    const store = await seedConfig();
    const res = await postWebhook('/webhooks/orders-cancelled', JSON.stringify({ id: 'O1' }), {
      topic: 'orders/cancelled', badSignature: true, webhookId: 'whk-bad-sig'
    });
    expect(res.status).toBe(401);
    expect(await store.getSearchCache('whfail:whk-bad-sig')).toBeNull();
  });

  // A config read that throws every time is the one case where the give-up
  // alert has nowhere to go: there is no config to read an alert address
  // from. The route must still stop asking for a retry at the same count,
  // and it must say so loudly in the logs, because that log line is the
  // owner's only remaining signal that the event was dropped.
  it('a config read that keeps failing logs the abandonment exactly once and hands nothing to waitUntil', async () => {
    await seedConfig();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(TenantStore.prototype, 'getConfig').mockRejectedValue(new Error('D1 is down'));
    const payload = JSON.stringify({ id: 'O1' });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-giveup-1' });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([500, 500, 500, 200]);
    expect(waitUntilCalls).toHaveLength(0);

    const abandonCalls = errorSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.toLowerCase().includes('abandoned')
    );
    expect(abandonCalls).toHaveLength(1);
    expect(abandonCalls[0][0]).toContain('orders/cancelled');
    expect(abandonCalls[0][0]).toContain('(unknown)'); // no order id was ever resolved - the config read failed first
    errorSpy.mockRestore();
  });

  // The give-up delivery's OWN config read can fail while a second, later read
  // succeeds (a blip that has already cleared by the time the route tries
  // again) - that must still reach the owner, not be treated as no-config.
  it('a config read that fails only on the give-up delivery itself, and succeeds on a second try, still sends the alert', async () => {
    const store = await seedConfig();
    await seedOrder(store, 'O1', 'queued');
    const payload = JSON.stringify({ id: 'O1' });

    // Bring this delivery id to 3 failures for a reason unrelated to config.
    const getOrderSpy = vi.spyOn(TenantStore.prototype, 'getOrder').mockRejectedValue(new Error('D1 is down'));
    for (let i = 0; i < 3; i++) {
      const res = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-giveup-2' });
      expect(res.status).toBe(500);
    }
    getOrderSpy.mockRestore();

    // The 4th delivery: the route's own config read fails once; the retry
    // inside the failure handler is a separate call, unmocked, so it succeeds
    // against the real, seeded config.
    const cfgSpy = vi.spyOn(TenantStore.prototype, 'getConfig').mockRejectedValueOnce(new Error('D1 is down'));
    const res4 = await postWebhook('/webhooks/orders-cancelled', payload, { topic: 'orders/cancelled', webhookId: 'whk-giveup-2' });
    expect(res4.status).toBe(200);
    expect(waitUntilCalls).toHaveLength(1);
    cfgSpy.mockRestore();
  });

  // orders-paid gates its trail writes on the insert being new, so a throw
  // right after a successful insert used to lose the "received"/"queued"
  // trail for good: the redelivery finds the row already there and writes
  // nothing. addOrderEvent swallows its own D1 errors internally, but
  // vi.spyOn replaces the whole method for the call it targets, bypassing
  // that internal try/catch entirely, so mocking it here IS an honest throw
  // reaching the route's own try/catch, confirmed below by the 500 and by
  // the spy call count.
  it('orders-paid: a throw right after a successful insert leaves an empty trail, and a redelivery heals it to received, queued, with a third delivery adding nothing more', async () => {
    const store = await seedConfig();
    const payload = {
      id: 999010, name: '#1010', total_price: '25.00', currency: 'GBP', financial_status: 'paid',
      shipping_address: { name: 'A B', address1: '1 St', city: 'London', zip: 'E1 1AA', country_code: 'GB' },
      line_items: []
    };

    const spy = vi.spyOn(TenantStore.prototype, 'addOrderEvent').mockRejectedValueOnce(new Error('D1 is down'));
    const res1 = await postWebhook('/webhooks/orders-paid', JSON.stringify(payload), { topic: 'orders/paid', webhookId: 'whk-imp5' });
    expect(res1.status).toBe(500);
    expect(spy).toHaveBeenCalled(); // confirms the stub really ran inside the app under test
    spy.mockRestore();

    const orderAfterThrow = await store.getOrder('999010');
    expect(orderAfterThrow?.status).toBe('queued'); // the insert itself succeeded
    expect(await store.listOrderEvents('999010')).toEqual([]); // but nothing was written to the trail

    const res2 = await postWebhook('/webhooks/orders-paid', JSON.stringify(payload), { topic: 'orders/paid', webhookId: 'whk-imp5' });
    expect(res2.status).toBe(200);
    const eventsAfterHeal = await store.listOrderEvents('999010');
    expect(eventsAfterHeal.map((e) => e.kind)).toEqual(['received', 'queued']);

    const res3 = await postWebhook('/webhooks/orders-paid', JSON.stringify(payload), { topic: 'orders/paid', webhookId: 'whk-imp5' });
    expect(res3.status).toBe(200);
    const eventsAfterThirdDelivery = await store.listOrderEvents('999010');
    expect(eventsAfterThirdDelivery.map((e) => e.kind)).toEqual(['received', 'queued']); // unchanged, no duplicate
  });

  // The healing branch reads hold_reasons back with JSON.parse, which only
  // guards against a SYNTAX error - a value that parses cleanly to something
  // other than an array (here, a JSON string) must still produce a usable
  // detail rather than crash the consuming .join call.
  it('orders-paid: a held row whose stored hold_reasons is not an array heals to received, held with an empty detail rather than a deterministic 500', async () => {
    const store = await seedConfig();
    const payload = {
      id: 999011, name: '#1011', total_price: '25.00', currency: 'GBP', financial_status: 'paid',
      shipping_address: { name: 'A B', address1: '1 St', city: 'London', zip: 'E1 1AA', country_code: 'GB' },
      line_items: []
    };
    await store.insertOrderIfNew({
      shopifyOrderId: '999011', orderName: '#1011', totalPrice: 25, currency: 'GBP', financialStatus: 'paid', riskLevel: null,
      status: 'held', holdReasons: ['incomplete-address'], addressJson: null, lineItemsJson: null, fulfilAfter: null
    });
    // Overwrite with a value that parses cleanly but is not an array - the
    // shape a corrupt out-of-band write could leave behind.
    await store.updateOrder('999011', { hold_reasons: '"oops"' });
    expect(await store.listOrderEvents('999011')).toEqual([]);

    const res = await postWebhook('/webhooks/orders-paid', JSON.stringify(payload), { topic: 'orders/paid', webhookId: 'whk-new1' });
    expect(res.status).toBe(200);
    const events = await store.listOrderEvents('999011');
    expect(events.map((e) => e.kind)).toEqual(['received', 'held']);
    expect(events[1].detail).toBe('');
  });

  // A queued row's fulfil_after can be null (any writer that never set it);
  // the healed detail must not literally read "fulfil after null".
  it('orders-paid: a queued row whose fulfil_after is null heals to queued with no detail', async () => {
    const store = await seedConfig();
    const payload = {
      id: 999012, name: '#1012', total_price: '25.00', currency: 'GBP', financial_status: 'paid',
      shipping_address: { name: 'A B', address1: '1 St', city: 'London', zip: 'E1 1AA', country_code: 'GB' },
      line_items: []
    };
    await store.insertOrderIfNew({
      shopifyOrderId: '999012', orderName: '#1012', totalPrice: 25, currency: 'GBP', financialStatus: 'paid', riskLevel: null,
      status: 'queued', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null
    });
    expect(await store.listOrderEvents('999012')).toEqual([]);

    const res = await postWebhook('/webhooks/orders-paid', JSON.stringify(payload), { topic: 'orders/paid', webhookId: 'whk-new3' });
    expect(res.status).toBe(200);
    const events = await store.listOrderEvents('999012');
    expect(events.map((e) => e.kind)).toEqual(['received', 'queued']);
    expect(events[1].detail).toBeNull();
  });
});

// Two shops, each holding an order with the SAME order id and its own
// trail. A correctly signed delivery for one shop must leave the other's
// row and trail byte for byte as they were.
describe('tenant isolation', () => {
  const SHOP_B = 'b.myshopify.com';

  it('(a) a correctly signed cancel for shop A leaves shop B\'s same-id row and trail untouched', async () => {
    const storeA = await seedConfig();
    const storeB = new TenantStore(env.DB, SHOP_B);
    await storeB.seedConfig(MIN_CFG);
    await seedOrder(storeA, 'O1', 'queued');
    await seedOrder(storeB, 'O1', 'queued');
    const bBefore = await storeB.getOrder('O1');

    // No shop header override needed: postWebhook always signs for SHOP (A).
    const res = await postWebhook('/webhooks/orders-cancelled', JSON.stringify({ id: 'O1' }), { topic: 'orders/cancelled' });
    expect(res.status).toBe(200);
    expect((await storeA.getOrder('O1'))?.status).toBe('cancelled');

    const bAfter = await storeB.getOrder('O1');
    expect(bAfter).toEqual(bBefore); // byte for byte: shop B's row is untouched
    expect(bAfter?.status).toBe('queued');
    expect(await storeB.listOrderEvents('O1')).toEqual([]);
  });

  it('(b) same for a refund', async () => {
    const storeA = await seedConfig();
    const storeB = new TenantStore(env.DB, SHOP_B);
    await storeB.seedConfig(MIN_CFG);
    await seedOrder(storeA, 'O1', 'submitted', { cjOrderId: 'CJ-A' });
    await seedOrder(storeB, 'O1', 'submitted', { cjOrderId: 'CJ-B' });
    const bBefore = await storeB.getOrder('O1');

    const payload = JSON.stringify({ id: 900, order_id: 'O1', transactions: [{ kind: 'refund', amount: '9.00', currency: 'GBP' }] });
    const res = await postWebhook('/webhooks/refunds-create', payload, { topic: 'refunds/create' });
    expect(res.status).toBe(200);
    // delivery itself now runs inside waitUntil, so it must be awaited before
    // the trail write it produces can be read.
    await Promise.all(waitUntilCalls);
    const eventsA = await storeA.listOrderEvents('O1');
    expect(eventsA.map((e) => e.kind)).toEqual(['refund-received', 'owner-alert-due', 'owner-alert-unconfigured']);

    const bAfter = await storeB.getOrder('O1');
    expect(bAfter).toEqual(bBefore); // byte for byte: shop B's row is untouched
    expect(await storeB.listOrderEvents('O1')).toEqual([]);
  });

  // (c) /api/order-events is session-token authed, not HMAC-webhook authed, and
  // this repo has NO established way to drive a session-token route through
  // app.request: shopOf() hardcodes the real shopify.session.decodeSessionToken,
  // which only accepts a token signed by @shopify/shopify-api's own internal
  // (undocumented, private) scheme - there is no supported way to mint one from
  // a test. Confirmed by the repo's own convention, stated explicitly in
  // tests/affiliate-console.test.ts's file comment ("no test drives a
  // session-token-authed /api route through app.request... tested as plain
  // functions, with the Hono route left as a thin wrapper") and by
  // tests/session.test.ts, the only test of resolveShopFromToken, which
  // injects a fake decode function rather than a real signed token. A
  // session-authed HTTP request truly cannot be built in this test file
  // without reimplementing that library's private signing internals.
  //
  // orderEventsForOrder was extracted from the route for exactly this reason:
  // the route ALWAYS builds its store from the session-resolved shop, never
  // from the request body, so calling orderEventsForOrder with two different
  // shops' stores exercises the identical isolation property one call below
  // the HTTP boundary.
  it('(c) orderEventsForOrder never returns one shop\'s events for another shop\'s store', async () => {
    const storeA = new TenantStore(env.DB, SHOP);
    const storeB = new TenantStore(env.DB, SHOP_B);
    await seedOrder(storeA, 'O1', 'queued');
    await storeA.addOrderEvent('O1', 'operator-action', 'hold');

    const forA = await orderEventsForOrder(storeA, 'O1');
    expect(forA.status).toBe(200);
    expect(forA.body.ok).toBe(true);
    if (forA.body.ok) expect(forA.body.events.map((e) => e.kind)).toEqual(['operator-action']);

    // O1 exists only under shop A; shop B asking for the SAME id must get 404,
    // never shop A's events - shop B never seeded a row for it.
    const forB = await orderEventsForOrder(storeB, 'O1');
    expect(forB).toEqual({ status: 404, body: { ok: false, error: 'Order not found' } });
  });
});

// orderEventsForOrder is /api/order-events's whole logic (the Hono handler
// is a thin wrapper - see its doc comment), so this is the direct test for
// the route's validation and not-found behaviour.
describe('orderEventsForOrder', () => {
  it('a missing, non-string or empty id answers 400 { ok: false, error: "Missing order id" }', async () => {
    const store = new TenantStore(env.DB, SHOP);
    expect(await orderEventsForOrder(store, undefined)).toEqual({ status: 400, body: { ok: false, error: 'Missing order id' } });
    expect(await orderEventsForOrder(store, 42)).toEqual({ status: 400, body: { ok: false, error: 'Missing order id' } });
    expect(await orderEventsForOrder(store, '')).toEqual({ status: 400, body: { ok: false, error: 'Missing order id' } });
  });

  it('a well-formed id with no row answers 404 { ok: false, error: "Order not found" }', async () => {
    const store = new TenantStore(env.DB, SHOP);
    expect(await orderEventsForOrder(store, 'GHOST')).toEqual({ status: 404, body: { ok: false, error: 'Order not found' } });
  });
});

// /api/orders trusts a stored order-webhooks payload only after checking
// its shape. parseStoredHooks holds that check.
describe('parseStoredHooks', () => {
  it('null, unparseable JSON, and a parseable payload of the wrong shape all give null', () => {
    expect(parseStoredHooks(null)).toBeNull();
    expect(parseStoredHooks('not json {{{')).toBeNull();
    // A shape with no `verified` field at all.
    expect(parseStoredHooks(JSON.stringify({ ok: true, missing: [], checkedAt: 'x' }))).toBeNull();
    expect(parseStoredHooks(JSON.stringify({ ok: true, verified: true, missing: 'not-an-array', checkedAt: 'x' }))).toBeNull();
    expect(parseStoredHooks(JSON.stringify({ ok: true, verified: true, missing: [], checkedAt: 123 }))).toBeNull();
  });

  it('a verified value passes ok and missing through unchanged, with a null error', () => {
    const raw = JSON.stringify({ ok: false, verified: true, missing: ['ORDERS_CANCELLED'], checkedAt: '2026-09-19T00:00:00.000Z', errors: [] });
    expect(parseStoredHooks(raw)).toEqual({ ok: false, missing: ['ORDERS_CANCELLED'], checkedAt: '2026-09-19T00:00:00.000Z', error: null });
  });

  it('an unverified value reports ok false, an EMPTY missing (unknown is not missing), and the first stored error', () => {
    const raw = JSON.stringify({ ok: false, verified: false, missing: ['ORDERS_PAID', 'ORDERS_CANCELLED'], checkedAt: '2026-09-19T00:00:00.000Z', errors: ['network down'] });
    expect(parseStoredHooks(raw)).toEqual({ ok: false, missing: [], checkedAt: '2026-09-19T00:00:00.000Z', error: 'network down' });
  });

  it('an unverified value with no stored errors falls back to "check failed"', () => {
    const raw = JSON.stringify({ ok: false, verified: false, missing: ['ORDERS_PAID'], checkedAt: '2026-09-19T00:00:00.000Z', errors: [] });
    expect(parseStoredHooks(raw)).toEqual({ ok: false, missing: [], checkedAt: '2026-09-19T00:00:00.000Z', error: 'check failed' });
  });
});

// Before this, /api/ensure-webhooks answered the raw WebhookStatus while
// /api/orders answered parseStoredHooks's projection, so pressing "Check
// order events" during an outage still printed the console's confident
// MISSING line the page-load path had removed. Both routes now share one
// projection function.
//
// /api/ensure-webhooks is session-token authed like /api/order-events, so
// the same limitation documented at length in the tenant isolation describe
// above applies: this repo has no established way to drive its FULL body
// (ensureWebhooks's own outbound Admin GraphQL calls included) through
// app.request without either minting a real session token AND seeding a
// genuinely vault-wrapped access token AND stubbing global fetch for the
// Shopify Admin endpoint - a materially bigger rig than justified for a
// route whose OWN new logic, after ensureWebhooks returns, is two lines
// (manualCheckConsecutiveFailures below, and
// `c.json({ ok: true, hooks: projectHooks(hooks) })`). So this tests
// projectHooks directly; the route's use of it is confirmed by reading
// src/index.ts's /api/ensure-webhooks handler, which calls
// `projectHooks(hooks)` on the FRESH status with no other transformation
// before it goes into the response.
//
// (Worth recording since it revises an earlier claim in this file: a
// session-authed route CAN be driven through app.request with a genuinely
// minted token when a tenant is seeded - tests/traffic-quality.test.ts and
// the "answers" routes in tests/inbox-routes.test.ts both do this with a
// real SignJWT HS256 token over SHOPIFY_API_SECRET. What remains true for
// THIS route is narrower: reaching the projectHooks call specifically also
// requires a working Admin client, which those two examples do not need.)
describe('projectHooks', () => {
  const CHECKED_AT = '2026-09-19T00:00:00.000Z';

  it('a first-list failure (unverified, all four topics listed missing) projects to ok: false, an EMPTY missing, and the stored error - the button route must not repeat the confident MISSING list the page-load path removed', () => {
    const status = {
      verified: false,
      missing: ['APP_UNINSTALLED', 'ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'],
      errors: ['network down'],
      checkedAt: CHECKED_AT
    };
    expect(projectHooks(status)).toEqual({ ok: false, missing: [], checkedAt: CHECKED_AT, error: 'network down' });
  });

  it('a verified status missing only APP_UNINSTALLED projects to ok: true, missing: [] - an unrelated topic must not print "a cancel or refund can go unnoticed"', () => {
    const status = { verified: true, missing: ['APP_UNINSTALLED'], errors: [], checkedAt: CHECKED_AT };
    expect(projectHooks(status)).toEqual({ ok: true, missing: [], checkedAt: CHECKED_AT, error: null });
  });

  it("a verified status missing ORDERS_CANCELLED and APP_UNINSTALLED projects to missing: ['ORDERS_CANCELLED']", () => {
    const status = { verified: true, missing: ['ORDERS_CANCELLED', 'APP_UNINSTALLED'], errors: [], checkedAt: CHECKED_AT };
    expect(projectHooks(status)).toEqual({ ok: false, missing: ['ORDERS_CANCELLED'], checkedAt: CHECKED_AT, error: null });
  });

  it('both routes give the identical projection for the same stored status: projectHooks on the fresh status (the button route) equals parseStoredHooks once that same status is stored (the page-load route)', () => {
    const status = { ok: false, verified: true, missing: ['ORDERS_CANCELLED', 'APP_UNINSTALLED'], errors: [], checkedAt: CHECKED_AT };
    const buttonProjection = projectHooks(status);
    const ordersProjection = parseStoredHooks(JSON.stringify(status));
    expect(buttonProjection).toEqual(ordersProjection);
    expect(buttonProjection).toEqual({ ok: false, missing: ['ORDERS_CANCELLED'], checkedAt: CHECKED_AT, error: null });
  });
});

// A failed manual check must not inflate the counter the nightly alert
// calls "days in a row" - a button press is not a night. Only a successful
// manual check may change it, resetting it to 0 like the nightly stage does.
describe('manualCheckConsecutiveFailures', () => {
  it('a failed press leaves a previously stored 2 unchanged', () => {
    const previousRaw = JSON.stringify({ consecutiveFailures: 2 });
    expect(manualCheckConsecutiveFailures(previousRaw, false)).toBe(2);
  });

  it('a successful press resets a previously stored 2 to 0', () => {
    const previousRaw = JSON.stringify({ consecutiveFailures: 2 });
    expect(manualCheckConsecutiveFailures(previousRaw, true)).toBe(0);
  });

  it('no previous value defaults to 0 on a failed press (never invents a first failed night)', () => {
    expect(manualCheckConsecutiveFailures(null, false)).toBe(0);
  });
});

// An unauthenticated request must never reach any of these three routes'
// logic. Passes today; exists to catch a future regression that removes the
// session gate. Proven able to fail: one gate was temporarily commented
// out, observed red, then restored.
describe('unauthenticated POST answers 401 on every session-authed order route', () => {
  const ROUTES = ['/api/orders', '/api/order-events', '/api/ensure-webhooks'];
  for (const path of ROUTES) {
    it(`POST ${path} with no Authorization header answers 401`, async () => {
      const res = await app.request(`${APP_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }, webhookEnv(), FAKE_CTX);
      expect(res.status).toBe(401);
    });
  }
});

// The session-authed order routes (/api/order-events, /api/orders), driven
// through the real Hono app with a genuinely minted session token - the
// same pattern tests/traffic-quality.test.ts and tests/inbox-routes.test.ts
// already use (SignJWT, HS256, over SHOPIFY_API_SECRET, aud =
// SHOPIFY_API_KEY, dest = the shop). This app is installed on many shops
// with no data bleed between them; the one thing the earlier substitution
// above (orderEventsForOrder called directly with two shops' stores) cannot
// catch is a route that one day starts taking the shop from the REQUEST
// BODY instead of the session - these tests drive the full route, session
// included, to close exactly that gap.
//
// Neither /api/order-events nor /api/orders calls adminForShop, so - unlike
// /api/ensure-webhooks - an opaque, non-decryptable placeholder access token
// is enough to satisfy ensureInstalled's "already installed" short-circuit
// (src/auth/ensure-installed.ts: a tenant row with any non-empty
// access_token_enc returns immediately, no real token exchange or Admin call
// needed). This is the same seeding tests/traffic-quality.test.ts uses for
// its own HTTP-level not_connected test.
describe('session-authed HTTP isolation', () => {
  const SESSION_SHOP_A = 'session-a.myshopify.com';
  const SESSION_SHOP_B = 'session-b.myshopify.com';
  const SESSION_SECRET = 'test-session-round3-secret';

  async function sessionBearer(shop: string): Promise<string> {
    const key = new TextEncoder().encode(SESSION_SECRET);
    return new SignJWT({ dest: `https://${shop}`, sub: '1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience((env as unknown as Env).SHOPIFY_API_KEY)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  }

  function sessionEnv(): Env {
    return { ...env, SHOPIFY_API_SECRET: SESSION_SECRET } as unknown as Env;
  }

  async function seedInstalledTenant(shop: string): Promise<TenantStore> {
    const store = new TenantStore(env.DB, shop);
    await store.upsertTenant({ accessTokenEnc: `tok-${shop}`, dekWrapped: 'd', scopes: 's' });
    return store;
  }

  it("POST /api/order-events with shop A's session token and { id } answers 200 with shop A's events only - none of shop B's event detail appears anywhere in the body", async () => {
    const storeA = await seedInstalledTenant(SESSION_SHOP_A);
    const storeB = await seedInstalledTenant(SESSION_SHOP_B);
    await seedOrder(storeA, 'O1', 'queued');
    await seedOrder(storeB, 'O1', 'queued');
    await storeA.addOrderEvent('O1', 'operator-action', 'shop-A-only-detail');
    await storeB.addOrderEvent('O1', 'operator-action', 'shop-B-only-detail');

    const res = await app.request('/api/order-events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await sessionBearer(SESSION_SHOP_A)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'O1' }),
    }, sessionEnv(), FAKE_CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; events: { seq: number; at: string; kind: string; detail: string | null }[] };
    expect(body.ok).toBe(true);
    expect(body.events.map((e) => e.detail)).toEqual(['shop-A-only-detail']);
    expect(JSON.stringify(body)).not.toContain('shop-B-only-detail');
  });

  it("an extra body field naming shop B ('shop' or 'shopDomain') still answers shop A's events only - the shop comes from the session, never the body", async () => {
    const storeA = await seedInstalledTenant(SESSION_SHOP_A);
    const storeB = await seedInstalledTenant(SESSION_SHOP_B);
    await seedOrder(storeA, 'O1', 'queued');
    await seedOrder(storeB, 'O1', 'queued');
    await storeA.addOrderEvent('O1', 'operator-action', 'shop-A-only-detail');
    await storeB.addOrderEvent('O1', 'operator-action', 'shop-B-only-detail');

    for (const extraBody of [{ shop: SESSION_SHOP_B }, { shopDomain: SESSION_SHOP_B }]) {
      const res = await app.request('/api/order-events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await sessionBearer(SESSION_SHOP_A)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'O1', ...extraBody }),
      }, sessionEnv(), FAKE_CTX);
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: true; events: { seq: number; at: string; kind: string; detail: string | null }[] };
      expect(body.events.map((e) => e.detail)).toEqual(['shop-A-only-detail']);
      expect(JSON.stringify(body)).not.toContain('shop-B-only-detail');
    }
  });

  it("POST /api/orders with shop A's session token returns hooks derived from shop A's stored status, not shop B's", async () => {
    const storeA = await seedInstalledTenant(SESSION_SHOP_A);
    const storeB = await seedInstalledTenant(SESSION_SHOP_B);
    const CHECKED_AT = '2026-09-19T00:00:00.000Z';
    const verifiedAllPresentForA = {
      ok: true, verified: true, present: REQUIRED_TOPICS.map((t) => t.topic), created: [], missing: [], errors: [], checkedAt: CHECKED_AT
    };
    const unverifiedForB = {
      ok: false, verified: false, present: [], created: [], missing: REQUIRED_TOPICS.map((t) => t.topic), errors: ['network down'], checkedAt: CHECKED_AT
    };
    await storeA.putSearchCache(JOB_STAMP_ORDER_HOOKS, JSON.stringify(verifiedAllPresentForA), JOB_STAMP_TTL_DAYS);
    await storeB.putSearchCache(JOB_STAMP_ORDER_HOOKS, JSON.stringify(unverifiedForB), JOB_STAMP_TTL_DAYS);

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await sessionBearer(SESSION_SHOP_A)}`, 'Content-Type': 'application/json' },
      body: '{}',
    }, sessionEnv(), FAKE_CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; hooks: { ok: boolean; missing: string[]; checkedAt: string; error: string | null } | null };
    expect(body.hooks).toEqual({ ok: true, missing: [], checkedAt: CHECKED_AT, error: null });
  });

  // Every writer stores an array, so only a hand edit of the database puts
  // anything else in this column - but the console joins whatever comes back,
  // and one unreadable value used to take the whole orders card down with it.
  it('POST /api/orders with one unreadable hold_reasons value still answers every order, that one with no reasons', async () => {
    const storeA = await seedInstalledTenant(SESSION_SHOP_A);
    await seedOrder(storeA, 'GOOD', 'held');
    await seedOrder(storeA, 'BAD', 'held');
    await storeA.updateOrder('GOOD', { hold_reasons: JSON.stringify(['not-paid']) });
    await storeA.updateOrder('BAD', { hold_reasons: 'not json {{{' });

    const res = await app.request('/api/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await sessionBearer(SESSION_SHOP_A)}`, 'Content-Type': 'application/json' },
      body: '{}',
    }, sessionEnv(), FAKE_CTX);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: true; orders: { id: string; holds: string[] }[] };
    expect(body.orders).toHaveLength(2);
    expect(body.orders.find((o) => o.id === 'GOOD')?.holds).toEqual(['not-paid']);
    expect(body.orders.find((o) => o.id === 'BAD')?.holds).toEqual([]);
  });
});
