import { describe, it, expect, vi } from 'vitest';
import { mergeSyndicate, DEFAULT_SYNDICATE, SYNDICATE_CHANNEL_KEYS } from '../src/types';
import { validateCopy, copyGateErrors, buildCopy, COPY_CAPS, type SyndicationCopy } from '../src/syndicate/pack';
import { Blotato, blotatoFromEnv } from '../src/syndicate/blotato';
import type { Env } from '../src/types';
import type { TenantStore } from '../src/tenant-store';
import type { TenantConfig } from '../src/types';
import type { LlmClient } from '../src/llm';
import { getArticlesForSyndication } from '../src/blog/article';
import type { AdminGraphql } from '../src/shopify-admin';

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

import { utmUrl, blotatoPostFor } from '../src/syndicate/channels';
import type { SyndicateChannelConfig } from '../src/types';

describe('channel payloads', () => {
  const copy = GOOD_COPY as SyndicationCopy;
  const IMG = 'https://database.blotato.com/abc.jpg';

  it('utmUrl carries source, medium and the guide campaign', () => {
    expect(utmUrl('cat-hydration', 'pinterest'))
      .toBe('https://activepaw.co.uk/blogs/guides/cat-hydration?utm_source=pinterest&utm_medium=social&utm_campaign=guide-cat-hydration');
  });

  it('pinterest: pin with board, title, utm link, alt and image', () => {
    const ch: SyndicateChannelConfig = { enabled: true, auto: false, accountId: 'a1', boardId: 'b1' };
    const p = blotatoPostFor('pinterest', ch, { copy, articleHandle: 'cat-hydration', imageUrl: IMG });
    expect(p).toEqual({
      accountId: 'a1', text: copy.pinDesc, mediaUrls: [IMG], platform: 'pinterest',
      target: { targetType: 'pinterest', boardId: 'b1', title: copy.pinTitle, link: utmUrl('cat-hydration', 'pinterest'), altText: copy.altText }
    });
  });

  it('facebook: link post (OG card carries the image), pageId required', () => {
    const ch: SyndicateChannelConfig = { enabled: true, auto: false, accountId: 'a2', pageId: 'pg9' };
    const p = blotatoPostFor('facebook', ch, { copy, articleHandle: 'cat-hydration', imageUrl: IMG });
    expect(p).toEqual({
      accountId: 'a2', text: copy.caption, mediaUrls: [], platform: 'facebook',
      target: { targetType: 'facebook', pageId: 'pg9', link: utmUrl('cat-hydration', 'facebook') }
    });
    expect(blotatoPostFor('facebook', { enabled: true, auto: false, accountId: 'a2' }, { copy, articleHandle: 'h', imageUrl: IMG }))
      .toEqual({ error: 'facebook channel has no pageId' });
  });

  it('instagram: image post, url rides in the caption text', () => {
    const ch: SyndicateChannelConfig = { enabled: true, auto: false, accountId: 'a3' };
    const p = blotatoPostFor('instagram', ch, { copy, articleHandle: 'cat-hydration', imageUrl: IMG });
    if ('error' in p) throw new Error(p.error);
    expect(p.mediaUrls).toEqual([IMG]);
    expect(p.text).toContain(utmUrl('cat-hydration', 'instagram'));
    expect(p.target).toEqual({ targetType: 'instagram' });
  });

  it('hard errors: no accountId, and no image where an image is required', () => {
    expect(blotatoPostFor('pinterest', { enabled: true, auto: false, boardId: 'b' }, { copy, articleHandle: 'h', imageUrl: IMG }))
      .toEqual({ error: 'channel has no connected accountId' });
    expect(blotatoPostFor('pinterest', { enabled: true, auto: false, accountId: 'a', boardId: 'b' }, { copy, articleHandle: 'h', imageUrl: null }))
      .toEqual({ error: 'no image available for a pin' });
    expect(blotatoPostFor('instagram', { enabled: true, auto: false, accountId: 'a' }, { copy, articleHandle: 'h', imageUrl: null }))
      .toEqual({ error: 'no image available for an instagram post' });
  });
});

describe('getArticlesForSyndication', () => {
  it('maps id -> handle/title/image/published; missing nodes absent', async () => {
    const admin = (async (_q: string, vars?: Record<string, unknown>) => {
      expect((vars as { ids: string[] }).ids).toEqual(['gid://shopify/Article/1', 'gid://shopify/Article/2']);
      return { nodes: [
        { id: 'gid://shopify/Article/1', handle: 'cat-hydration', title: 'Cat hydration', image: { url: 'https://cdn.shopify.com/h.jpg' }, isPublished: true },
        null
      ] };
    }) as unknown as AdminGraphql;
    const m = await getArticlesForSyndication(admin, ['gid://shopify/Article/1', 'gid://shopify/Article/2']);
    expect(m.get('gid://shopify/Article/1')).toEqual({ id: 'gid://shopify/Article/1', handle: 'cat-hydration', title: 'Cat hydration', imageUrl: 'https://cdn.shopify.com/h.jpg', isPublished: true });
    expect(m.has('gid://shopify/Article/2')).toBe(false);
    expect(await getArticlesForSyndication(admin, [])).toEqual(new Map());
  });
});

import { runSyndicationForShop, anyChannelEnabled, SYNDICATION_MAX_AUTO_ATTEMPTS } from '../src/syndicate/run';
import type { Env as WorkerEnv } from '../src/types';

function fakeSynStore() {
  const ledger = new Map<string, { post_id: string; channel: string; status: string; external_id: string | null; error: string | null; attempts: number; sent_at: string | null; updated_at: string }>();
  const packs = new Map<string, { post_id: string; article_handle: string | null; captions_json: string; pin_image_url: string | null; square_image_url: string | null; updated_at: string }>();
  const key = (p: string, c: string) => p + '|' + c;
  return {
    ledger, packs,
    logLlmUsage: async () => {},
    enqueueSyndication: async (p: string, c: string) => {
      if (ledger.has(key(p, c))) return false;
      ledger.set(key(p, c), { post_id: p, channel: c, status: 'queued', external_id: null, error: null, attempts: 0, sent_at: null, updated_at: 't' });
      return true;
    },
    listSyndicationLedger: async () => [...ledger.values()],
    markSyndication: async (p: string, c: string, patch: Record<string, unknown>) => {
      const row = ledger.get(key(p, c))!;
      if (patch.status !== undefined && patch.status !== null) row.status = patch.status as string;
      if (patch.externalId !== undefined && patch.externalId !== null) row.external_id = patch.externalId as string;
      row.error = (patch.error as string | null) ?? null;
      if (patch.sentAt !== undefined && patch.sentAt !== null) row.sent_at = patch.sentAt as string;
      if (patch.attempts !== undefined && patch.attempts !== null) row.attempts = patch.attempts as number;
    },
    claimSyndicationAttempt: async (p: string, c: string, expected: number) => {
      const row = ledger.get(key(p, c));
      if (!row || row.attempts !== expected) return false;
      row.attempts += 1;
      return true;
    },
    upsertSyndicationPack: async (p: { postId: string; articleHandle: string | null; captionsJson: string; pinImageUrl?: string | null }) => {
      packs.set(p.postId, { post_id: p.postId, article_handle: p.articleHandle, captions_json: p.captionsJson, pin_image_url: p.pinImageUrl ?? null, square_image_url: null, updated_at: 't' });
    },
    getSyndicationPack: async (p: string) => packs.get(p) ?? null
  };
}

const POST = { id: 'post-1', shopify_article_id: 'gid://shopify/Article/1', title: 'Cat hydration', status: 'published', collection_handle: 'pet-health', related_handles_json: '["fountain-2l"]', blog_handle: 'guides', brief_json: null, claim_flags_json: null, hero_image_url: null, hero_source_handle: null, created_at: 't' };
const ART = new Map([[POST.shopify_article_id, { id: POST.shopify_article_id, handle: 'cat-hydration', title: 'Cat hydration', imageUrl: 'https://cdn.shopify.com/h.jpg', isPublished: true }]]);

function synCfg(over: Record<string, Partial<SyndicateChannelConfig>>): TenantConfig {
  const syn = mergeSyndicate(JSON.stringify({ channels: over }));
  return { llm: { enabled: true, scoreThreshold: 60, models: {} }, syndicate: syn } as unknown as TenantConfig;
}

const okLlmEnv = {} as WorkerEnv; // engine receives llm via deps.blotato/copy fakes; env only feeds LlmClient keys

function fakeBlotato(sent: unknown[]) {
  return {
    mirrorMedia: async () => 'https://database.blotato.com/m.jpg',
    createPost: async (p: unknown) => { sent.push(p); return { ok: true as const, submissionId: 'sub-' + sent.length }; },
    pollStatus: async () => ({ status: 'published' as const })
  };
}

describe('runSyndicationForShop', () => {
  const deps = (store: ReturnType<typeof fakeSynStore>, blotato: unknown, copy = GOOD_COPY) => ({
    listPosts: async () => [POST],
    articles: async () => ART,
    blotato: blotato as never,
    copy: async () => copy as never
  });

  it('dormant when no channel is enabled', async () => {
    const store = fakeSynStore();
    const r = await runSyndicationForShop(okLlmEnv, store as never, synCfg({}), deps(store, null));
    expect(r).toEqual({ queued: 0, posted: 0, confirmed: 0, failed: 0 });
    expect(store.ledger.size).toBe(0);
  });

  it('enqueues one row per enabled channel, idempotently, manual channels stay queued', async () => {
    const store = fakeSynStore();
    const cfg = synCfg({ pinterest: { enabled: true, accountId: 'a', boardId: 'b' }, facebook: { enabled: true, accountId: 'a', pageId: 'p' } });
    const r1 = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, fakeBlotato([])));
    expect(r1.queued).toBe(2);
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('queued'); // auto off
    expect(store.ledger.has('post-1|instagram')).toBe(false);            // disabled channel: no row
    const r2 = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, fakeBlotato([])));
    expect(r2.queued).toBe(0); // idempotent
  });

  it('auto channel fires with the pack image + utm link and confirms to published', async () => {
    const store = fakeSynStore();
    const sent: { target: { link?: string }; mediaUrls: string[] }[] = [];
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const r1 = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, fakeBlotato(sent)));
    expect(r1.posted).toBe(1);
    expect(sent[0].mediaUrls).toEqual(['https://database.blotato.com/m.jpg']); // mirrored, not the Shopify url
    expect(sent[0].target.link).toContain('utm_source=pinterest');
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('sent');
    const r2 = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, fakeBlotato(sent)));
    expect(r2.confirmed).toBe(1);
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('published');
  });

  it('copy failure leaves rows queued with the error recorded', async () => {
    const store = fakeSynStore();
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const d = deps(store, fakeBlotato([]));
    (d as { copy: unknown }).copy = async () => null;
    const r = await runSyndicationForShop(okLlmEnv, store as never, cfg, d);
    expect(r.posted).toBe(0);
    const row = store.ledger.get('post-1|pinterest')!;
    expect(row.status).toBe('queued');
    expect(row.error).toContain('pack');
  });

  it('transient send failure bumps attempts and stops at the auto cap', async () => {
    const store = fakeSynStore();
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const failing = { ...fakeBlotato([]), createPost: async () => ({ ok: false as const, error: 'rate limited', permanent: false }) };
    for (let i = 0; i < SYNDICATION_MAX_AUTO_ATTEMPTS + 1; i++) {
      await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, failing));
    }
    const row = store.ledger.get('post-1|pinterest')!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(SYNDICATION_MAX_AUTO_ATTEMPTS); // capped, not 4
    expect(row.error).toContain('rate limited');
  });

  it('fire:false (console list route) enqueues and packs but never auto-sends', async () => {
    const store = fakeSynStore();
    const sent: unknown[] = [];
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const r = await runSyndicationForShop(okLlmEnv, store as never, cfg, { ...deps(store, fakeBlotato(sent)), fire: false });
    expect(r.queued).toBe(1);
    expect(r.posted).toBe(0);
    expect(sent.length).toBe(0);
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('queued');
  });

  it('a lost attempts claim aborts the send (double-post fence)', async () => {
    const store = fakeSynStore();
    const sent: unknown[] = [];
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const racingBlotato = {
      ...fakeBlotato(sent),
      // Simulate a concurrent actor winning between the sweep's ledger read and
      // its claim: bump attempts during the pack's media mirror.
      mirrorMedia: async () => { store.ledger.get('post-1|pinterest')!.attempts = 1; return 'https://database.blotato.com/m.jpg'; }
    };
    const r = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, racingBlotato));
    expect(r.posted).toBe(0);
    expect(sent.length).toBe(0); // the loser never posted
  });

  it('a disabled channel never auto-fires a surviving queued row (enabled unchecked after enqueue)', async () => {
    const store = fakeSynStore();
    const sent: unknown[] = [];
    await store.enqueueSyndication('post-1', 'pinterest'); // row queued while the channel was enabled
    // facebook stays enabled (auto:false) so the shop-level anyChannelEnabled
    // gate lets the sweep reach stage 3; pinterest's surviving queued row is
    // the one under test.
    const cfg = synCfg({
      pinterest: { enabled: false, auto: true, accountId: 'a', boardId: 'b' },
      facebook: { enabled: true, auto: false, accountId: 'a', pageId: 'p' }
    });
    const r = await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, fakeBlotato(sent)));
    expect(r.posted).toBe(0);
    expect(sent.length).toBe(0);
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('queued');
  });

  it('permanent send failure goes failed immediately; no blotato = queued untouched', async () => {
    const store = fakeSynStore();
    const cfg = synCfg({ pinterest: { enabled: true, auto: true, accountId: 'a', boardId: 'b' } });
    const perm = { ...fakeBlotato([]), createPost: async () => ({ ok: false as const, error: 'bad boardId', permanent: true }) };
    await runSyndicationForShop(okLlmEnv, store as never, cfg, deps(store, perm));
    expect(store.ledger.get('post-1|pinterest')!.status).toBe('failed');

    const store2 = fakeSynStore();
    const r = await runSyndicationForShop(okLlmEnv, store2 as never, cfg, deps(store2, null));
    expect(r.posted).toBe(0);
    expect(store2.ledger.get('post-1|pinterest')!.status).toBe('queued');
    expect(store2.ledger.get('post-1|pinterest')!.attempts).toBe(0);
  });
});

describe('anyChannelEnabled', () => {
  it('true only when at least one channel is enabled', () => {
    expect(anyChannelEnabled(mergeSyndicate('{}'))).toBe(false);
    expect(anyChannelEnabled(mergeSyndicate(JSON.stringify({ channels: { facebook: { enabled: true } } })))).toBe(true);
  });
});
