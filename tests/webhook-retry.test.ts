/// <reference types="@cloudflare/vitest-pool-workers" />
// onWebhookFailure counts failed processing attempts per Shopify delivery
// (X-Shopify-Webhook-Id) and decides whether the route should still ask
// Shopify to retry. Most of these use the real D1-backed TenantStore
// (getSearchCache/putSearchCache), since the whole point is a durable
// per-delivery counter; the two rejection tests use a plain stand-in that
// only implements the two methods onWebhookFailure needs.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { onWebhookFailure, MAX_WEBHOOK_FAILURES } from '../src/webhook-retry';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';

describe('onWebhookFailure', () => {
  it('calls 1, 2 and 3 for one webhookId answer 500 with no alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (let i = 1; i <= MAX_WEBHOOK_FAILURES; i++) {
      const r = await onWebhookFailure(store, { webhookId: 'whk-123', topic: 'orders/cancelled', orderId: 'O1' });
      expect(r).toEqual({ status: 500, alert: null });
    }
  });

  it('call 4 answers 200 with the exact subject and text', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (let i = 1; i <= MAX_WEBHOOK_FAILURES; i++) {
      await onWebhookFailure(store, { webhookId: 'whk-124', topic: 'orders/cancelled', orderId: 'O1' });
    }
    const r = await onWebhookFailure(store, { webhookId: 'whk-124', topic: 'orders/cancelled', orderId: 'O1' });
    expect(r).toEqual({
      status: 200,
      alert: {
        subject: 'An order event from Shopify could not be processed',
        text: 'PawScout failed 4 times to process a Shopify orders/cancelled event (order O1). It has stopped asking Shopify to resend it, because repeated failures make Shopify remove the subscription. Check this order in Shopify and in the PawScout console.'
      }
    });
  });

  it('call 5 answers 200 with no alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (let i = 1; i <= MAX_WEBHOOK_FAILURES + 1; i++) {
      await onWebhookFailure(store, { webhookId: 'whk-125', topic: 'orders/cancelled', orderId: 'O1' });
    }
    const r = await onWebhookFailure(store, { webhookId: 'whk-125', topic: 'orders/cancelled', orderId: 'O1' });
    expect(r).toEqual({ status: 200, alert: null });
  });

  it('a different webhookId counts separately from 1', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await onWebhookFailure(store, { webhookId: 'whk-a', topic: 'orders/cancelled', orderId: 'O1' });
    await onWebhookFailure(store, { webhookId: 'whk-a', topic: 'orders/cancelled', orderId: 'O1' });
    await onWebhookFailure(store, { webhookId: 'whk-a', topic: 'orders/cancelled', orderId: 'O1' });
    // whk-a is already at 3; a fresh id must start at 1, not continue whk-a's count.
    const r = await onWebhookFailure(store, { webhookId: 'whk-b', topic: 'orders/cancelled', orderId: 'O1' });
    expect(r).toEqual({ status: 500, alert: null });
  });

  it('a null webhookId answers 500 with no alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await onWebhookFailure(store, { webhookId: null, topic: 'orders/cancelled', orderId: 'O1' });
    expect(r).toEqual({ status: 500, alert: null });
  });

  it('an empty webhookId answers 500 with no alert', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await onWebhookFailure(store, { webhookId: '', topic: 'orders/cancelled', orderId: 'O1' });
    expect(r).toEqual({ status: 500, alert: null });
  });

  it('a store whose getSearchCache rejects answers 500 and does not throw', async () => {
    const store = {
      getSearchCache: async () => { throw new Error('D1 is down'); },
      putSearchCache: async () => undefined
    };
    await expect(
      onWebhookFailure(store, { webhookId: 'whk-200', topic: 'orders/cancelled', orderId: 'O1' })
    ).resolves.toEqual({ status: 500, alert: null });
  });

  it('a store whose putSearchCache rejects answers 500 and does not throw', async () => {
    const store = {
      getSearchCache: async () => null,
      putSearchCache: async () => { throw new Error('D1 is down'); }
    };
    await expect(
      onWebhookFailure(store, { webhookId: 'whk-201', topic: 'orders/cancelled', orderId: 'O1' })
    ).resolves.toEqual({ status: 500, alert: null });
  });

  it('an empty orderId prints (unknown) in the alert text', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (let i = 1; i <= MAX_WEBHOOK_FAILURES; i++) {
      await onWebhookFailure(store, { webhookId: 'whk-300', topic: 'refunds/create', orderId: '' });
    }
    const r = await onWebhookFailure(store, { webhookId: 'whk-300', topic: 'refunds/create', orderId: '' });
    expect(r.alert?.text).toBe(
      'PawScout failed 4 times to process a Shopify refunds/create event (order (unknown)). It has stopped asking Shopify to resend it, because repeated failures make Shopify remove the subscription. Check this order in Shopify and in the PawScout console.'
    );
  });
});
