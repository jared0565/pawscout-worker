import { describe, it, expect } from 'vitest';
import { resolveChain, resolveSearchChain } from '../src/llm-resolve';
import { CURATED_MODELS } from '../src/models-catalog';
import { DEFAULT_MODEL, SEARCH_MODEL } from '../src/llm';
import { DEFAULT_LLM } from '../src/types';
import type { TenantConfig, ModelsConfig } from '../src/types';

const HEAD = CURATED_MODELS[0].slug;
const base = (models: Partial<ModelsConfig>): TenantConfig => ({ ...({} as TenantConfig), llm: { ...DEFAULT_LLM, models } });

describe('resolveChain', () => {
  it('text: primary+fallback → openrouter array then openai floor', () => {
    const c = resolveChain(base({ text: 'a/b', fallback: 'c/d' }), 'text');
    expect(c).toEqual([{ provider: 'openrouter', models: ['a/b', 'c/d'] }, { provider: 'openai', model: DEFAULT_MODEL }]);
  });
  it('blank primary → catalog head; never an empty array', () => {
    const c = resolveChain(base({}), 'text');
    expect(c[0]).toEqual({ provider: 'openrouter', models: [HEAD] });
  });
  it('image uses models.image; dedupes primary==fallback', () => {
    const c = resolveChain(base({ image: 'x/y', fallback: 'x/y' }), 'image');
    expect(c[0]).toEqual({ provider: 'openrouter', models: ['x/y'] });
  });
});

// Both properties here are load-bearing, and both come from a measured outage:
// selecting openai/gpt-5.6-luna as the text model on 2026-08-02 silently ended
// blog demand research, because search inherited that selection and the web
// plugin request failed on it for nine days.
describe('resolveSearchChain', () => {
  it('leads with the search-capable model, keeping the tenant models as failover', () => {
    const c = resolveSearchChain(base({ text: 'openai/gpt-5.6-luna', fallback: 'z/z' }));
    expect(c).toEqual([{ provider: 'openrouter', models: [SEARCH_MODEL, 'openai/gpt-5.6-luna', 'z/z'] }]);
  });
  it('NEVER offers the OpenAI tier, which cannot search at all', () => {
    for (const cfg of [base({}), base({ text: 'a/b' }), base({ text: SEARCH_MODEL, fallback: SEARCH_MODEL })]) {
      expect(resolveSearchChain(cfg).some((t) => t.provider === 'openai')).toBe(false);
    }
  });
  it('dedupes when the tenant already chose the search model', () => {
    expect(resolveSearchChain(base({ text: SEARCH_MODEL, fallback: SEARCH_MODEL }))[0])
      .toEqual({ provider: 'openrouter', models: [SEARCH_MODEL] });
  });
});
