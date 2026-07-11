import { describe, it, expect, vi } from 'vitest';
import { mergeSyndicate, DEFAULT_SYNDICATE, SYNDICATE_CHANNEL_KEYS } from '../src/types';
import { validateCopy, copyGateErrors, buildCopy, COPY_CAPS, type SyndicationCopy } from '../src/syndicate/pack';
import { Blotato, blotatoFromEnv } from '../src/syndicate/blotato';
import type { Env } from '../src/types';
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

describe('Blotato client', () => {
  it('mirrorMedia returns the hosted url, null on failure', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ url: 'https://database.blotato.com/abc.jpg' }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    const b = new Blotato('k', f as unknown as typeof fetch);
    expect(await b.mirrorMedia('https://cdn.shopify.com/x.jpg')).toBe('https://database.blotato.com/abc.jpg');
    expect(await b.mirrorMedia('https://cdn.shopify.com/x.jpg')).toBeNull();
    const call = f.mock.calls[0];
    expect(call[0]).toBe('https://backend.blotato.com/v2/media');
    expect((call[1] as { headers: Record<string, string> }).headers['blotato-api-key']).toBe('k');
  });

  it('createPost returns the submission id; 4xx is permanent, 5xx/429 is not', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ postSubmissionId: 'sub-1' }) })
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ message: 'bad boardId' }) })
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ message: 'slow down' }) });
    const b = new Blotato('k', f as unknown as typeof fetch);
    const post = { accountId: 'a', text: 't', mediaUrls: [], platform: 'pinterest' as const, target: { targetType: 'pinterest' } };
    expect(await b.createPost(post)).toEqual({ ok: true, submissionId: 'sub-1' });
    expect(await b.createPost(post)).toEqual({ ok: false, error: 'bad boardId', permanent: true });
    expect(await b.createPost(post)).toEqual({ ok: false, error: 'slow down', permanent: false });
    const body = JSON.parse((f.mock.calls[0][1] as { body: string }).body);
    expect(body.post.content.platform).toBe('pinterest');
  });

  it('pollStatus maps the three states, null on transport error', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'published', publicUrl: 'https://pin.it/x' }) })
      .mockRejectedValueOnce(new Error('net'));
    const b = new Blotato('k', f as unknown as typeof fetch);
    expect(await b.pollStatus('sub-1')).toEqual({ status: 'published', errorMessage: undefined, publicUrl: 'https://pin.it/x' });
    expect(await b.pollStatus('sub-1')).toBeNull();
  });

  it('listAccounts/listPinterestBoards unwrap items[]', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [{ id: '98432', platform: 'pinterest', username: 'activepaw' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [{ id: 'board-1', name: 'Pet Care Guides' }] }) });
    const b = new Blotato('k', f as unknown as typeof fetch);
    expect((await b.listAccounts())![0].id).toBe('98432');
    expect((await b.listPinterestBoards('98432'))![0].id).toBe('board-1');
    expect(f.mock.calls[1][0]).toContain('/social/pinterest/boards?accountId=98432');
  });

  it('blotatoFromEnv is dormant without the secret', () => {
    expect(blotatoFromEnv({} as Env)).toBeNull();
    expect(blotatoFromEnv({ BLOTATO_API_KEY: 'k' } as Env)).not.toBeNull();
  });
});
