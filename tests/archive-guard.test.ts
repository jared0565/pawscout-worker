import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { archiveProductGuarded, writesArchivedStatus, indexUsable, INDEX_MAX_AGE_MS } from '../src/catalog/archive-guard';
import type { ArticleTargets } from '../src/catalog/redirects';

const SHOP = 'test.myshopify.com';
const noopAdmin = async () => ({});

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

/** A complete, just-built index. Every archive attempt in the real system runs
 *  after the nightly referrer-index stage, so a test that omits this is testing
 *  the dormant path, not the guard. */
async function freshIndex(store: TenantStore, over: Partial<{ truncated: boolean; ageMs: number }> = {}) {
  await store.putReferrerIndexStamp({
    indexedAt: new Date(Date.now() - (over.ageMs ?? 0)).toISOString(),
    articleCount: 3, rowCount: 5, truncated: over.truncated ?? false,
  });
  await catalogued(store, 'unreferenced-item', 'watched', 'x', 'old-tree', 'pick-only', 'only-tree', 'posted-item', 'cat-tree-88');
}


/** Guides covering the categories these tests use.
 *
 *  Since the owner's ruling of 2026-08-01 an archive REQUIRES a congruent blog
 *  post, so a test that omits this exercises the guide gate rather than
 *  whatever it meant to test. Both referrer ids the tests use are present, so
 *  the gate passes and the refusal under test is the one that fires. */
const GUIDES: ArticleTargets = {
  byId: new Map([
    ['indoor-cat-boredom', '/blogs/guides/g1'],
    ['gid://shopify/Article/1', '/blogs/guides/g1'],
  ]),
  byCategory: new Map([['pet-toys', '/blogs/guides/g1']]),
  truncated: false,
};

/** Give the handles these tests archive a catalogue row in a covered category.
 *  A real product always carries one; without it there is no category to match
 *  a guide on and every archive refuses. */
async function catalogued(store: TenantStore, ...handles: string[]) {
  for (const h of handles) {
    await store.putLink({
      cjPid: `c-${h}`, handle: h, category: 'pet-toys',
      state: 'imported' as never, shopifyProductId: `gid://shopify/Product/c-${h}`,
    });
  }
}

/** A fake Shopify that records the ORDER of the calls that matter. */
function redirectAdmin(over: { createFails?: string; existing?: boolean } = {}) {
  const calls: string[] = [];
  const admin = async (q: string, _v?: unknown) => {
    if (q.includes('urlRedirectCreate')) {
      calls.push('redirect');
      if (over.createFails) return { urlRedirectCreate: { urlRedirect: null, userErrors: [{ message: over.createFails }] } };
      return { urlRedirectCreate: { urlRedirect: { id: 'gid://shopify/UrlRedirect/1' }, userErrors: [] } };
    }
    if (q.includes('productUpdate')) { calls.push('archive'); return { productUpdate: { product: { id: 'p' }, userErrors: [] } }; }
    if (q.includes('urlRedirects')) {
      calls.push('find');
      return over.existing
        ? { urlRedirects: { nodes: [{ id: 'gid://shopify/UrlRedirect/9', path: '/products/unreferenced-item', target: '/x' }] } }
        : { urlRedirects: { nodes: [] } };
    }
    if (q.includes('collections')) return { collections: { nodes: [] } };
    if (q.includes('products')) return { products: { nodes: [] } };
    return {};
  };
  return { admin: admin as never, calls };
}

describe('archiveProductGuarded', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  it('REFUSES to archive a product a blog article references', async () => {
    await freshIndex(store);
    await store.putProductReferrers('cat-tree-88', [
      { referrerType: 'blog', referrerId: 'indoor-cat-boredom' },
    ]);
    const out = await archiveProductGuarded(noopAdmin, store, {
      cjPid: '1', productId: 'gid://shopify/Product/1', handle: 'cat-tree-88', reason: 'cull', articles: GUIDES,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.refusal).toBe('referenced');
      expect(out.detail).toContain('indoor-cat-boredom');
    }
  });

  it('refuses with missing-scope (not a generic abort) when Shopify denies the scope', async () => {
    // No longer the standing outcome - the scope was granted 2026-07-31. This
    // now pins that a REAL denial is still classified as configuration rather
    // than as a fault, which is what tells the reader where to go.
    await freshIndex(store);
    const denying = async () => { throw new Error('ACCESS_DENIED: write_online_store_navigation required'); };
    const out = await archiveProductGuarded(denying as never, store, {
      cjPid: '2', productId: 'gid://shopify/Product/2', handle: 'unreferenced-item', reason: 'cull', articles: GUIDES,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.refusal).toBe('missing-scope');
      expect(out.detail).toContain('write_online_store_navigation');
    }
  });

  it('never calls Shopify when it refuses', async () => {
    let called = 0;
    const admin = async () => { called++; return {}; };
    await freshIndex(store);
    await store.putProductReferrers('watched', [{ referrerType: 'blog', referrerId: 'g' }]);
    await archiveProductGuarded(admin, store, {
      cjPid: '3', productId: 'gid://shopify/Product/3', handle: 'watched', reason: 'cull', articles: GUIDES,
    });
    expect(called).toBe(0);
  });
});

// Vite inlines these file contents as strings at build time (?raw) - no node:fs,
// which workerd does not implement. Mirrors the pattern in tests/guard.test.ts.
declare global {
  interface ImportMeta {
    glob(pattern: string, opts: { query?: string; eager?: boolean; import?: string }): Record<string, string>;
  }
}
const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', eager: true, import: 'default' });

describe('single archive door', () => {
  it('only archive-guard.ts writes status ARCHIVED', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0); // fail loudly if the glob matched nothing
    const offenders = Object.entries(sources)
      .filter(([p]) => !p.endsWith('catalog/archive-guard.ts'))
      .filter(([, src]) => writesArchivedStatus(src))
      .map(([p]) => p);
    expect(offenders, `archive outside the guard: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('archive tripwire', () => {
  it('flags a real ARCHIVED status write but not an innocent state comparison', () => {
    // Positive controls: genuine archive mutations must be caught.
    expect(writesArchivedStatus(`admin(M, { input: { id, status: 'ARCHIVED' } })`)).toBe(true);
    expect(writesArchivedStatus(`status: "ARCHIVED"`)).toBe(true);
    expect(writesArchivedStatus(`{ input: { id: pid, status:'ARCHIVED' } }`)).toBe(true);

    // Negative controls. These appear throughout src/ and are innocent - this
    // repo already lost time to a guard regex that was too broad (guard.test.ts
    // matched `.exec(` and flagged RegExp.exec as raw D1 access). The fix there
    // was to narrow the TEST, not to "fix" the innocent source.
    expect(writesArchivedStatus(`if (link.state === 'archived') return;`)).toBe(false);
    expect(writesArchivedStatus(`// archived under the CURRENT rules`)).toBe(false);
    expect(writesArchivedStatus(`state: 'ghost' | 'imported' | 'archived'`)).toBe(false);
    expect(writesArchivedStatus(`await store.putLink({ cjPid, state: 'archived' })`)).toBe(false);
    expect(writesArchivedStatus(`WHERE pl.state = 'archived'`)).toBe(false);
  });
});

// THE MISS-MEANS-UNKNOWN INVARIANT.
//
// referrersFor() returning [] has two causes with opposite meanings: the product
// really is unreferenced, or the index never saw the article that references it.
// Only the stamp tells them apart, and without it the guard degrades from a 404
// preventer into a 404 generator the moment the redirect scope lands and
// missing-scope stops masking everything.
describe('indexUsable', () => {
  const now = Date.parse('2026-07-31T12:00:00Z');
  const stamp = (over: Partial<{ indexedAt: string; truncated: boolean }> = {}) =>
    ({ indexedAt: '2026-07-31T04:00:00Z', truncated: false, ...over });

  it('accepts a complete index built inside the window', () => {
    expect(indexUsable(stamp(), now).ok).toBe(true);
  });

  it('rejects a NEVER-BUILT index', () => {
    const r = indexUsable(null, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('never been built');
  });

  it('rejects a TRUNCATED index even when it is fresh', () => {
    const r = indexUsable(stamp({ indexedAt: new Date(now).toISOString(), truncated: true }), now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('truncated');
  });

  it('rejects a STALE index and names the age', () => {
    const old = new Date(now - INDEX_MAX_AGE_MS - 60_000).toISOString();
    const r = indexUsable(stamp({ indexedAt: old }), now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('stale');
  });

  it('tolerates ONE skipped nightly run but not two', () => {
    // 24h = a single missed run, still trusted. 48h = two, refused.
    expect(indexUsable(stamp({ indexedAt: new Date(now - 24 * 3600_000).toISOString() }), now).ok).toBe(true);
    expect(indexUsable(stamp({ indexedAt: new Date(now - 48 * 3600_000).toISOString() }), now).ok).toBe(false);
  });

  it('rejects an unparseable timestamp rather than treating NaN as fresh', () => {
    const r = indexUsable(stamp({ indexedAt: 'not-a-date' }), now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('unreadable');
  });
});

describe('archiveProductGuarded index gate', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  const attempt = () => archiveProductGuarded(noopAdmin, store, {
    cjPid: '9', productId: 'gid://shopify/Product/9', handle: 'unreferenced-item', reason: 'cull', articles: GUIDES,
  });

  it('refuses an UNREFERENCED product when the index was never built', async () => {
    // The dangerous case: nothing in product_referrers, so the naive read is
    // "safe to archive". It is not - the index simply does not know yet.
    const out = await attempt();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('index-incomplete');
  });

  it('refuses on a truncated index', async () => {
    await freshIndex(store, { truncated: true });
    const out = await attempt();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('index-incomplete');
  });

  it('refuses on a stale index', async () => {
    await freshIndex(store, { ageMs: INDEX_MAX_AGE_MS + 60_000 });
    const out = await attempt();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('index-incomplete');
  });

  it('gets PAST the index gate once the stamp is good', async () => {
    // Proves the gate is a gate and not a permanent block: with a good stamp
    // and no referrers, the archive now completes.
    await freshIndex(store);
    const out = await archiveProductGuarded(redirectAdmin().admin, store, {
      cjPid: '9', productId: 'gid://shopify/Product/9', handle: 'unreferenced-item', reason: 'cull', articles: GUIDES,
    });
    expect(out.ok).toBe(true);
  });

  it('checks the index BEFORE calling Shopify', async () => {
    let called = 0;
    const admin = async () => { called++; return {}; };
    await archiveProductGuarded(admin, store, {
      cjPid: '9', productId: 'gid://shopify/Product/9', handle: 'x', reason: 'cull', articles: GUIDES,
    });
    expect(called).toBe(0);
  });
});

// THE ORDER IS THE WHOLE POINT. Archiving before the redirect exists opens a
// window in which the URL 404s, and a crash inside that window leaves it 404ing
// forever. These pin the sequence, not just the outcome.
describe('redirect-before-archive', () => {
  let store: TenantStore;
  beforeEach(async () => { store = new TenantStore(env.DB, SHOP); await freshIndex(store); });

  const go = (admin: never) => archiveProductGuarded(admin, store, {
    cjPid: '9', productId: 'gid://shopify/Product/9', handle: 'unreferenced-item', reason: 'cull', articles: GUIDES,
  });

  it('creates the redirect BEFORE it archives', async () => {
    const f = redirectAdmin();
    expect((await go(f.admin)).ok).toBe(true);
    expect(f.calls.indexOf('redirect')).toBeLessThan(f.calls.indexOf('archive'));
  });

  it('does NOT archive when redirect creation fails', async () => {
    const f = redirectAdmin({ createFails: 'boom' });
    const out = await go(f.admin);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('redirect-failed');
    expect(f.calls).not.toContain('archive');
  });

  it('is IDEMPOTENT - an existing redirect is reused, never duplicated', async () => {
    const f = redirectAdmin({ existing: true });
    expect((await go(f.admin)).ok).toBe(true);
    expect(f.calls).not.toContain('redirect'); // no second create
    expect(f.calls).toContain('archive');
  });

  it('classifies a scope denial as configuration, a fault as redirect-failed', async () => {
    const denied = await go((async () => { throw new Error('ACCESS_DENIED'); }) as never);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.refusal).toBe('missing-scope');

    const broke = await go((async () => { throw new Error('502 upstream'); }) as never);
    expect(broke.ok).toBe(false);
    if (!broke.ok) expect(broke.refusal).toBe('redirect-failed');
  });

  it('still refuses a REFERENCED product without touching redirects at all', async () => {
    await store.putProductReferrers('unreferenced-item', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/1' }]);
    const f = redirectAdmin();
    const out = await go(f.admin);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('referenced');
    expect(f.calls).toEqual([]);
  });
});

// TASK 12: the owner's central requirement - a product mentioned in a guide is
// REPLACED with a live product, not merely refused. Refusal is the fallback,
// never the default, and the product stays live whenever repair is impossible.
describe('replace-in-article before archiving', () => {
  let store: TenantStore;
  beforeEach(async () => { store = new TenantStore(env.DB, SHOP); await freshIndex(store); });

  const ART = 'gid://shopify/Article/1';

  function deps(over: Partial<{
    body: string; picks: string[]; candidates: { title: string; handle: string; path: string }[];
    healed: string; missingArticle: boolean;
  }> = {}) {
    const savedBodies: string[] = [];
    const savedPicks: string[][] = [];
    const d = {
      loadArticle: async () => over.missingArticle ? null : ({
        title: 'Guide A',
        bodyHtml: over.body ?? '<p><a href="/products/old-tree">tall tree</a></p>',
        tags: ['pet-toys'],
        relatedHandles: over.picks ?? [],
      }),
      saveArticle: async (_id: string, body: string) => { savedBodies.push(body); },
      saveRelated: async (_id: string, h: string[]) => { savedPicks.push(h); },
      liveCandidates: async () => over.candidates ?? [{ title: 'New Tree', handle: 'new-tree', path: '/products/new-tree' }],
      healBody: async () => ({ body: over.healed ?? '<p><a href="/products/new-tree">tall tree</a></p>', samples: [] }),
    };
    return { d, savedBodies, savedPicks };
  }

  const go = (admin: never, d?: unknown, handle = 'old-tree') => archiveProductGuarded(admin, store, {
    cjPid: '20', productId: 'gid://shopify/Product/20', handle, reason: 'cull', articles: GUIDES,
  }, d as never);

  it('REPLACES the product in the article body, then archives', async () => {
    await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: ART }]);
    const f = redirectAdmin();
    const x = deps();
    const out = await go(f.admin, x.d);
    expect(out.ok).toBe(true);
    expect(x.savedBodies[0]).toContain('/products/new-tree');
    expect(x.savedBodies[0]).not.toContain('/products/old-tree');
  });

  it('saves the article BEFORE it archives', async () => {
    // If the archive later fails the guide is already honest and the archive
    // retries. The reverse order leaves a live guide pointing at a 404.
    await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: ART }]);
    const order: string[] = [];
    const f = redirectAdmin();
    const inner = f.admin as unknown as (a: string, b?: unknown) => Promise<unknown>;
    const admin = (async (q: string, v?: unknown) => { if (q.includes('productUpdate')) order.push('archive'); return inner(q, v); }) as never;
    const x = deps();
    const d = { ...x.d, saveArticle: async () => { order.push('save-article'); } };
    await go(admin, d);
    expect(order).toEqual(['save-article', 'archive']);
  });

  it('REFUSES when there are no live candidates - the product stays live', async () => {
    await store.putProductReferrers('only-tree', [{ referrerType: 'blog', referrerId: ART }]);
    const x = deps({ body: '<a href="/products/only-tree">t</a>', candidates: [] });
    const d = { ...x.d, saveArticle: async () => { throw new Error('must not save'); } };
    const out = await go(redirectAdmin().admin, d, 'only-tree');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('no-replacement');
  });

  it('REFUSES when the heal leaves the dead link in place', async () => {
    await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: ART }]);
    const x = deps({ healed: '<a href="/products/old-tree">tall tree</a>' });
    const out = await go(redirectAdmin().admin, x.d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('no-replacement');
  });

  it('REFUSES when the heal UNWRAPPED the link instead of relinking it', async () => {
    // Losing the anchor silently strips the shopping route out of a published
    // guide. Removing the 404 is not the same as replacing the product.
    await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: ART }]);
    const x = deps({ healed: '<p>tall tree</p>' });
    const out = await go(redirectAdmin().admin, x.d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain('removed the link');
  });

  it('replaces a curated SHOP-BLOCK pick even when the body never linked it', async () => {
    // A product can be referenced ONLY by the metafield. Healing the body alone
    // would archive a product that is still a visible pick in the guide.
    await store.putProductReferrers('pick-only', [{ referrerType: 'blog', referrerId: ART }]);
    const x = deps({ body: '<p>no product links here</p>', picks: ['pick-only', 'keep-me'] });
    const out = await go(redirectAdmin().admin, x.d, 'pick-only');
    expect(out.ok).toBe(true);
    expect(x.savedBodies).toEqual([]);
    expect(x.savedPicks[0]).toEqual(['new-tree', 'keep-me']);
  });

  it('does not duplicate a pick when the replacement is already in the block', async () => {
    await store.putProductReferrers('pick-only', [{ referrerType: 'blog', referrerId: ART }]);
    const x = deps({ body: '<p>none</p>', picks: ['pick-only', 'new-tree'] });
    await go(redirectAdmin().admin, x.d, 'pick-only');
    expect(x.savedPicks[0]).toEqual(['new-tree']);
  });

  it('a STALE referrer row does not block - the guide already moved on', async () => {
    await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: ART }]);
    const x = deps({ body: '<p>this guide links nothing</p>', picks: [] });
    const out = await go(redirectAdmin().admin, x.d);
    expect(out.ok).toBe(true);
    expect(x.savedBodies).toEqual([]);
  });

  it('a DELETED article does not block', async () => {
    await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: ART }]);
    const out = await go(redirectAdmin().admin, deps({ missingArticle: true }).d);
    expect(out.ok).toBe(true);
  });

  it('refuses a NON-BLOG referrer outright - we cannot edit an off-platform post', async () => {
    await store.putProductReferrers('posted-item', [{ referrerType: 'syndication', referrerId: 'syn-1' }]);
    const out = await go(redirectAdmin().admin, deps().d, 'posted-item');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('referenced');
  });

  it('WITHOUT deps a referenced product is still refused, never archived', async () => {
    // The owner console has no repair path. It must not silently archive.
    await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: ART }]);
    const f = redirectAdmin();
    const out = await archiveProductGuarded(f.admin, store, {
      cjPid: '20', productId: 'gid://shopify/Product/20', handle: 'old-tree', reason: 'console', articles: GUIDES,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('referenced');
    expect(f.calls).toEqual([]);
  });
});

// THE GUIDE GATE (owner ruling, 2026-08-01). A product is archived only when
// its URL can land on a congruent blog post; otherwise it stays live and the
// cull tries again once a guide covers the topic.
describe('the guide gate', () => {
  let store: TenantStore;
  beforeEach(async () => { store = new TenantStore(env.DB, SHOP); await freshIndex(store); });

  const NO_GUIDES: ArticleTargets = { byId: new Map(), byCategory: new Map(), truncated: false };

  it('REFUSES with no-guide, leaves the product live, and costs no API call', async () => {
    // Shopify-free by design: routing this through pathIsLive would swallow a
    // scope denial and report it as "no guide exists", sending the reader off
    // to write a blog post when the real fix is to grant a scope.
    const f = redirectAdmin();
    const out = await archiveProductGuarded(f.admin, store, {
      cjPid: '40', productId: 'gid://shopify/Product/40', handle: 'unreferenced-item',
      reason: 'cull', articles: NO_GUIDES,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('no-guide');
    expect(f.calls).toEqual([]);
  });

  it('gates BEFORE repairing the article - a refusal must not rewrite a guide', async () => {
    // Gating after the repair would edit a published guide to drop a product
    // and then decline to archive it, leaving the guide changed for nothing and
    // no longer recommending a product that is still live.
    await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/77' }]);
    const saved: string[] = [];
    const deps = {
      loadArticle: async () => ({ title: 'G', bodyHtml: '<a href="/products/old-tree">t</a>', tags: [], relatedHandles: [] }),
      saveArticle: async () => { saved.push('body'); },
      saveRelated: async () => { saved.push('related'); },
      liveCandidates: async () => [{ title: 'N', handle: 'new-tree', path: '/products/new-tree' }],
      healBody: async () => ({ body: '<a href="/products/new-tree">t</a>', samples: [] }),
    };
    const f = redirectAdmin();
    const out = await archiveProductGuarded(f.admin, store, {
      cjPid: '41', productId: 'gid://shopify/Product/41', handle: 'old-tree',
      reason: 'cull', articles: NO_GUIDES,
    }, deps as never);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('no-guide');
    expect(saved).toEqual([]);
  });

  it('a guide that REFERENCED the product satisfies the gate', async () => {
    // The strongest tier: this guide recommended this exact product, so it is
    // congruent by construction rather than inferred from a category.
    await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: 'indoor-cat-boredom' }]);
    const onlyById: ArticleTargets = { byId: GUIDES.byId, byCategory: new Map(), truncated: false };
    const deps = {
      loadArticle: async () => ({ title: 'G', bodyHtml: '<a href="/products/old-tree">t</a>', tags: [], relatedHandles: [] }),
      saveArticle: async () => {},
      saveRelated: async () => {},
      liveCandidates: async () => [{ title: 'N', handle: 'new-tree', path: '/products/new-tree' }],
      healBody: async () => ({ body: '<a href="/products/new-tree">t</a>', samples: [] }),
    };
    const f = redirectAdmin();
    const out = await archiveProductGuarded(f.admin, store, {
      cjPid: '42', productId: 'gid://shopify/Product/42', handle: 'old-tree',
      reason: 'cull', articles: onlyById,
    }, deps as never);
    expect(out.ok).toBe(true);
    expect(f.calls).toContain('archive');
  });
});
