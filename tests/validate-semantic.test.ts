import { describe, it, expect } from 'vitest';
import { validateSemanticPayload } from '../src/validate';

describe('validateSemanticPayload', () => {
  it('accepts defaults from an empty body', () => {
    const v = validateSemanticPayload({});
    expect(v.ok).toBe(true);
    expect(v.ok && v.value.enabled).toBe(true);
    expect(v.ok && v.value.maxExpansions).toBe(8);
    expect(v.ok && v.value.ttlDays).toBe(30);
    expect(v.ok && v.value.excludeCollections).toContain('more-to-love');
  });
  it('rejects out-of-range maxExpansions and ttlDays', () => {
    expect(validateSemanticPayload({ maxExpansions: 0 }).ok).toBe(false);
    expect(validateSemanticPayload({ maxExpansions: 51 }).ok).toBe(false);
    expect(validateSemanticPayload({ ttlDays: 0 }).ok).toBe(false);
    expect(validateSemanticPayload({ ttlDays: 999 }).ok).toBe(false);
  });
  it('validates and dedupes excludeCollections (must be a string array)', () => {
    expect(validateSemanticPayload({ excludeCollections: 'x' }).ok).toBe(false);
    expect(validateSemanticPayload({ excludeCollections: [1, 2] }).ok).toBe(false);
    const v = validateSemanticPayload({ excludeCollections: ['more-to-love', 'more-to-love', 'x'] });
    expect(v.ok && v.value.excludeCollections).toEqual(['more-to-love', 'x']);
  });
});
