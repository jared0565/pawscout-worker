import { describe, it, expect } from 'vitest';
import { validateLlmPayload } from '../src/validate';
describe('validateLlmPayload (models block)', () => {
  it('accepts the new shape and drops blanks', () => {
    const r = validateLlmPayload({ enabled: true, scoreThreshold: 60, models: { text: 'a/b', image: '', fallback: 'c/d' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ enabled: true, scoreThreshold: 60, models: { text: 'a/b', fallback: 'c/d' } });
  });
  it('rejects a malformed slug', () => {
    expect(validateLlmPayload({ enabled: true, scoreThreshold: 60, models: { text: 'not a slug' } }).ok).toBe(false);
  });
});
