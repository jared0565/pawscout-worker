import { describe, it, expect } from 'vitest';
import { DEFAULT_LLM } from '../src/types';
import { DEFAULT_MODEL, DEFAULT_MODEL_PRICE } from '../src/llm';

describe('llm config shape', () => {
  it('DEFAULT_LLM has slim behavioral knobs + empty models, no slug fields', () => {
    expect(DEFAULT_LLM).toEqual({ enabled: true, scoreThreshold: 60, models: {} });
    expect('model' in DEFAULT_LLM).toBe(false);
    expect('curationModel' in DEFAULT_LLM).toBe(false);
  });
  // REPOINTED 2026-08-11, gpt-5.6-luna -> gpt-5.4-mini. This pin did its job: it
  // failed loudly the moment the constant moved, which is why it is being edited
  // deliberately rather than drifting. The reason for the move is NOT a change of
  // preference - it is that our OpenAI project is not entitled to gpt-5.6-luna
  // and answers every request for it with "Project proj_C5iKlmS2NkRlOLUECLmwcxae
  // does not have access to model `gpt-5.6-luna`", observed in a live worker log.
  // The model was verified against OpenAI's docs when it was chosen; entitlement
  // on our key was not, and only entitlement decides whether the floor works.
  // Move this again only after a real call on the real key succeeds.
  it('the deliberate OpenAI floor constant + price are pinned', () => {
    expect(DEFAULT_MODEL).toBe('gpt-5.4-mini');
    expect(DEFAULT_MODEL_PRICE).toEqual({ promptPerM: 0.75, completionPerM: 4.50 });
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
