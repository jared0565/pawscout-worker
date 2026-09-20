import { describe, it, expect } from 'vitest';
import {
  REQUIRED_TOPICS,
  ORDER_EVENT_TOPICS,
  listWebhookTopics,
  ensureWebhooks,
  registerWebhooks
} from '../src/webhooks';
import type { AdminGraphql } from '../src/shopify-admin';

const APP_URL = 'https://pawscout.example.com';

type Registered = { topic: string; uri: string };
type RecordedCall = { query: string; variables?: Record<string, unknown> };

/** A fake AdminGraphql over a mutable list of registered { topic, uri } pairs.
 *  A create for a topic in `userErrorsByTopic` returns that message as a
 *  userError; a message matching "already been taken" means the subscription
 *  already exists, any other message does not touch `registered`. A genuine
 *  create (no userErrors) is pushed to `registered`, UNLESS its topic is in
 *  `silentlyDrop`: the create then still answers success, but the
 *  subscription never shows up on a later list, the way a real one can be
 *  accepted and later dropped. This lets a test tell "trust the read-back"
 *  apart from "trust what the create call claimed". `listError` makes every
 *  list call throw; `secondListError` makes only the SECOND list call throw
 *  (the first still answers normally). */
function fakeAdmin(
  registered: Registered[],
  opts: {
    userErrorsByTopic?: Record<string, string>;
    listError?: string;
    secondListError?: string;
    silentlyDrop?: Set<string>;
    calls?: RecordedCall[];
  } = {}
): AdminGraphql {
  const calls = opts.calls ?? [];
  let listCalls = 0;
  return async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('webhookSubscriptions(')) {
      listCalls += 1;
      if (opts.listError) throw new Error(opts.listError);
      if (opts.secondListError && listCalls === 2) throw new Error(opts.secondListError);
      return { webhookSubscriptions: { nodes: registered.map((r, i) => ({ id: `gid://${i}`, ...r })) } };
    }
    const topic = variables!.topic as string;
    const uri = variables!.uri as string;
    const message = opts.userErrorsByTopic?.[topic];
    if (message) {
      if (/already been taken/i.test(message) && !opts.silentlyDrop?.has(topic)) registered.push({ topic, uri });
      return { webhookSubscriptionCreate: { userErrors: [{ message }], webhookSubscription: null } };
    }
    if (!opts.silentlyDrop?.has(topic)) registered.push({ topic, uri });
    return { webhookSubscriptionCreate: { userErrors: [], webhookSubscription: { id: 'gid://new' } } };
  };
}

const requiredTopicNames = () => REQUIRED_TOPICS.map((t) => t.topic);

describe('REQUIRED_TOPICS / ORDER_EVENT_TOPICS', () => {
  it('holds exactly the four API-managed topics, none of the three privacy topics', () => {
    expect(requiredTopicNames().sort()).toEqual(
      ['APP_UNINSTALLED', 'ORDERS_CANCELLED', 'ORDERS_PAID', 'REFUNDS_CREATE'].sort()
    );
    for (const privacyTopic of ['CUSTOMERS_REDACT', 'CUSTOMERS_DATA_REQUEST', 'SHOP_REDACT']) {
      expect(requiredTopicNames()).not.toContain(privacyTopic);
    }
  });

  it('lists exactly the order lifecycle topics', () => {
    expect(ORDER_EVENT_TOPICS).toEqual(['ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE']);
  });
});

describe('listWebhookTopics', () => {
  it('lists the topic and uri of every registered subscription', async () => {
    const admin: AdminGraphql = async () => ({
      webhookSubscriptions: { nodes: [{ id: 'gid://1', topic: 'ORDERS_PAID', uri: `${APP_URL}/webhooks/orders-paid` }] }
    });
    const list = await listWebhookTopics(admin);
    expect(list).toEqual([{ topic: 'ORDERS_PAID', uri: `${APP_URL}/webhooks/orders-paid` }]);
  });
});

describe('ensureWebhooks', () => {
  it('creates all four when nothing is registered', async () => {
    const admin = fakeAdmin([]);
    const status = await ensureWebhooks(admin, APP_URL);
    expect(status.ok).toBe(true);
    expect(status.created.sort()).toEqual(requiredTopicNames().sort());
    expect(status.missing).toEqual([]);
    expect(status.verified).toBe(true);
  });

  it('makes no create call when all four are already present at our uri', async () => {
    const registered = REQUIRED_TOPICS.map((t) => ({ topic: t.topic, uri: `${APP_URL}${t.path}` }));
    const calls: RecordedCall[] = [];
    const admin = fakeAdmin(registered, { calls });
    const status = await ensureWebhooks(admin, APP_URL);
    expect(status.present.sort()).toEqual(requiredTopicNames().sort());
    expect(status.created).toEqual([]);
    expect(calls.some((c) => c.query.includes('webhookSubscriptionCreate('))).toBe(false);
    // Everything present on the first list -> the first list IS the final
    // state, so this is verified without needing a second (redundant) call.
    expect(status.verified).toBe(true);
  });

  it('creates ORDERS_PAID when it is registered at a different uri', async () => {
    const registered = [{ topic: 'ORDERS_PAID', uri: 'https://old.example.com/webhooks/orders-paid' }];
    const admin = fakeAdmin(registered);
    const status = await ensureWebhooks(admin, APP_URL);
    expect(status.created).toContain('ORDERS_PAID');
    expect(status.missing).toEqual([]);
  });

  it('reports a real create userError without stopping the other topics', async () => {
    const admin = fakeAdmin([], { userErrorsByTopic: { ORDERS_PAID: 'Not approved for orders' } });
    const status = await ensureWebhooks(admin, APP_URL);
    expect(status.ok).toBe(false);
    expect(status.missing).toEqual(['ORDERS_PAID']);
    expect(status.errors).toEqual(['Not approved for orders']);
    expect(status.created.sort()).toEqual(['APP_UNINSTALLED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'].sort());
    // The create failed, but the READ-BACK that follows it succeeded and
    // is the one that reports ORDERS_PAID missing - that is a real, known gap,
    // not an unknown, so verified is true even though ok is false.
    expect(status.verified).toBe(true);
  });

  it('treats an already-taken userError as success, not an error, and does not count it as created', async () => {
    const admin = fakeAdmin([], { userErrorsByTopic: { ORDERS_PAID: 'Address for this topic has already been taken' } });
    const status = await ensureWebhooks(admin, APP_URL);
    expect(status.errors).toEqual([]);
    expect(status.present).toContain('ORDERS_PAID');
    expect(status.missing).toEqual([]);
    expect(status.ok).toBe(true);
    expect(status.created).not.toContain('ORDERS_PAID');
  });

  it('reports from the read-back, not from what the create call claimed', async () => {
    // The create for ORDERS_CANCELLED answers success, but the topic never
    // shows up on the following list (Shopify accepted it and later dropped
    // it, or the two calls are simply not the same operation). The result
    // must trust the second list, not the create's own claim.
    const admin = fakeAdmin([], { silentlyDrop: new Set(['ORDERS_CANCELLED']) });
    const status = await ensureWebhooks(admin, APP_URL);
    expect(status.missing).toContain('ORDERS_CANCELLED');
    expect(status.present).not.toContain('ORDERS_CANCELLED');
    expect(status.ok).toBe(false);
  });

  it('does not throw when the list query fails, and reports one error', async () => {
    const admin = fakeAdmin([], { listError: 'network down' });
    const status = await ensureWebhooks(admin, APP_URL);
    expect(status.ok).toBe(false);
    expect(status.errors).toEqual(['network down']);
    // Nothing is known when the very first read fails - unverified, and
    // ok can never be true while unverified.
    expect(status.verified).toBe(false);
  });

  it('does not throw when only the second (read-back) list fails: present stays at the first list, every created-but-unconfirmed topic is missing', async () => {
    const registered = [{ topic: 'APP_UNINSTALLED', uri: `${APP_URL}/webhooks/uninstall` }];
    const admin = fakeAdmin(registered, { secondListError: 'read-back unavailable' });
    const status = await ensureWebhooks(admin, APP_URL);
    expect(status.ok).toBe(false);
    expect(status.errors).toEqual(['read-back unavailable']);
    expect(status.present).toEqual(['APP_UNINSTALLED']);
    expect(status.missing.sort()).toEqual(['ORDERS_CANCELLED', 'ORDERS_PAID', 'REFUNDS_CREATE'].sort());
    // Creates were attempted (three topics were missing from the first
    // list) and the read-back that was supposed to confirm them failed, so the
    // three "missing" topics reported here are not actually known to be
    // missing - unverified, even though the fallback keeps reporting them.
    expect(status.verified).toBe(false);
  });

  it('normalises a trailing slash in appUrl: matches already-registered topics with no double slash', async () => {
    const registered = REQUIRED_TOPICS.map((t) => ({ topic: t.topic, uri: `https://x.example${t.path}` }));
    const calls: RecordedCall[] = [];
    const admin = fakeAdmin(registered, { calls });
    const status = await ensureWebhooks(admin, 'https://x.example/');
    expect(status.present.sort()).toEqual(requiredTopicNames().sort());
    expect(status.missing).toEqual([]);
    expect(calls.some((c) => c.query.includes('webhookSubscriptionCreate('))).toBe(false);
  });

  it('creates at a single-slash uri when appUrl carries a trailing slash', async () => {
    const registered = [{ topic: 'ORDERS_PAID', uri: 'https://old.example.com/webhooks/orders-paid' }];
    const calls: RecordedCall[] = [];
    const admin = fakeAdmin(registered, { calls });
    await ensureWebhooks(admin, 'https://x.example/');
    const createCall = calls.find(
      (c) => c.query.includes('webhookSubscriptionCreate(') && c.variables?.topic === 'ORDERS_PAID'
    );
    expect(createCall?.variables?.uri).toBe('https://x.example/webhooks/orders-paid');
  });

  it('sends uri, never callbackUrl, in the create mutation', async () => {
    const calls: RecordedCall[] = [];
    const admin = fakeAdmin([], { calls });
    await ensureWebhooks(admin, APP_URL);
    const createCalls = calls.filter((c) => c.query.includes('webhookSubscriptionCreate('));
    expect(createCalls.length).toBeGreaterThan(0);
    for (const call of createCalls) {
      expect(call.variables).toHaveProperty('uri');
      expect(call.variables).not.toHaveProperty('callbackUrl');
      expect(call.query).not.toMatch(/callbackUrl/);
    }
  });
});

describe('registerWebhooks (thin wrapper over ensureWebhooks)', () => {
  it('resolves ok true end to end over fetch: lists nothing, creates every topic, lists all four', async () => {
    const registered: Registered[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body as string);
      if ((body.query as string).includes('webhookSubscriptions(')) {
        return new Response(
          JSON.stringify({ data: { webhookSubscriptions: { nodes: registered.map((r, i) => ({ id: `gid://${i}`, ...r })) } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const { topic, uri } = body.variables;
      registered.push({ topic, uri });
      return new Response(
        JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors: [], webhookSubscription: { id: 'gid://new' } } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const r = await registerWebhooks('a.myshopify.com', 't', APP_URL, fetchImpl);
    expect(r).toEqual({ ok: true });
  });

  it('resolves ok false naming the missing topics when a create keeps failing', async () => {
    const registered: Registered[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body as string);
      if ((body.query as string).includes('webhookSubscriptions(')) {
        return new Response(
          JSON.stringify({ data: { webhookSubscriptions: { nodes: registered.map((r, i) => ({ id: `gid://${i}`, ...r })) } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const { topic, uri } = body.variables;
      if (topic === 'ORDERS_PAID') {
        return new Response(
          JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors: [{ message: 'Not approved for orders' }] } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      registered.push({ topic, uri });
      return new Response(
        JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors: [], webhookSubscription: { id: 'gid://new' } } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const r = await registerWebhooks('a.myshopify.com', 't', APP_URL, fetchImpl);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('ORDERS_PAID');
  });
});
