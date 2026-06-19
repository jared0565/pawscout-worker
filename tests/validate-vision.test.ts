import { describe, it, expect } from 'vitest';
import { validateLlmPayload } from '../src/validate';

const base = { enabled: true, scoreThreshold: 50 };

describe('validateLlmPayload vision model validation', () => {
  it('accepts a valid image model slug', () => {
    const v = validateLlmPayload({ ...base, models: { image: 'google/gemini-2.5-flash' } });
    expect(v.ok).toBe(true);
    expect(v.ok && v.value.models.image).toBe('google/gemini-2.5-flash');
  });
  it('omits image model when empty string', () => {
    const v = validateLlmPayload({ ...base, models: { image: '' } });
    expect(v.ok && 'image' in v.value.models).toBe(false);
  });
  it('rejects a malformed image model slug', () => {
    const v = validateLlmPayload({ ...base, models: { image: 'not a slug!!' } });
    expect(v.ok).toBe(false);
  });
  it('accepts a valid fallback model slug', () => {
    const v = validateLlmPayload({ ...base, models: { fallback: 'openai/gpt-4o' } });
    expect(v.ok).toBe(true);
    expect(v.ok && v.value.models.fallback).toBe('openai/gpt-4o');
  });
  it('omits fallback when empty string', () => {
    const v = validateLlmPayload({ ...base, models: { fallback: '' } });
    expect(v.ok && 'fallback' in v.value.models).toBe(false);
  });
  it('rejects a malformed fallback slug', () => {
    const v = validateLlmPayload({ ...base, models: { fallback: 'not a slug!!' } });
    expect(v.ok).toBe(false);
  });
});
