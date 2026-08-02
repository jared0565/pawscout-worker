import { describe, it, expect } from 'vitest';
import { DEFAULT_LLM } from '../src/types';
import { DEFAULT_MODEL, DEFAULT_MODEL_PRICE } from '../src/llm';

describe('llm config shape', () => {
  it('DEFAULT_LLM has slim behavioral knobs + empty models, no slug fields', () => {
    expect(DEFAULT_LLM).toEqual({ enabled: true, scoreThreshold: 60, models: {} });
    expect('model' in DEFAULT_LLM).toBe(false);
    expect('curationModel' in DEFAULT_LLM).toBe(false);
  });
  it('the deliberate OpenAI floor constant + price are pinned', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.6-luna');
    expect(DEFAULT_MODEL_PRICE).toEqual({ promptPerM: 0.20, completionPerM: 1.20 });
  });

  // The floor calls api.openai.com directly, so the ID must be OpenAI's own,
  // not the OpenRouter slug for the same model. `openai/gpt-5.6-luna` would be
  // accepted by every type in this codebase and 404 at OpenAI.
  it('the floor model is a bare OpenAI id, never an OpenRouter slug', () => {
    expect(DEFAULT_MODEL).not.toContain('/');
  });

  // OpenAI returns no cost field, so this constant IS the cost record for every
  // tier-3 call. Pinning them in one test is what stops the model moving while
  // the price silently stays behind.
  it('prices the floor at OpenAI direct rates, not the cheaper OpenRouter ones', () => {
    expect(DEFAULT_MODEL_PRICE.promptPerM).toBeGreaterThan(0);
    expect(DEFAULT_MODEL_PRICE.completionPerM).toBeGreaterThan(DEFAULT_MODEL_PRICE.promptPerM);
  });
});
