import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  findRedirect, createRedirect, deleteRedirect, pickRedirectTarget,
  isScopeDenial, buildArticleTargets, REDIRECT_FALLBACK, articleSeq
} from '../src/catalog/redirects';

const SHOP = 'test.myshopify.com';
beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

/** Shopify with a declared set of LIVE collection and product handles. Anything
 *  not listed resolves with onlineStoreUrl null, i.e. a 404 on the storefront. */
function shopify(live: { collections?: string[]; products?: string[] } = {}) {
  const cols = new Set(live.collections ?? []);
  const prods = new Set(live.products ?? []);
  const asked: string[] = [];
  const admin = (async (q: string, v: Record<string, string>) => {
    const handle = (v?.q ?? '').replace('handle:', '');
    if (q.includes('collections')) {
      asked.push(`collection:${handle}`);
      return { collections: { nodes: [{ handle, onlineStoreUrl: cols.has(handle) ? `https://x/collections/${handle}` : null }] } };
    }
    if (q.includes('products')) {
      asked.push(`product:${handle}`);
      return { products: { nodes: [{ handle, onlineStoreUrl: prods.has(handle) ? `https://x/products/${handle}` : null }] } };
    }
    return {};
  }) as never;
  return { admin, asked };
}

async function link(store: TenantStore, cjPid: string, over: Partial<{ handle: string; category: string; state: string }> = {}) {
  await store.putLink({
    cjPid, handle: over.handle ?? `h-${cjPid}`,
    category: over.category ?? 'pet-toys',
    state: (over.state ?? 'imported') as never,
    shopifyProductId: `gid://shopify/Product/${cjPid}`
  });
}

describe('pickRedirectTarget', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  it('NEVER points at a retired collection - the more-to-love case', async () => {
    // Measured 2026-07-31: 11 archived products carry category 'more-to-love',
    // a collection retired 2026-07-06 whose page is a hard 404 today. Deriving
    // the target from product_links alone would redirect dead URLs at a dead
    // URL. This is the regression test for that exact defect.
    await link(store, '1', { handle: 'dying', category: 'more-to-love' });
    const s = shopify({ collections: ['pet-toys'] }); // more-to-love NOT live
    expect((await pickRedirectTarget(store, s.admin, 'dying')).path).toBe(REDIRECT_FALLBACK);
  });

  it('prefers the CATEGORY COLLECTION over a live sibling product', async () => {
    // This order is the fix for what the 2026-08-01 dry run measured: with the
    // sibling first, all 112 dead URLs collapsed onto 7 product pages (one per
    // category), producing dog-multivitamins -> cat-water-fountain. Google reads
    // a redirect to an irrelevant page as a soft 404. The collection is the
    // honest target, so it wins even when a live sibling exists.
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    await link(store, '2', { handle: 'sibling', category: 'pet-toys' });
    const s = shopify({ products: ['sibling'], collections: ['pet-toys'] });
    expect((await pickRedirectTarget(store, s.admin, 'dying')).path).toBe('/collections/pet-toys');
  });

  it('falls back to a live sibling when the CATEGORY COLLECTION is dead', async () => {
    // more-to-love and addons are both 404 collections carrying real archived
    // products. A live sibling still beats /collections/all for those.
    await link(store, '1', { handle: 'dying', category: 'addons' });
    await link(store, '2', { handle: 'sibling', category: 'addons' });
    const s = shopify({ products: ['sibling'] }); // collection NOT live
    expect((await pickRedirectTarget(store, s.admin, 'dying')).path).toBe('/products/sibling');
  });

  it('ignores a sibling that is NOT on the storefront', async () => {
    // state='imported' only means WE think it is live; an unpublished product
    // carries that state too, so the storefront check is what decides.
    await link(store, '1', { handle: 'dying', category: 'addons' });
    await link(store, '2', { handle: 'sibling', category: 'addons' });
    const s = shopify({}); // neither collection nor sibling live
    expect((await pickRedirectTarget(store, s.admin, 'dying')).path).toBe(REDIRECT_FALLBACK);
  });

  it('never redirects a product to itself', async () => {
    // Collection dead, so the sibling branch is the one under test - otherwise
    // the collection would answer first and this would prove nothing.
    await link(store, '1', { handle: 'dying', category: 'addons' });
    const s = shopify({ products: ['dying'] });
    expect((await pickRedirectTarget(store, s.admin, 'dying')).path).toBe(REDIRECT_FALLBACK);
  });

  it('falls back to /collections/all when the link has no category', async () => {
    await link(store, '1', { handle: 'dying', category: undefined as never });
    const s = shopify({});
    expect((await pickRedirectTarget(store, s.admin, 'dying')).path).toBe(REDIRECT_FALLBACK);
  });

  it('treats an unverifiable target as unusable rather than assuming it is fine', async () => {
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    const boom = (async () => { throw new Error('admin down'); }) as never;
    expect((await pickRedirectTarget(store, boom, 'dying')).path).toBe(REDIRECT_FALLBACK);
  });

  it('ignores archived siblings - they are 404s themselves', async () => {
    // Category 'addons' so the collection cannot answer first; the archived
    // sibling must be rejected on its own merits, not masked by the collection.
    await link(store, '1', { handle: 'dying', category: 'addons' });
    await link(store, '2', { handle: 'gone', category: 'addons', state: 'archived' });
    const s = shopify({ products: ['gone'] });
    expect((await pickRedirectTarget(store, s.admin, 'dying')).path).toBe(REDIRECT_FALLBACK);
  });

  it('MEMOISES the shared COLLECTION question across a backfill run', async () => {
    // The per-product question legitimately differs on each call (a different
    // sibling each time), so the saving that matters is the collection check:
    // 112 archived URLs share a handful of categories between them, and without
    // the memo that same dead-collection question is asked 112 times.
    await link(store, '1', { handle: 'a', category: 'more-to-love' });
    await link(store, '2', { handle: 'b', category: 'more-to-love' });
    await link(store, '3', { handle: 'c', category: 'more-to-love' });
    const s = shopify({});
    const memo = new Map<string, boolean>();
    for (const h of ['a', 'b', 'c']) await pickRedirectTarget(store, s.admin, h, memo);
    expect(s.asked.filter((x) => x === 'collection:more-to-love')).toHaveLength(1);
  });

  it('without a memo, each call re-asks - so callers in a loop MUST pass one', async () => {
    await link(store, '1', { handle: 'a', category: 'more-to-love' });
    await link(store, '2', { handle: 'b', category: 'more-to-love' });
    const s = shopify({});
    await pickRedirectTarget(store, s.admin, 'a');
    await pickRedirectTarget(store, s.admin, 'b');
    expect(s.asked.filter((x) => x === 'collection:more-to-love')).toHaveLength(2);
  });
});

// The owner's rule (2026-08-01): an archived product URL lands on a CONGRUENT
// blog post, never a 404. A guide is a content page that can legitimately serve
// many products where a product page cannot, so it outranks both the collection
// and the sibling.
describe('blog-post redirect targets', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  /** Shopify returning one blog with the given articles. */
  function blogShopify(articles: { id: string; handle: string; isPublished: boolean }[], live: { collections?: string[]; products?: string[] } = {}) {
    const base = shopify(live);
    const admin = (async (q: string, v: Record<string, string>) => {
      if (q.includes('pawscoutRedirectArticles')) {
        return { blogs: { nodes: [{ handle: 'guides', articles: { nodes: articles, pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } };
      }
      return (base.admin as unknown as (a: string, b: Record<string, string>) => Promise<unknown>)(q, v);
    }) as never;
    return { admin, asked: base.asked };
  }

  const ART = [{ id: 'gid://shopify/Article/1', handle: 'best-cat-toys', isPublished: true }];

  it('prefers a guide that REFERENCED the product over anything inferred', async () => {
    // Exact congruence: the guard just repaired this guide because it
    // recommended this exact product. Nothing inferred can beat that.
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    const s = blogShopify(ART, { collections: ['pet-toys'] });
    const articles = await buildArticleTargets(store, s.admin);
    const t = await pickRedirectTarget(store, s.admin, 'dying', new Map(), {
      articles, preferArticleIds: ['gid://shopify/Article/1'],
    });
    expect(t.path).toBe('/blogs/guides/best-cat-toys');
    expect(t.tier).toBe('referring-guide');
  });

  it('uses the CATEGORY guide - derived from what each guide recommends', async () => {
    // No referrer for the dying product, but a sibling in its category is
    // recommended by the guide, which makes that guide the category's guide.
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    await link(store, '2', { handle: 'toy-in-guide', category: 'pet-toys' });
    await store.putProductReferrers('toy-in-guide', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/1' }]);
    const s = blogShopify(ART, { collections: ['pet-toys'] });
    const articles = await buildArticleTargets(store, s.admin);
    expect((await pickRedirectTarget(store, s.admin, 'dying', new Map(), { articles })).path).toBe('/blogs/guides/best-cat-toys');
  });

  it('a guide OUTRANKS the category collection', async () => {
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    await link(store, '2', { handle: 'toy-in-guide', category: 'pet-toys' });
    await store.putProductReferrers('toy-in-guide', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/1' }]);
    const s = blogShopify(ART, { collections: ['pet-toys'], products: ['toy-in-guide'] });
    const articles = await buildArticleTargets(store, s.admin);
    const t = await pickRedirectTarget(store, s.admin, 'dying', new Map(), { articles });
    expect(t.path).not.toBe('/collections/pet-toys');
    expect(t.path).toBe('/blogs/guides/best-cat-toys');
  });

  it('NEVER points at an unpublished draft - it has no storefront page', async () => {
    // Redirecting to a draft would manufacture the very 404 this prevents.
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    await link(store, '2', { handle: 'toy-in-guide', category: 'pet-toys' });
    await store.putProductReferrers('toy-in-guide', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/1' }]);
    const s = blogShopify([{ id: 'gid://shopify/Article/1', handle: 'draft-post', isPublished: false }], { collections: ['pet-toys'] });
    const articles = await buildArticleTargets(store, s.admin);
    expect(articles.byId.size).toBe(0);
    const t = await pickRedirectTarget(store, s.admin, 'dying', new Map(), {
      articles, preferArticleIds: ['gid://shopify/Article/1'],
    });
    expect(t.path).toBe('/collections/pet-toys');
  });

  it('falls through to the collection when NO guide covers the category', async () => {
    await link(store, '1', { handle: 'dying', category: 'pet-health' });
    const s = blogShopify(ART, { collections: ['pet-health'] });
    const articles = await buildArticleTargets(store, s.admin);
    expect((await pickRedirectTarget(store, s.admin, 'dying', new Map(), { articles })).path).toBe('/collections/pet-health');
  });

  it('NEVER 404s, even for a product that never belonged in the catalog', async () => {
    // Owner rule: no archived URL may 404. more-to-love is a dead collection
    // holding off-catalog junk, so every earlier step misses and the terminal
    // built-in has to answer.
    await link(store, '1', { handle: 'set-diamond-love-more-pendant', category: 'more-to-love' });
    const s = blogShopify(ART);
    const articles = await buildArticleTargets(store, s.admin);
    expect((await pickRedirectTarget(store, s.admin, 'set-diamond-love-more-pendant', new Map(), { articles })).path).toBe(REDIRECT_FALLBACK);
  });

  it('degrades to collection-then-fallback when the articles query FAILS', async () => {
    // Losing guide targets must not block an archive or produce a 404.
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    const base = shopify({ collections: ['pet-toys'] });
    const admin = (async (q: string, v: Record<string, string>) => {
      if (q.includes('pawscoutRedirectArticles')) throw new Error('blog api down');
      return (base.admin as unknown as (a: string, b: Record<string, string>) => Promise<unknown>)(q, v);
    }) as never;
    const articles = await buildArticleTargets(store, admin);
    expect(articles.byId.size).toBe(0);
    expect((await pickRedirectTarget(store, admin, 'dying', new Map(), { articles })).path).toBe('/collections/pet-toys');
  });

  it('picks the guide that recommends the MOST of a category, ties broken stably', async () => {
    await link(store, '1', { handle: 'a', category: 'pet-toys' });
    await link(store, '2', { handle: 'b', category: 'pet-toys' });
    await link(store, '3', { handle: 'dying', category: 'pet-toys' });
    await store.putProductReferrers('a', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/2' }]);
    await store.putProductReferrers('b', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/2' }]);
    const s = blogShopify([
      { id: 'gid://shopify/Article/1', handle: 'thin-post', isPublished: true },
      { id: 'gid://shopify/Article/2', handle: 'deep-post', isPublished: true },
    ], { collections: ['pet-toys'] });
    const articles = await buildArticleTargets(store, s.admin);
    expect(articles.byCategory.get('pet-toys')).toBe('/blogs/guides/deep-post');
  });
});

// A guide's brief already recorded the collection it was written against. Until
// 2026-08-02 nothing read it, and byCategory guessed a guide's subject from the
// products it happened to link. Measured against live data, that guess sent a
// guide about grooming brushes to the `more-to-love` junk category and left
// `pet-grooming` pointing at a nail guide.
describe('declared subject beats inference', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  function blogShopify(articles: { id: string; handle: string; isPublished: boolean }[], live: { collections?: string[] } = {}) {
    const base = shopify(live);
    return (async (q: string, v: Record<string, string>) => {
      if (q.includes('pawscoutRedirectArticles')) {
        return { blogs: { nodes: [{ handle: 'guides', articles: { nodes: articles, pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } };
      }
      return (base.admin as unknown as (a: string, b: Record<string, string>) => Promise<unknown>)(q, v);
    }) as never;
  }

  const draft = (store: TenantStore, id: string, articleId: string, collectionHandle: string | null) =>
    store.insertBlogPostDraft({
      id, shopifyArticleId: articleId, blogHandle: 'guides', title: 't',
      collectionHandle, briefJson: null, claimFlagsJson: null, model: null,
    });

  it('a guide claims its OWN collection even when it links nothing in it', async () => {
    // The real failure: the brush guide linked one pet-cleaning, one
    // pet-grooming and one more-to-love product. Inference alone can never say
    // "this is the grooming guide" from that.
    await draft(store, 'd1', 'gid://shopify/Article/10', 'pet-grooming');
    const admin = blogShopify([{ id: 'gid://shopify/Article/10', handle: 'brush-guide', isPublished: true }]);
    const articles = await buildArticleTargets(store, admin);
    expect(articles.byCategory.get('pet-grooming')).toBe('/blogs/guides/brush-guide');
  });

  it('a declared subject OUTRANKS a guide that merely links more of that category', async () => {
    await link(store, '1', { handle: 'a', category: 'pet-grooming' });
    await link(store, '2', { handle: 'b', category: 'pet-grooming' });
    await store.putProductReferrers('a', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/11' }]);
    await store.putProductReferrers('b', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/11' }]);
    await draft(store, 'd1', 'gid://shopify/Article/10', 'pet-grooming'); // declared, links none
    await draft(store, 'd2', 'gid://shopify/Article/11', 'pet-health');   // links 2, but is a health guide
    const admin = blogShopify([
      { id: 'gid://shopify/Article/10', handle: 'brush-guide', isPublished: true },
      { id: 'gid://shopify/Article/11', handle: 'health-guide', isPublished: true },
    ]);
    const articles = await buildArticleTargets(store, admin);
    expect(articles.byCategory.get('pet-grooming')).toBe('/blogs/guides/brush-guide');
  });

  it('a guide with a declared subject NEVER represents a different category', async () => {
    // This is the more-to-love bug: one stray linked product made a grooming
    // guide the guide for jewellery. No guide covering it is the honest answer.
    await link(store, '1', { handle: 'pendant', category: 'more-to-love' });
    await store.putProductReferrers('pendant', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/10' }]);
    await draft(store, 'd1', 'gid://shopify/Article/10', 'pet-grooming');
    const admin = blogShopify([{ id: 'gid://shopify/Article/10', handle: 'brush-guide', isPublished: true }]);
    const articles = await buildArticleTargets(store, admin);
    expect(articles.byCategory.has('more-to-love')).toBe(false);
    expect(articles.byCategory.get('pet-grooming')).toBe('/blogs/guides/brush-guide');
  });

  it('between two guides on the SAME subject the NEWEST wins, so commissioning one takes effect', async () => {
    // Both declare pet-grooming and link one product each - the exact live tie
    // where the older nail guide used to beat a brand new brush guide.
    await link(store, '1', { handle: 'a', category: 'pet-grooming' });
    await link(store, '2', { handle: 'b', category: 'pet-grooming' });
    await store.putProductReferrers('a', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/615250886994' }]);
    await store.putProductReferrers('b', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/615679295826' }]);
    await draft(store, 'd1', 'gid://shopify/Article/615250886994', 'pet-grooming');
    await draft(store, 'd2', 'gid://shopify/Article/615679295826', 'pet-grooming');
    const admin = blogShopify([
      { id: 'gid://shopify/Article/615250886994', handle: 'nail-guide', isPublished: true },
      { id: 'gid://shopify/Article/615679295826', handle: 'brush-guide', isPublished: true },
    ]);
    const articles = await buildArticleTargets(store, admin);
    expect(articles.byCategory.get('pet-grooming')).toBe('/blogs/guides/brush-guide');
  });

  it('an article with NO draft row still claims a category by inference', async () => {
    // Legacy / hand-written articles have no brief. They must keep working.
    await link(store, '1', { handle: 'a', category: 'pet-toys' });
    await store.putProductReferrers('a', [{ referrerType: 'blog', referrerId: 'gid://shopify/Article/9' }]);
    const admin = blogShopify([{ id: 'gid://shopify/Article/9', handle: 'legacy-post', isPublished: true }]);
    const articles = await buildArticleTargets(store, admin);
    expect(articles.byCategory.get('pet-toys')).toBe('/blogs/guides/legacy-post');
  });

  it('a DRAFT guide never claims a category, however it was declared', async () => {
    await draft(store, 'd1', 'gid://shopify/Article/10', 'pet-grooming');
    const admin = blogShopify([{ id: 'gid://shopify/Article/10', handle: 'brush-guide', isPublished: false }]);
    const articles = await buildArticleTargets(store, admin);
    expect(articles.byCategory.size).toBe(0);
  });
});

describe('articleSeq', () => {
  // Ordering GIDs as STRINGS silently inverts the moment ids gain a digit,
  // which would flip category winners for no visible reason.
  it('orders by numeric suffix, not lexicographically', () => {
    expect(articleSeq('gid://shopify/Article/100000000000'))
      .toBeGreaterThan(articleSeq('gid://shopify/Article/99999999999'));
    expect('gid://shopify/Article/100000000000' > 'gid://shopify/Article/99999999999').toBe(false);
  });
  it('is 0 for an unparseable id rather than NaN', () => {
    expect(articleSeq('nonsense')).toBe(0);
  });
});

describe('findRedirect', () => {
  it('requires an EXACT path match - the Shopify query is fuzzy', async () => {
    // A fuzzy hit on /products/cat-tree would otherwise be accepted as the
    // redirect for /products/cat-tree-88, silently skipping a real creation.
    const admin = (async () => ({ urlRedirects: { nodes: [{ id: 'g1', path: '/products/cat-tree', target: '/x' }] } })) as never;
    expect(await findRedirect(admin, '/products/cat-tree-88')).toBeNull();
  });

  it('returns the id on an exact match', async () => {
    const admin = (async () => ({ urlRedirects: { nodes: [{ id: 'g1', path: '/products/x', target: '/y' }] } })) as never;
    expect(await findRedirect(admin, '/products/x')).toEqual({ id: 'g1' });
  });
});

describe('createRedirect / deleteRedirect', () => {
  it('throws on userErrors so the caller cannot archive on a failed redirect', async () => {
    const admin = (async () => ({ urlRedirectCreate: { urlRedirect: null, userErrors: [{ message: 'path taken' }] } })) as never;
    await expect(createRedirect(admin, '/products/x', '/collections/all')).rejects.toThrow('path taken');
  });

  it('sends path and target as a UrlRedirectInput', async () => {
    let vars: Record<string, unknown> = {};
    const admin = (async (_q: string, v: Record<string, unknown>) => { vars = v; return { urlRedirectCreate: { userErrors: [] } }; }) as never;
    await createRedirect(admin, '/products/x', '/collections/all');
    expect(vars.urlRedirect).toEqual({ path: '/products/x', target: '/collections/all' });
  });

  it('deleteRedirect throws on userErrors', async () => {
    const admin = (async () => ({ urlRedirectDelete: { userErrors: [{ message: 'nope' }] } })) as never;
    await expect(deleteRedirect(admin, 'gid://1')).rejects.toThrow('nope');
  });
});

describe('isScopeDenial', () => {
  it('recognises a denial, so a dormant cull is not reported as a broken one', () => {
    expect(isScopeDenial('ACCESS_DENIED: write_online_store_navigation')).toBe(true);
    expect(isScopeDenial('App is not approved for this scope')).toBe(true);
  });

  it('does not swallow a genuine fault', () => {
    expect(isScopeDenial('502 Bad Gateway')).toBe(false);
    expect(isScopeDenial('path taken')).toBe(false);
  });
});
