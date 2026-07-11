import { describe, it, expect } from 'vitest';
import { mergeSyndicate, DEFAULT_SYNDICATE, SYNDICATE_CHANNEL_KEYS } from '../src/types';
import { validateCopy, copyGateErrors, buildCopy, COPY_CAPS, type SyndicationCopy } from '../src/syndicate/pack';
import type { TenantStore } from '../src/tenant-store';
import type { TenantConfig } from '../src/types';
import type { LlmClient } from '../src/llm';

describe('mergeSyndicate', () => {
  it('empty/corrupt blobs yield the full dormant default', () => {
    expect(mergeSyndicate('')).toEqual(DEFAULT_SYNDICATE);
    expect(mergeSyndicate('{')).toEqual(DEFAULT_SYNDICATE);
    expect(mergeSyndicate(null)).toEqual(DEFAULT_SYNDICATE);
    expect(mergeSyndicate('{}').channels.pinterest).toEqual({ enabled: false, auto: false });
  });
  it('saved partial blob merges per channel without losing siblings', () => {
    const syn = mergeSyndicate(JSON.stringify({ channels: { pinterest: { enabled: true, accountId: 'a1', boardId: 'b1' } } }));
    expect(syn.channels.pinterest).toEqual({ enabled: true, auto: false, accountId: 'a1', boardId: 'b1' });
    expect(syn.channels.facebook).toEqual({ enabled: false, auto: false });
    expect(syn.digest.mode).toBe('weekly');
  });
  it('channel keys are the stable registry', () => {
    expect(SYNDICATE_CHANNEL_KEYS).toEqual(['pinterest', 'facebook', 'instagram']);
  });
});

const GOOD_COPY = {
  pinTitle: 'How to keep your cat drinking enough water',
  pinDesc: 'Simple ways to get a reluctant cat drinking more, and what to look for in a fountain.',
  caption: 'Cats are famously bad at staying hydrated. Our new guide covers the why and the fixes.',
  teaser: 'Why cats under-drink, and what actually helps.',
  altText: 'A cat drinking from a pet water fountain'
};

const CFG = { llm: { enabled: true, scoreThreshold: 60, models: {} } } as unknown as TenantConfig;

describe('syndication copy gates', () => {
  it('accepts clean copy and sanitizes dashes', () => {
    const v = validateCopy({ ...GOOD_COPY, teaser: 'Why cats under-drink — and what helps.' });
    expect(v).not.toBeNull();
    expect(v!.teaser).not.toContain('—');
  });
  it('rejects prices in any field (pins outlive repricing)', () => {
    expect(validateCopy({ ...GOOD_COPY, caption: 'Fountains from £12.99 in stock now' })).toBeNull();
    expect(copyGateErrors({ ...GOOD_COPY, pinDesc: 'now only 9.99 GBP' } as SyndicationCopy).join(' ')).toContain('price');
  });
  it('rejects supplier brand tokens', () => {
    expect(validateCopy({ ...GOOD_COPY, caption: 'Our PawHut fountain guide' })).toBeNull();
  });
  it('brand tokens with regex metacharacters are escaped, not executed', () => {
    // Verify no exception is thrown when building regex with unescaped metacharacters
    expect(() => copyGateErrors(GOOD_COPY as SyndicationCopy, ['Broken(Paren'])).not.toThrow();
    expect(() => copyGateErrors(GOOD_COPY as SyndicationCopy, ['Brand+Meta[char]'])).not.toThrow();
    // Verify normal brand detection still works
    const errs = copyGateErrors({ ...GOOD_COPY, caption: 'Our PawHut brand guide' } as SyndicationCopy, ['PawHut']);
    expect(errs.join(' ')).toContain('supplier brand');
  });
  it('rejects missing fields and over-cap lengths', () => {
    expect(validateCopy({ ...GOOD_COPY, altText: '' })).toBeNull();
    expect(validateCopy({ ...GOOD_COPY, pinTitle: 'x'.repeat(COPY_CAPS.pinTitle + 1) })).toBeNull();
    expect(validateCopy(null)).toBeNull();
    expect(validateCopy({})).toBeNull();
  });
});

describe('buildCopy', () => {
  const storeOf = (calls: unknown[][]) => ({
    logLlmUsage: async (...a: unknown[]) => { calls.push(a); }
  }) as unknown as TenantStore;

  it('returns validated copy and logs usage under blog-syndication-copy', async () => {
    const calls: unknown[][] = [];
    const llm = {
      jsonChain: async (opts: { validate: (v: unknown) => unknown }) =>
        ({ ok: true, value: opts.validate(GOOD_COPY), usage: { provider: 'openrouter', model: 'm', promptTokens: 10, completionTokens: 20, costUsd: 0.001 } })
    } as unknown as LlmClient;
    const out = await buildCopy(llm, storeOf(calls), CFG, { articleTitle: 'Cat hydration', collectionHandle: 'pet-health', productTitles: ['Pet Water Fountain 2L'] });
    expect(out).toEqual(expect.objectContaining({ pinTitle: GOOD_COPY.pinTitle }));
    expect(calls[0][0]).toBe('blog-syndication-copy');
  });
  it('degrades to null on chain failure without logging', async () => {
    const calls: unknown[][] = [];
    const llm = { jsonChain: async () => ({ ok: false, error: 'exhausted' }) } as unknown as LlmClient;
    expect(await buildCopy(llm, storeOf(calls), CFG, { articleTitle: 'T', collectionHandle: null, productTitles: [] })).toBeNull();
    expect(calls.length).toBe(0);
  });
});
