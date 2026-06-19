import { describe, it, expect } from 'vitest';
import { resolveChain } from '../src/llm-resolve';
import { CURATED_MODELS } from '../src/models-catalog';
import { DEFAULT_LLM } from '../src/types';
import type { TenantConfig } from '../src/types';

const HEAD = CURATED_MODELS[0].slug;
const base = (models: any): TenantConfig => ({ ...({} as TenantConfig), llm: { ...DEFAULT_LLM, models } });

describe('resolveChain', () => {
  it('text: primary+fallback → openrouter array then openai floor', () => {
    const c = resolveChain(base({ text: 'a/b', fallback: 'c/d' }), 'text');
    expect(c).toEqual([{ provider: 'openrouter', models: ['a/b', 'c/d'] }, { provider: 'openai', model: 'gpt-5.4-mini' }]);
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
