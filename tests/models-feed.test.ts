// The OpenRouter feed reader behind the self-updating model menu (spec 5.1).
// Pinned to a trimmed copy of the real 2026-11-13 feed so the reducer is
// tested against the shapes OpenRouter actually publishes, not a hand-made one.
import { describe, it, expect, vi, afterEach } from 'vitest';
import feedJson from './fixtures/openrouter-models-2026-11-13.json';
import { reduceFeed, loadFeed, readFeed, feedCost, feedCacheEntry, FEED_CACHE_KEY, FEED_KEEP_DAYS, MIN_FEED_ROWS } from '../src/models-feed';

function fakeStore() {
  const mem = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    mem,
    ttls,
    getSearchCache: async (k: string) => mem.get(k) ?? null,
    putSearchCache: async (k: string, p: string, ttlDays: number) => { mem.set(k, p); ttls.set(k, ttlDays); },
  };
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-13T12:00:00Z');
const FULL = reduceFeed(feedJson);
/** The first n rows of the real feed, as OpenRouter would send them. */
const firstRows = (n: number) => ({ data: (feedJson as { data: unknown[] }).data.slice(0, n) });
afterEach(() => { vi.restoreAllMocks(); });

function feedFetch(counter: { calls: number }, body: unknown = feedJson, status = 200): typeof fetch {
  return (async () => { counter.calls++; return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
}

describe('reduceFeed', () => {
  it('reduces every fixture row', () => {
    expect(reduceFeed(feedJson)).toHaveLength(331);
  });

  it('maps prices to $/M, keeps the canonical slug and the efforts', () => {
    const f = reduceFeed(feedJson);
    const by = (id: string) => f.find((m) => m.id === id)!;
    const opus = by('anthropic/claude-opus-5.5');
    expect([opus.promptPriceM, opus.completionPriceM, opus.json]).toEqual([4, 20, true]);
    expect(opus.outputs).toEqual(['text']);
    expect(by('openai/gpt-5.6-luna').canonicalSlug).toBe('openai/gpt-5.6-luna-20260709');
    expect(by('openai/gpt-5-mini').expiresOn).toBe('2026-12-11');
    expect(feedCost(opus)).toBe(24);
    expect([by('anthropic/claude-fable-5.2').efforts, by('anthropic/claude-fable-5.2').defaultEffort])
      .toEqual([['max', 'xhigh', 'high', 'medium', 'low'], 'high']);
    expect(by('qwen/qwen3.8-flash').efforts).toEqual([]);
  });

  // Number('0.0000001') * 1e6 is 0.09999999999999999 in JavaScript; the menu and
  // the price ratio must see 0.1.
  it('removes float noise from per-million prices', () => {
    const f = reduceFeed(feedJson);
    const haiku = f.find((m) => m.id === 'anthropic/claude-haiku-5.5')!;
    expect(haiku.promptPriceM).toBe(0.1);
    expect(f.find((m) => m.id === 'z-ai/glm-5.3')!.completionPriceM).toBe(3.6);
    expect(feedCost(f.find((m) => m.id === 'openai/gpt-5.6-luna')!)).toBe(1.4);
  });

  // Deferred minor (final review 2026-11-13): a full timestamp used to reach the
  // watch unparsed and silently switch off its retirement alert.
  it('reduces an expiration date to YYYY-MM-DD and drops one it cannot read', () => {
    const exp = (v: unknown) => reduceFeed({ data: [{ id: 'a/b', created: 1, expiration_date: v }] })[0].expiresOn;
    expect(exp('2026-12-11')).toBe('2026-12-11');
    expect(exp('2026-12-11T00:00:00Z')).toBe('2026-12-11');
    expect(exp('December 11, 2026 UTC')).toBe('2026-12-11');
    expect(exp('soon')).toBeNull();
    expect(exp(20261211)).toBeNull();
  });

  it('skips malformed rows and never throws', () => {
    expect(reduceFeed(null)).toEqual([]);
    expect(reduceFeed({ data: [null, 5, 'x', { name: 'no id' }] })).toEqual([]);
    const [m] = reduceFeed({ data: [{ id: 'a/b', created: 1, pricing: { prompt: 'abc', completion: '0.000001' } }] });
    expect(m.promptPriceM).toBeNull();
    expect(m.completionPriceM).toBe(1);
    expect(m.inputs).toEqual([]);
    expect(m.efforts).toEqual([]);
    expect(feedCost(m)).toBeNull();
  });
});

describe('loadFeed', () => {
  // Spec 5.11 (owner go 2026-11-13): one copy, stamped with its fetch time and
  // kept 30 days, so the menu and the save check can fall back to it.
  it('caches under the v3 key with its fetch time, kept 30 days; a second call within a day does not fetch', async () => {
    const store = fakeStore();
    const counter = { calls: 0 };
    expect(await loadFeed(store, feedFetch(counter), undefined, NOW)).toHaveLength(331);
    expect(await loadFeed(store, feedFetch(counter), undefined, NOW + DAY - 1)).toHaveLength(331);
    expect(counter.calls).toBe(1);
    expect(FEED_CACHE_KEY).toBe('openrouter:models:v3');
    expect(JSON.parse(store.mem.get(FEED_CACHE_KEY)!)).toMatchObject({ fetchedAt: NOW });
    expect(store.ttls.get(FEED_CACHE_KEY)).toBe(FEED_KEEP_DAYS);
    expect(FEED_KEEP_DAYS).toBe(30);
  });

  it('ignores old-shape entries under the v1 and v2 keys', async () => {
    const store = fakeStore();
    store.mem.set('openrouter:models', JSON.stringify([['anthropic/claude-haiku-4.5', { name: 'x', vision: true }]]));
    store.mem.set('openrouter:models:v2', JSON.stringify(FULL));
    const counter = { calls: 0 };
    expect(await loadFeed(store, feedFetch(counter))).toHaveLength(331);
    expect(counter.calls).toBe(1);
  });

  it('refetches when the cached JSON is corrupt or not a feed copy', async () => {
    for (const bad of ['{not json', '{"a":1}', JSON.stringify(FULL), '{"fetchedAt":1,"models":[]}']) {
      const store = fakeStore();
      store.mem.set(FEED_CACHE_KEY, bad);
      const counter = { calls: 0 };
      expect(await loadFeed(store, feedFetch(counter))).toHaveLength(331);
      expect(counter.calls).toBe(1);
    }
  });

  // Final review 2026-11-13: a save with a changed slot reads the feed, so a
  // feed request that never answers must not hang the console save.
  it('gives up on a feed request that never answers, aborts it, and caches nothing', async () => {
    const store = fakeStore();
    let signal: AbortSignal | undefined;
    const hang = ((_url: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Promise(() => {}); }) as unknown as typeof fetch;
    const started = Date.now();
    expect(await loadFeed(store, hang, 50)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
    expect(store.mem.has(FEED_CACHE_KEY)).toBe(false);
  });

  it('returns null on a throw, a 500, or a 200 with zero usable rows, and caches none of them', async () => {
    const throwing = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const cases: (typeof fetch)[] = [throwing, feedFetch({ calls: 0 }, feedJson, 500), feedFetch({ calls: 0 }, { data: [] })];
    for (const f of cases) {
      const store = fakeStore();
      expect(await loadFeed(store, f)).toBeNull();
      expect(store.mem.has(FEED_CACHE_KEY)).toBe(false);
    }
  });

  // Spec 5.11: a cut-short list must never be trusted. A first fetch has no
  // copy to compare with, so only the floor applies.
  it('refuses a first fetch under MIN_FEED_ROWS and caches nothing', async () => {
    expect(MIN_FEED_ROWS).toBe(100);
    const store = fakeStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readFeed(store, feedFetch({ calls: 0 }, firstRows(99)), undefined, NOW)).toBeNull();
    expect(store.mem.has(FEED_CACHE_KEY)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('models.feed.refused rows=99'));
    expect(await readFeed(store, feedFetch({ calls: 0 }, firstRows(100)), undefined, NOW)).toMatchObject({ stale: false });
  });

  it('a copy older than a day is refetched; if that fails, readFeed serves it as stale and loadFeed gives null', async () => {
    const store = fakeStore();
    store.mem.set(FEED_CACHE_KEY, feedCacheEntry(FULL, NOW - 2 * DAY));
    const down = feedFetch({ calls: 0 }, feedJson, 503);
    const stale = await readFeed(store, down, undefined, NOW);
    expect(stale).toMatchObject({ stale: true, fetchedAt: NOW - 2 * DAY });
    expect(stale!.models).toHaveLength(331);
    // The daily watch never judges "delisted" or "retiring" from an old copy.
    expect(await loadFeed(store, down, undefined, NOW)).toBeNull();
    // A good fetch replaces the copy and is fresh again.
    expect(await readFeed(store, feedFetch({ calls: 0 }), undefined, NOW)).toMatchObject({ stale: false, fetchedAt: NOW });
  });

  it('while the copy is under 3 days old, a fetch with under half its rows is refused, warned, and the copy is served as stale', async () => {
    const store = fakeStore();
    store.mem.set(FEED_CACHE_KEY, feedCacheEntry(FULL, NOW - 1.5 * DAY));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await readFeed(store, feedFetch({ calls: 0 }, firstRows(150)), undefined, NOW);
    expect(r).toMatchObject({ stale: true, fetchedAt: NOW - 1.5 * DAY });
    expect(r!.models).toHaveLength(331);
    expect(JSON.parse(store.mem.get(FEED_CACHE_KEY)!).models).toHaveLength(331);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('models.feed.refused rows=150 copy=331'));
    // Half or more is a normal day's change and is taken.
    expect(await readFeed(store, feedFetch({ calls: 0 }, firstRows(166)), undefined, NOW)).toMatchObject({ stale: false });
  });

  // A real catalogue cut must not freeze the menu on an ageing copy: past 3
  // days only the floor applies.
  it('past 3 days, a smaller but plausible fetch replaces the copy', async () => {
    const store = fakeStore();
    store.mem.set(FEED_CACHE_KEY, feedCacheEntry(FULL, NOW - 4 * DAY));
    const r = await readFeed(store, feedFetch({ calls: 0 }, firstRows(150)), undefined, NOW);
    expect(r).toMatchObject({ stale: false, fetchedAt: NOW });
    expect(r!.models).toHaveLength(150);
  });
});
