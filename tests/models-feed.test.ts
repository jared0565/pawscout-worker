// The OpenRouter feed reader behind the self-updating model menu (spec 5.1).
// Pinned to a trimmed copy of the real 2026-11-13 feed so the reducer is
// tested against the shapes OpenRouter actually publishes, not a hand-made one.
import { describe, it, expect } from 'vitest';
import feedJson from './fixtures/openrouter-models-2026-11-13.json';
import { reduceFeed, loadFeed, feedCost, FEED_CACHE_KEY } from '../src/models-feed';

function fakeStore() {
  const mem = new Map<string, string>();
  return {
    mem,
    getSearchCache: async (k: string) => mem.get(k) ?? null,
    putSearchCache: async (k: string, p: string) => { mem.set(k, p); },
  };
}

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
  it('caches under the v2 key; a second call does not fetch', async () => {
    const store = fakeStore();
    const counter = { calls: 0 };
    expect(await loadFeed(store, feedFetch(counter))).toHaveLength(331);
    expect(await loadFeed(store, feedFetch(counter))).toHaveLength(331);
    expect(counter.calls).toBe(1);
    expect(store.mem.get(FEED_CACHE_KEY)).toBeTruthy();
  });

  it('ignores an old-shape entry under the v1 key', async () => {
    const store = fakeStore();
    store.mem.set('openrouter:models', JSON.stringify([['anthropic/claude-haiku-4.5', { name: 'x', vision: true }]]));
    const counter = { calls: 0 };
    expect(await loadFeed(store, feedFetch(counter))).toHaveLength(331);
    expect(counter.calls).toBe(1);
  });

  it('refetches when the cached JSON is corrupt or not a list', async () => {
    for (const bad of ['{not json', '{"a":1}']) {
      const store = fakeStore();
      store.mem.set(FEED_CACHE_KEY, bad);
      const counter = { calls: 0 };
      expect(await loadFeed(store, feedFetch(counter))).toHaveLength(331);
      expect(counter.calls).toBe(1);
    }
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
});
