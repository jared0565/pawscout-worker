/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Storewide event facts for the inbox (owner design 2026-09-17): the agents
 * answer "is there a running event?" from the SAME feed the storefront reads
 * (search cache 'public:event'), so email and site can never disagree. A cold
 * feed is warmed from Shopify when a client is available; otherwise the facts
 * hedge, and the drafter neither claims nor denies an event.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { eventFacts } from '../src/inbox/event-facts';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'ev.myshopify.com';

describe('eventFacts', () => {
  it('reports the running event with its name, code, percentage and end date from the cached feed', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.putSearchCache('public:event', JSON.stringify({
      active: true, name: 'Black Friday to Cyber Monday', code: 'BLACKFRIDAY', pctOff: 15,
      endsAt: '2026-11-30T23:59:59.000Z', endsLabel: '30 November'
    }), 1);
    const f = await eventFacts(s, null);
    expect(f).toContain('Black Friday to Cyber Monday');
    expect(f).toContain('BLACKFRIDAY');
    expect(f).toContain('15%');
    expect(f).toContain('Monday 30 November');
    expect(f).toMatch(/exactly as given/i);
    expect(f).not.toMatch(/[–—]/);
  });

  it('says no event is running and names the next one by name and dates only', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.putSearchCache('public:event', JSON.stringify({
      active: false,
      next: { key: 'black-friday', name: 'Black Friday to Cyber Monday', startsAt: '2026-11-27T00:00:00.000Z', endsAt: '2026-11-30T23:59:59.000Z', startsLabel: 'Friday 27 November', endsLabel: 'Monday 30 November' }
    }), 1);
    const f = await eventFacts(s, null);
    expect(f).toMatch(/no storewide event/i);
    expect(f).toContain('Black Friday to Cyber Monday');
    expect(f).toContain('Friday 27 November');
    expect(f).toMatch(/never a code or percentage/i);
    expect(f).not.toContain('BLACKFRIDAY');
  });

  it('says no event is running when nothing is planned either', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.putSearchCache('public:event', JSON.stringify({ active: false }), 1);
    const f = await eventFacts(s, null);
    expect(f).toMatch(/no storewide event/i);
    expect(f).not.toMatch(/next planned/i);
  });

  it('hedges when the feed is cold and Shopify is unavailable', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const f = await eventFacts(s, null);
    expect(f).toMatch(/not known to you/i);
    expect(f).toMatch(/do not invent a code/i);
  });

  it('warms a cold feed from Shopify when a client is available, and caches it', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const admin = (async () => ({
      automaticDiscountNodes: { nodes: [] },
      codeDiscountNodes: { nodes: [{ codeDiscount: {
        __typename: 'DiscountCodeBasic', title: 'BLACKFRIDAY', status: 'ACTIVE',
        startsAt: '2020-01-01T00:00:00Z', endsAt: '2099-12-31T23:59:59Z',
        codes: { nodes: [{ code: 'BLACKFRIDAY' }] },
        customerGets: { value: { __typename: 'DiscountPercentage', percentage: 0.15 } }
      } }] }
    })) as unknown as AdminGraphql;
    const f = await eventFacts(s, admin);
    expect(f).toContain('BLACKFRIDAY');
    expect(f).toContain('15%');
    const cached = await s.getSearchCache('public:event');
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!).active).toBe(true);
  });

  // A draft must never die on the event facts: a store whose cache read throws
  // (D1 hiccup, or a caller with no cache at all) degrades to the hedge.
  it('hedges when the cache read itself throws, instead of aborting the draft', async () => {
    const broken = { async getSearchCache() { throw new Error('d1 down'); } } as unknown as TenantStore;
    const f = await eventFacts(broken, null);
    expect(f).toMatch(/not known to you/i);
  });
});
