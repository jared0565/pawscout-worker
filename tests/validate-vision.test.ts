import { describe, it, expect } from 'vitest';
import { validateLlmPayload } from '../src/validate';

const base = { enabled: true, model: 'anthropic/claude-haiku-4.5', scoreThreshold: 50 };

describe('validateLlmPayload visionModel', () => {
  it('accepts a valid visionModel slug', () => {
    const v = validateLlmPayload({ ...base, visionModel: 'google/gemini-2.5-flash' });
    expect(v.ok).toBe(true);
    expect(v.ok && v.value.visionModel).toBe('google/gemini-2.5-flash');
  });
  it('omits visionModel when empty string', () => {
    const v = validateLlmPayload({ ...base, visionModel: '' });
    expect(v.ok && 'visionModel' in v.value).toBe(false);
  });
  it('rejects a malformed visionModel', () => {
    const v = validateLlmPayload({ ...base, visionModel: 'not a slug!!' });
    expect(v.ok).toBe(false);
  });
});
