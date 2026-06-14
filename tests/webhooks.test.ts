import { describe, it, expect } from 'vitest';
import { registerWebhookTopic, registerWebhooks } from '../src/webhooks';

const APP_URL = 'https://pawscout.example.com';

function graphqlResponse(userErrors: { message: string }[]): Response {
  return new Response(
    JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors, webhookSubscription: { id: 'gid://1' } } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('registerWebhookTopic', () => {
  it('posts the mutation to the shop with the offline token and succeeds', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), init };
      return graphqlResponse([]);
    }) as typeof fetch;

    const r = await registerWebhookTopic('a.myshopify.com', 'shpat_tok', 'APP_UNINSTALLED', `${APP_URL}/webhooks/uninstall`, fetchImpl);

    expect(r.ok).toBe(true);
    expect(captured!.url).toMatch(/^https:\/\/a\.myshopify\.com\/admin\/api\/.+\/graphql\.json$/);
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['X-Shopify-Access-Token']).toBe('shpat_tok');
    const body = JSON.parse(captured!.init.body as string);
    expect(body.variables.url).toBe(`${APP_URL}/webhooks/uninstall`);
    expect(body.variables.topic).toBe('APP_UNINSTALLED');
  });

  it('treats a duplicate-subscription userError as success (idempotent)', async () => {
    const fetchImpl = (async () =>
      graphqlResponse([{ message: 'Address for this topic has already been taken' }])) as typeof fetch;
    const r = await registerWebhookTopic('a.myshopify.com', 't', 'ORDERS_PAID', `${APP_URL}/webhooks/orders-paid`, fetchImpl);
    expect(r.ok).toBe(true);
  });

  it('reports other userErrors as failure', async () => {
    const fetchImpl = (async () => graphqlResponse([{ message: 'Invalid callbackUrl' }])) as typeof fetch;
    const r = await registerWebhookTopic('a.myshopify.com', 't', 'ORDERS_PAID', `${APP_URL}/x`, fetchImpl);
    expect(r).toEqual({ ok: false, error: 'Invalid callbackUrl' });
  });

  it('reports an HTTP error without throwing', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const r = await registerWebhookTopic('a.myshopify.com', 't', 'APP_UNINSTALLED', `${APP_URL}/x`, fetchImpl);
    expect(r).toEqual({ ok: false, error: 'Shopify HTTP 500' });
  });

  it('reports a network failure without throwing', async () => {
    const fetchImpl = (async () => { throw new Error('connection reset'); }) as typeof fetch;
    const r = await registerWebhookTopic('a.myshopify.com', 't', 'APP_UNINSTALLED', `${APP_URL}/x`, fetchImpl);
    expect(r).toEqual({ ok: false, error: 'connection reset' });
  });
});

describe('registerWebhooks (all topics)', () => {
  it('subscribes to uninstall, orders/paid, and the three GDPR topics', async () => {
    const topics: string[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      topics.push(JSON.parse(init.body).variables.topic);
      return graphqlResponse([]);
    }) as typeof fetch;
    const r = await registerWebhooks('a.myshopify.com', 't', APP_URL, fetchImpl);
    expect(r.ok).toBe(true);
    expect(topics.sort()).toEqual(['APP_UNINSTALLED', 'CUSTOMERS_DATA_REQUEST', 'CUSTOMERS_REDACT', 'ORDERS_PAID', 'SHOP_REDACT']);
  });

  it('surfaces a failing topic (e.g. missing orders scope) without throwing', async () => {
    const fetchImpl = (async (_url: any, init: any) => {
      const topic = JSON.parse(init.body).variables.topic;
      return topic === 'ORDERS_PAID' ? graphqlResponse([{ message: 'Not approved for orders' }]) : graphqlResponse([]);
    }) as typeof fetch;
    const r = await registerWebhooks('a.myshopify.com', 't', APP_URL, fetchImpl);
    expect(r).toEqual({ ok: false, error: 'Not approved for orders' });
  });
});
