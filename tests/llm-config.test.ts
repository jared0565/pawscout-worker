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
    expect(DEFAULT_MODEL).toBe('gpt-5.4-mini');
    expect(DEFAULT_MODEL_PRICE).toEqual({ promptPerM: 0.75, completionPerM: 4.50 });
  });
});
