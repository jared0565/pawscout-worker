import { describe, it, expect } from 'vitest';
import { CURATED_MODELS, buildLiveMap, getModelCatalog, MODELS_CACHE_KEY } from '../src/models-catalog';

describe('CURATED_MODELS', () => {
  it('has exactly 11 models incl. gemini-3.1-pro-preview + sonnet-4.6, excludes opus', () => {
    const slugs = CURATED_MODELS.map((m) => m.slug);
    expect(slugs).toHaveLength(11);
    expect(slugs).toContain('google/gemini-3.1-pro-preview'); // merchant-mandated
    expect(slugs).toContain('anthropic/claude-sonnet-4.6');   // accuracy-first inclusion
    expect(slugs).toContain('openai/gpt-5.6-luna');           // added 2026-08-02 (owner request)
    expect(slugs.some((s) => s.includes('opus'))).toBe(false); // opus stays excluded (cost)
  });

  // The slug is the whole contract: an unrecognised one is not rejected anywhere
  // (visionModelRejected deliberately allows unknown slugs), it just 404s at call
  // time. So pin the exact string OpenRouter publishes rather than a near-miss
  // like 'openai/gpt-5.6-luna-pro' or 'openai/gpt-5.6'.
  it('uses the exact OpenRouter slug for GPT-5.6 Luna', () => {
    const luna = CURATED_MODELS.find((m) => m.label === 'GPT-5.6 Luna');
    expect(luna?.slug).toBe('openai/gpt-5.6-luna');
    expect(luna?.vision).toBe(true);
  });
  it('has exactly one text-only model (the rest are vision-capable)', () => {
    const bySlug = Object.fromEntries(CURATED_MODELS.map((m) => [m.slug, m.vision]));
    expect(bySlug['deepseek/deepseek-v4-pro']).toBe(false);
    expect(bySlug['anthropic/claude-haiku-4.5']).toBe(true);
    expect(bySlug['google/gemini-3.1-pro-preview']).toBe(true);
    expect(CURATED_MODELS.filter((m) => !m.vision)).toHaveLength(1);
  });
});

const OR_RESPONSE = {
  data: [
    {
      id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5',
      architecture: { input_modalities: ['text', 'image'] },
      pricing: { prompt: '0.000001', completion: '0.000005' },
    },
    {
      id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash',
      architecture: { input_modalities: ['text'] },
      pricing: { prompt: '0.0000002', completion: '0.0000004' },
    },
  ],
};

function fakeStore() {
  const mem = new Map<string, string>();
  return {
    getSearchCache: async (k: string) => mem.get(k) ?? null,
    putSearchCache: async (k: string, p: string) => { mem.set(k, p); },
  } as any;
}

describe('buildLiveMap', () => {
  it('maps modalities to vision and prices to per-token numbers', () => {
    const m = buildLiveMap(OR_RESPONSE);
    expect(m.get('anthropic/claude-haiku-4.5')!.vision).toBe(true);
    expect(m.get('deepseek/deepseek-v4-flash')!.vision).toBe(false);
    expect(m.get('anthropic/claude-haiku-4.5')!.promptPrice).toBeCloseTo(0.000001);
  });
  it('returns an empty map for a malformed payload', () => {
    expect(buildLiveMap(null).size).toBe(0);
    expect(buildLiveMap({}).size).toBe(0);
  });
});

describe('getModelCatalog', () => {
  it('enriches curated models with live price ($/M) + vision; unknown slug → null price, static vision', async () => {
    const store = fakeStore();
    const fetchImpl = (async () => new Response(JSON.stringify(OR_RESPONSE), { status: 200 })) as any;
    const out = await getModelCatalog(store, fetchImpl);
    // Every curated model survives enrichment. Tied to the source rather than a
    // literal so adding a model does not fail a test about ENRICHMENT; the exact
    // count is pinned once, in the CURATED_MODELS describe above.
    expect(out).toHaveLength(CURATED_MODELS.length);
    const haiku = out.find((m) => m.slug === 'anthropic/claude-haiku-4.5')!;
    expect(haiku.promptPriceM).toBeCloseTo(1.0);
    expect(haiku.completionPriceM).toBeCloseTo(5.0);
    expect(haiku.vision).toBe(true);
    const gemini = out.find((m) => m.slug === 'google/gemini-3.1-pro-preview')!;
    expect(gemini.promptPriceM).toBeNull();
    expect(gemini.vision).toBe(true);
  });

  it('never throws on fetch failure → curated fallback with null prices', async () => {
    const store = fakeStore();
    const fetchImpl = (async () => { throw new Error('network'); }) as any;
    const out = await getModelCatalog(store, fetchImpl);
    expect(out).toHaveLength(CURATED_MODELS.length);
    expect(out.every((m) => m.promptPriceM === null)).toBe(true);
    expect(out.find((m) => m.slug === 'deepseek/deepseek-v4-pro')!.vision).toBe(false);
  });

  it('uses cache on the second call (no second fetch)', async () => {
    const store = fakeStore();
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(JSON.stringify(OR_RESPONSE), { status: 200 }); }) as any;
    await getModelCatalog(store, fetchImpl);
    await getModelCatalog(store, fetchImpl);
    expect(calls).toBe(1);
    expect(await store.getSearchCache(MODELS_CACHE_KEY)).not.toBeNull();
  });
});
