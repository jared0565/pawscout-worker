import { describe, it, expect } from 'vitest';
import { validateGatesPayload, validateCollectionMap, MAX_COLLECTIONS } from '../src/validate';

const GOOD_GATES = { popularityFloor: 50, priceMin: 5, priceMax: 80, relevance: 'title' };

describe('validateGatesPayload', () => {
  it('accepts a valid payload and strips unknown fields', () => {
    const r = validateGatesPayload({ ...GOOD_GATES, evil: 'x' });
    expect(r).toEqual({ ok: true, value: { gates: GOOD_GATES, target: undefined } });
  });

  it('accepts an optional integer target within range', () => {
    const r = validateGatesPayload({ ...GOOD_GATES, target: 24 });
    expect(r.ok && r.value.target).toBe(24);
  });

  it.each([
    [null, 'not an object'],
    [[1, 2], 'array'],
    [{ ...GOOD_GATES, popularityFloor: -1 }, 'negative floor'],
    [{ ...GOOD_GATES, popularityFloor: 'high' }, 'non-numeric floor'],
    [{ ...GOOD_GATES, priceMin: NaN }, 'NaN priceMin'],
    [{ ...GOOD_GATES, priceMin: 90 }, 'priceMax < priceMin'],
    [{ ...GOOD_GATES, relevance: 'fuzzy' }, 'unknown relevance'],
    [{ ...GOOD_GATES, target: 0 }, 'target below 1'],
    [{ ...GOOD_GATES, target: 9999 }, 'target above cap'],
    [{ ...GOOD_GATES, target: 1.5 }, 'fractional target']
  ] as [unknown, string][])('rejects %j (%s)', (body: unknown) => {
    expect(validateGatesPayload(body).ok).toBe(false);
  });
});

describe('validateCollectionMap', () => {
  it('accepts a valid map and returns a clean copy', () => {
    const r = validateCollectionMap({ 'pet-toys': { handle: 'pet-toys', tag: 'cj-cat-pet-toys', extra: 1 } });
    expect(r).toEqual({ ok: true, value: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-cat-pet-toys' } } });
  });

  it('accepts an empty map (clears all mappings)', () => {
    expect(validateCollectionMap({})).toEqual({ ok: true, value: {} });
  });

  it.each([
    [null, 'not an object'],
    [{ 'Bad Key!': { handle: 'a', tag: 'b' } }, 'invalid key'],
    [{ k: 'string' }, 'entry not an object'],
    [{ k: { handle: 'UPPER', tag: 'ok' } }, 'invalid handle'],
    [{ k: { handle: 'ok', tag: '<script>' } }, 'invalid tag'],
    [{ k: { handle: 'ok' } }, 'missing tag'],
    [{ k: { handle: '-leading', tag: 'ok' } }, 'leading hyphen']
  ] as [unknown, string][])('rejects %j (%s)', (body: unknown) => {
    expect(validateCollectionMap(body).ok).toBe(false);
  });

  it('rejects a map with too many entries', () => {
    const big: Record<string, { handle: string; tag: string }> = {};
    for (let i = 0; i <= MAX_COLLECTIONS; i++) big[`c${i}`] = { handle: `c${i}`, tag: `t${i}` };
    expect(validateCollectionMap(big).ok).toBe(false);
  });
});
