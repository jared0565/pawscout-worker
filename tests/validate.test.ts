import { describe, it, expect } from 'vitest';
import { validateGatesPayload, validatePricingPayload, validateLlmPayload, validateAddonsPayload, validateCollectionMap, MAX_COLLECTIONS } from '../src/validate';

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

describe('validatePricingPayload', () => {
  const GOOD = { multiplier: 2.5, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2 };

  it('accepts a valid payload and strips unknown fields', () => {
    expect(validatePricingPayload({ ...GOOD, evil: 1 })).toEqual({ ok: true, value: GOOD });
  });

  it.each([
    [null, 'not an object'],
    [{ ...GOOD, multiplier: 0.5 }, 'multiplier below 1'],
    [{ ...GOOD, multiplier: 99 }, 'multiplier above 10'],
    [{ ...GOOD, floor: 'two' }, 'non-numeric floor'],
    [{ ...GOOD, minMarginGbp: -1 }, 'negative margin'],
    [{ ...GOOD, fxUsdToGbp: 0 }, 'zero FX rate'],
    [{ ...GOOD, fxBufferPct: 50 }, 'buffer above cap']
  ] as [unknown, string][])('rejects %j (%s)', (body: unknown) => {
    expect(validatePricingPayload(body).ok).toBe(false);
  });

  // Optional margin cap (2026-07-04): absent/null = no cap; when present it must
  // sit strictly above the minimum margin or the two clauses would fight.
  it('accepts an optional maxMarginGbp and carries it through', () => {
    expect(validatePricingPayload({ ...GOOD, maxMarginGbp: 30 }))
      .toEqual({ ok: true, value: { ...GOOD, maxMarginGbp: 30 } });
  });

  it('treats a null maxMarginGbp as "no cap" (console blank input)', () => {
    expect(validatePricingPayload({ ...GOOD, maxMarginGbp: null })).toEqual({ ok: true, value: GOOD });
  });

  it.each([
    [{ ...GOOD, maxMarginGbp: 'lots' }, 'non-numeric cap'],
    [{ ...GOOD, maxMarginGbp: 6 }, 'cap equal to the min margin'],
    [{ ...GOOD, maxMarginGbp: 3 }, 'cap below the min margin'],
    [{ ...GOOD, maxMarginGbp: -10 }, 'negative cap'],
    [{ ...GOOD, maxMarginGbp: 99999 }, 'absurd cap above 10000']
  ] as [unknown, string][])('rejects %j (%s)', (body: unknown) => {
    expect(validatePricingPayload(body).ok).toBe(false);
  });
});

describe('validateLlmPayload', () => {
  const GOOD = { enabled: true, scoreThreshold: 60, models: {} };

  it('accepts a valid payload, with optional per-task model overrides', () => {
    expect(validateLlmPayload(GOOD)).toEqual({ ok: true, value: GOOD });
    const withText = validateLlmPayload({ ...GOOD, models: { text: 'openai/gpt-5-mini' } });
    expect(withText.ok && withText.value.models.text).toBe('openai/gpt-5-mini');
  });

  it.each([
    [null, 'not an object'],
    [{ ...GOOD, enabled: 'yes' }, 'non-boolean enabled'],
    [{ ...GOOD, scoreThreshold: 150 }, 'threshold above 100'],
    [{ ...GOOD, models: { text: 'no-slash' } }, 'not a vendor/model slug'],
    [{ ...GOOD, models: { image: '<script>' } }, 'bad override slug']
  ] as [unknown, string][])('rejects %j (%s)', (body: unknown) => {
    expect(validateLlmPayload(body).ok).toBe(false);
  });
});

describe('validateAddonsPayload', () => {
  const GOOD = { enabled: true, priceMinUsd: 0.5, priceMaxUsd: 5, poolSize: 12, suppressFromBrowse: true };
  it('accepts a clean band including a sub-$1 floor', () => {
    expect(validateAddonsPayload(GOOD)).toEqual({ ok: true, value: GOOD });
    expect(validateAddonsPayload({ ...GOOD, priceMinUsd: 0 }).ok).toBe(true);
  });
  it('rejects an inverted or out-of-range band', () => {
    expect(validateAddonsPayload({ ...GOOD, priceMaxUsd: 0.5 }).ok).toBe(false); // max <= min
    expect(validateAddonsPayload({ ...GOOD, priceMinUsd: -1 }).ok).toBe(false);
    expect(validateAddonsPayload({ ...GOOD, priceMaxUsd: 60 }).ok).toBe(false); // over cap
    expect(validateAddonsPayload({ ...GOOD, poolSize: 0 }).ok).toBe(false);
    expect(validateAddonsPayload({ ...GOOD, poolSize: 3.5 }).ok).toBe(false);
    expect(validateAddonsPayload({ ...GOOD, enabled: 'yes' }).ok).toBe(false);
    expect(validateAddonsPayload({ ...GOOD, suppressFromBrowse: 'no' }).ok).toBe(false);
  });
  it('strips unknown fields', () => {
    const r = validateAddonsPayload({ ...GOOD, evil: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(['enabled', 'poolSize', 'priceMaxUsd', 'priceMinUsd', 'suppressFromBrowse']);
  });
});

describe('validateCollectionMap', () => {
  it('accepts a valid map and returns a clean copy', () => {
    const r = validateCollectionMap({ 'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys', extra: 1 } });
    expect(r).toEqual({ ok: true, value: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' } } });
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
