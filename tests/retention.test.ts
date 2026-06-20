import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  signUnsubToken, verifyUnsubToken, shouldRemind, fetchReorderCandidates,
  buildReorderEmail, sendReorderReminders, type ReorderOrder
} from '../src/retention';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX, type TenantConfig, type Env } from '../src/types';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const DAY = 86_400_000;
const NOW = 1_750_000_000_000;
const SECRET = 'shpss_test_secret';

const CFG: TenantConfig = {
  collectionMap: {
    'pet-health': { handle: 'pet-health', tag: 'cj-pet-health' },
    'pet-cleaning': { handle: 'pet-cleaning', tag: 'cj-pet-cleaning' },
    'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' }
  },
  gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS,
  llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
};

function order(over: Partial<ReorderOrder> = {}): ReorderOrder {
  return {
    id: 'gid://shopify/Order/1',
    email: 'Buyer@Example.com',
    createdAt: new Date(NOW - 45 * DAY).toISOString(),
    marketingState: 'SUBSCRIBED',
    customerLastOrderAt: new Date(NOW - 45 * DAY).toISOString(),
    reorderableTitles: ['Dog Multivitamin Chews'],
    ...over
  };
}

describe('unsubscribe token', () => {
  it('round-trips and is case-insensitive on email', async () => {
    const t = await signUnsubToken(SHOP, 'Buyer@Example.com', SECRET);
    expect(await verifyUnsubToken(SHOP, 'buyer@example.com', t, SECRET)).toBe(true);
  });
  it('rejects a tampered token / wrong secret / wrong email', async () => {
    const t = await signUnsubToken(SHOP, 'buyer@example.com', SECRET);
    expect(await verifyUnsubToken(SHOP, 'buyer@example.com', t + 'x', SECRET)).toBe(false);
    expect(await verifyUnsubToken(SHOP, 'buyer@example.com', t, 'other')).toBe(false);
    expect(await verifyUnsubToken(SHOP, 'someone@else.com', t, SECRET)).toBe(false);
    expect(await verifyUnsubToken(SHOP, 'buyer@example.com', '', SECRET)).toBe(false);
  });
});

describe('shouldRemind', () => {
  it('reminds a subscribed customer with a reorderable item and no later order', () => {
    expect(shouldRemind(order()).ok).toBe(true);
  });
  it('skips when not marketing-subscribed', () => {
    expect(shouldRemind(order({ marketingState: 'NOT_SUBSCRIBED' })).reason).toBe('not subscribed');
    expect(shouldRemind(order({ marketingState: '' })).ok).toBe(false);
  });
  it('skips when nothing reorderable', () => {
    expect(shouldRemind(order({ reorderableTitles: [] })).reason).toBe('no reorderable items');
  });
  it('skips when the customer already bought again since', () => {
    expect(shouldRemind(order({ customerLastOrderAt: new Date(NOW - 5 * DAY).toISOString() })).reason).toBe('reordered since');
  });
  it('skips when no email', () => {
    expect(shouldRemind(order({ email: '' })).ok).toBe(false);
  });
});

describe('fetchReorderCandidates', () => {
  it('keeps only line items in reorderable lanes and maps consent + last order', async () => {
    const admin = (async (q: string) => {
      if (!q.includes('pawscoutReorders')) return {};
      return {
        orders: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: 'gid://shopify/Order/9',
            createdAt: new Date(NOW - 45 * DAY).toISOString(),
            email: 'a@b.com',
            customer: { emailMarketingConsent: { marketingState: 'SUBSCRIBED' }, lastOrder: { createdAt: new Date(NOW - 45 * DAY).toISOString() } },
            lineItems: { nodes: [
              { title: 'Ear Cleaning Drops', product: { tags: ['cj-pet-cleaning'] } },
              { title: 'Squeaky Ball', product: { tags: ['cj-pet-toys'] } }
            ] }
          }]
        }
      };
    }) as unknown as AdminGraphql;
    const [c] = await fetchReorderCandidates(admin, 'q', ['cj-pet-health', 'cj-pet-cleaning']);
    expect(c.reorderableTitles).toEqual(['Ear Cleaning Drops']); // toy dropped
    expect(c.marketingState).toBe('SUBSCRIBED');
  });
});

describe('buildReorderEmail', () => {
  it('includes the product, the unsubscribe link and the one-click header', () => {
    const m = buildReorderEmail('buyer@example.com', ['Dog Multivitamin Chews'], 'https://x/unsubscribe?token=abc');
    expect(m.to).toBe('buyer@example.com');
    expect(m.html).toContain('Dog Multivitamin Chews');
    expect(m.html).toContain('https://x/unsubscribe?token=abc');
    expect(m.headers['List-Unsubscribe']).toBe('<https://x/unsubscribe?token=abc>');
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.from).toContain('activepaw.co.uk');
  });
});

describe('sendReorderReminders', () => {
  function makeEnv(over: Partial<Env> = {}): Env {
    return { DB: env.DB, RESEND_API_KEY: 're_x', SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: 'https://pawscout.activepaw.co.uk', ...over } as unknown as Env;
  }
  function oneOrderAdmin(id = 'gid://shopify/Order/1', email = 'Buyer@Example.com'): AdminGraphql {
    return (async (q: string) => {
      if (!q.includes('pawscoutReorders')) return {};
      return { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
        id, createdAt: new Date(NOW - 45 * DAY).toISOString(), email,
        customer: { emailMarketingConsent: { marketingState: 'SUBSCRIBED' }, lastOrder: { createdAt: new Date(NOW - 45 * DAY).toISOString() } },
        lineItems: { nodes: [{ title: 'Dog Multivitamin Chews', product: { tags: ['cj-pet-health'] } }] }
      }] } };
    }) as unknown as AdminGraphql;
  }
  function captureFetch(sends: { body: Record<string, unknown> }[]): typeof fetch {
    return (async (_url: string, init: { body: string }) => {
      sends.push({ body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  }

  it('sends one reminder for a qualifying order and records it (dedup on re-run)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const sends: { body: Record<string, unknown> }[] = [];
    const n = await sendReorderReminders(store, oneOrderAdmin(), CFG, makeEnv(), { now: NOW, fetchImpl: captureFetch(sends) });
    expect(n).toBe(1);
    expect(sends).toHaveLength(1);
    expect((sends[0].body as { to: string[] }).to).toEqual(['buyer@example.com']);
    expect(await store.hasReorderReminder('gid://shopify/Order/1')).toBe(true);

    // second run: already reminded → no send
    const sends2: { body: Record<string, unknown> }[] = [];
    const n2 = await sendReorderReminders(store, oneOrderAdmin(), CFG, makeEnv(), { now: NOW, fetchImpl: captureFetch(sends2) });
    expect(n2).toBe(0);
    expect(sends2).toHaveLength(0);
  });

  it('suppresses an unsubscribed email even for a new order', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.recordUnsubscribe('buyer@example.com', new Date(NOW).toISOString());
    const sends: { body: Record<string, unknown> }[] = [];
    const n = await sendReorderReminders(store, oneOrderAdmin('gid://shopify/Order/2'), CFG, makeEnv(), { now: NOW, fetchImpl: captureFetch(sends) });
    expect(n).toBe(0);
    expect(sends).toHaveLength(0);
  });

  it('is dormant-safe: no RESEND key → no sends', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const sends: { body: Record<string, unknown> }[] = [];
    const n = await sendReorderReminders(store, oneOrderAdmin(), CFG, makeEnv({ RESEND_API_KEY: undefined }), { now: NOW, fetchImpl: captureFetch(sends) });
    expect(n).toBe(0);
    expect(sends).toHaveLength(0);
  });
});
