import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { searchBackfill, normalizeKeyword, relevanceMatch } from '../src/proxy/search';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, type TenantConfig } from '../src/types';
import type { CjClient, CjSearchItem } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const CFG: TenantConfig = {
  collectionMap: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-cat-pet-toys' } },
  gates: DEFAULT_GATES, // floor 50, $5–80, title relevance
  pricing: DEFAULT_PRICING,
  floors: DEFAULT_FLOORS,
  llm: DEFAULT_LLM,
  target: 12
};

function item(over: Partial<CjSearchItem>): CjSearchItem {
  return { pid: 'P1', nameEn: 'Dog Toy Rope', image: 'https://i/1.jpg', sellPriceUsd: 10, listedNum: 100, categoryName: 'Pet Toys', ...over };
}

function fakeCj(items: CjSearchItem[], calls: string[] = []): CjClient {
  return { search: async (kw: string) => { calls.push(kw); return items; } } as unknown as CjClient;
}

describe('relevance + normalization', () => {
  it('normalizes keywords', () => {
    expect(normalizeKeyword('  Dog   TOY ')).toBe('dog toy');
  });
  it('title mode needs one token, strict needs all', () => {
    expect(relevanceMatch('dog rope', 'Big Dog Bed', 'title')).toBe(true);
    expect(relevanceMatch('dog rope', 'Big Dog Bed', 'strict')).toBe(false);
    expect(relevanceMatch('dog rope', 'Dog Rope Toy', 'strict')).toBe(true);
    expect(relevanceMatch('cat tree', 'Dog Bed', 'loose')).toBe(true);
  });
});

describe('searchBackfill', () => {
  it('applies gates, prices in GBP, and logs the demand signal', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const items = [
      item({ pid: 'ok' }),
      item({ pid: 'unpopular', listedNum: 0 }),
      item({ pid: 'pricey', sellPriceUsd: 500 }),
      item({ pid: 'offtopic', nameEn: 'Garden Hose' })
    ];
    const cards = await searchBackfill(store, fakeCj(items), CFG, 'dog toy', 4, 12);

    expect(cards.map((c) => c.pid)).toEqual(['ok']);
    expect(cards[0].price).toBe(19.99); // 10 USD under default pricing
    expect(cards[0].state).toBe('ghost');

    const since = new Date(Date.now() - 60_000).toISOString();
    const log = await store.recentSearches(since, 10);
    expect(log).toHaveLength(1);
    expect(log[0].keyword_norm).toBe('dog toy');
    expect(Number(log[0].avg_store_hits)).toBe(4);
    expect(Number(log[0].avg_ghost_hits)).toBe(1);
  });

  it('serves repeats from cache — CJ is hit once per keyword', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: string[] = [];
    const cj = fakeCj([item({})], calls);
    await searchBackfill(store, cj, CFG, 'Dog Toy', 0, 12);
    await searchBackfill(store, cj, CFG, 'dog   toy', 0, 12); // same after normalization
    expect(calls).toEqual(['dog toy']);
  });

  it('marks already-imported products with their real PDP url', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://1', handle: 'dog-toy-rope' });
    const cards = await searchBackfill(store, fakeCj([item({})]), CFG, 'dog toy', 0, 12);
    expect(cards[0]).toMatchObject({ state: 'imported', url: '/products/dog-toy-rope' });
  });

  it('re-offers archived products as ghosts (demand can revive them)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'archived', shopifyProductId: 'gid://1', handle: 'dog-toy-rope' });
    const cards = await searchBackfill(store, fakeCj([item({})]), CFG, 'dog toy', 0, 12);
    expect(cards[0]).toMatchObject({ state: 'ghost', url: null });
  });

  it('respects the limit', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const items = Array.from({ length: 20 }, (_, i) => item({ pid: `p${i}` }));
    const cards = await searchBackfill(store, fakeCj(items), CFG, 'dog toy', 0, 3);
    expect(cards).toHaveLength(3);
  });
});
