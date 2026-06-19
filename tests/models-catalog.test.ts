import { describe, it, expect } from 'vitest';
import { CURATED_MODELS, buildLiveMap, getModelCatalog, MODELS_CACHE_KEY } from '../src/models-catalog';

describe('CURATED_MODELS', () => {
  it('has exactly 9 models incl. gemini-3.1-pro-preview, excludes opus/sonnet', () => {
    const slugs = CURATED_MODELS.map((m) => m.slug);
    expect(slugs).toHaveLength(9);
    expect(slugs).toContain('google/gemini-3.1-pro-preview');
    expect(slugs.some((s) => s.includes('opus') || s.includes('sonnet'))).toBe(false);
  });
  it('marks the two text-only models vision:false', () => {
    const bySlug = Object.fromEntries(CURATED_MODELS.map((m) => [m.slug, m.vision]));
    expect(bySlug['deepseek/deepseek-v4-flash']).toBe(false);
    expect(bySlug['qwen/qwen3.7-max']).toBe(false);
    expect(bySlug['anthropic/claude-haiku-4.5']).toBe(true);
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
    expect(out).toHaveLength(9);
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
    expect(out).toHaveLength(9);
    expect(out.every((m) => m.promptPriceM === null)).toBe(true);
    expect(out.find((m) => m.slug === 'qwen/qwen3.7-max')!.vision).toBe(false);
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
