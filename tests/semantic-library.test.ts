import { describe, it, expect } from 'vitest';
import { fetchSuggest, cleanToPetTerms, seedTerm, getExpansions } from '../src/semantic/library';
import { DEFAULT_SEMANTIC, DEFAULT_LLM, type TenantConfig } from '../src/types';

const cfg = (over: Partial<TenantConfig['semantic']> = {}): TenantConfig =>
  ({ semantic: { ...DEFAULT_SEMANTIC, ...over }, llm: DEFAULT_LLM } as unknown as TenantConfig);

// Autocomplete stub: echoes [query, suggestions] per the Google/DDG shape and records URLs.
function suggestFetch(map: Record<string, string[]>, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(url);
    const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
    return new Response(JSON.stringify([q, map[q] || []]), { status: 200 });
  }) as unknown as typeof fetch;
}
function llmReturning(arr: unknown) {
  return { available: true, jsonChain: async () => ({ ok: true, value: arr }) } as any;
}

describe('fetchSuggest', () => {
  it('pet-biases the query and unions+dedupes suggestions', async () => {
    const seen: string[] = [];
    const f = suggestFetch({
      'pet shampoo': ['pet shampoo for dogs', 'dog shampoo'],
      'dog shampoo': ['dog shampoo', 'puppy shampoo'],
      'cat shampoo': ['cat shampoo'],
      'pet cleaning shampoo': ['pet cleaning shampoo']
    }, seen);
    const out = await fetchSuggest('shampoo', 'pet-cleaning', f);
    expect(seen.some((u) => u.includes('pet%20shampoo'))).toBe(true);
    expect(seen.some((u) => u.includes('dog%20shampoo'))).toBe(true);
    expect(out).toContain('dog shampoo');
    expect(out).toContain('puppy shampoo');
    expect(out.filter((x) => x === 'dog shampoo')).toHaveLength(1);
  });
  it('returns [] when fetch throws', async () => {
    const f = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    expect(await fetchSuggest('shampoo', 'pet-cleaning', f)).toEqual([]);
  });
});

describe('cleanToPetTerms', () => {
  it('keeps pet terms and the backstop drops a human term the LLM let through', async () => {
    const out = await cleanToPetTerms(llmReturning(['dog shampoo', 'puppy bath', 'head and shoulders']), cfg(), ['x'], 'shampoo', 'pet-cleaning');
    expect(out).toContain('dog shampoo');
    expect(out).toContain('puppy bath');
    expect(out).not.toContain('head and shoulders');
  });
  it('caps to maxExpansions and drops the seed term', async () => {
    const out = await cleanToPetTerms(llmReturning(['shampoo', 'dog shampoo', 'cat shampoo', 'pet shampoo', 'puppy shampoo']), cfg({ maxExpansions: 2 }), ['x'], 'shampoo', 'pet-cleaning');
    expect(out).toHaveLength(2);
    expect(out).not.toContain('shampoo');
  });
  it('degrades to pet-floor-filtered raw when LLM unavailable', async () => {
    const llm = { available: false, json: async () => { throw new Error('nope'); } } as any;
    const out = await cleanToPetTerms(llm, cfg(), ['dog shampoo', 'human shampoo'], 'shampoo', 'pet-cleaning');
    expect(out).toEqual(['dog shampoo']);
  });
});

function fakeStore() {
  const mem = new Map<string, string[]>();
  return {
    _mem: mem,
    getSemanticExpansions: async (c: string, t: string) => mem.has(`${c}|${t}`) ? { expansions: mem.get(`${c}|${t}`)!, updatedAt: 'x' } : null,
    upsertSemanticTerm: async (c: string, t: string, e: string[]) => { mem.set(`${c}|${t}`, e); },
    listSemanticTermsForCollection: async () => []
  } as any;
}

describe('getExpansions / seedTerm', () => {
  it('excluded collection or disabled returns [] with no store/llm/fetch', async () => {
    const store = fakeStore();
    let touched = false;
    const f = (async () => { touched = true; return new Response('[]'); }) as unknown as typeof fetch;
    expect(await getExpansions(store, cfg(), 'shampoo', 'more-to-love', { llm: llmReturning([]), fetchImpl: f })).toEqual([]);
    expect(await getExpansions(store, cfg({ enabled: false }), 'shampoo', 'pet-toys', { llm: llmReturning([]), fetchImpl: f })).toEqual([]);
    expect(touched).toBe(false);
    expect(store._mem.size).toBe(0);
  });
  it('cache hit returns stored expansions', async () => {
    const store = fakeStore();
    store._mem.set('pet-toys|ball', ['dog ball']);
    expect(await getExpansions(store, cfg(), 'ball', 'pet-toys')).toEqual(['dog ball']);
  });
  it('miss returns [] and schedules a background fill via ctx.waitUntil', async () => {
    const store = fakeStore();
    const tasks: Promise<unknown>[] = [];
    const f = suggestFetch({ 'pet ball': ['dog ball'], 'dog ball': [], 'cat ball': [], 'pet toys ball': [] });
    const out = await getExpansions(store, cfg(), 'ball', 'pet-toys', { llm: llmReturning(['dog ball']), fetchImpl: f, ctx: { waitUntil: (p) => tasks.push(p) } });
    expect(out).toEqual([]);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(store._mem.get('pet-toys|ball')).toEqual(['dog ball']);
  });
  it('seedTerm fetches, cleans, stores and returns', async () => {
    const store = fakeStore();
    const f = suggestFetch({ 'pet ball': ['dog ball', 'human ball'], 'dog ball': [], 'cat ball': [], 'pet toys ball': [] });
    const out = await seedTerm(store, llmReturning(['dog ball', 'human ball']), cfg(), 'ball', 'pet-toys', 'suggest', f);
    expect(out).toEqual(['dog ball']);
    expect(store._mem.get('pet-toys|ball')).toEqual(['dog ball']);
  });
});
