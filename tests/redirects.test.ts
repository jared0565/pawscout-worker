import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  findRedirect, createRedirect, deleteRedirect, pickRedirectTarget,
  isScopeDenial, isOffCatalogJunk, REDIRECT_FALLBACK
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
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe(REDIRECT_FALLBACK);
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
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe('/collections/pet-toys');
  });

  it('falls back to a live sibling when the CATEGORY COLLECTION is dead', async () => {
    // more-to-love and addons are both 404 collections carrying real archived
    // products. A live sibling still beats /collections/all for those.
    await link(store, '1', { handle: 'dying', category: 'addons' });
    await link(store, '2', { handle: 'sibling', category: 'addons' });
    const s = shopify({ products: ['sibling'] }); // collection NOT live
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe('/products/sibling');
  });

  it('ignores a sibling that is NOT on the storefront', async () => {
    // state='imported' only means WE think it is live; an unpublished product
    // carries that state too, so the storefront check is what decides.
    await link(store, '1', { handle: 'dying', category: 'addons' });
    await link(store, '2', { handle: 'sibling', category: 'addons' });
    const s = shopify({}); // neither collection nor sibling live
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe(REDIRECT_FALLBACK);
  });

  it('never redirects a product to itself', async () => {
    // Collection dead, so the sibling branch is the one under test - otherwise
    // the collection would answer first and this would prove nothing.
    await link(store, '1', { handle: 'dying', category: 'addons' });
    const s = shopify({ products: ['dying'] });
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe(REDIRECT_FALLBACK);
  });

  it('falls back to /collections/all when the link has no category', async () => {
    await link(store, '1', { handle: 'dying', category: undefined as never });
    const s = shopify({});
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe(REDIRECT_FALLBACK);
  });

  it('treats an unverifiable target as unusable rather than assuming it is fine', async () => {
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    const boom = (async () => { throw new Error('admin down'); }) as never;
    expect(await pickRedirectTarget(store, boom, 'dying')).toBe(REDIRECT_FALLBACK);
  });

  it('ignores archived siblings - they are 404s themselves', async () => {
    // Category 'addons' so the collection cannot answer first; the archived
    // sibling must be rejected on its own merits, not masked by the collection.
    await link(store, '1', { handle: 'dying', category: 'addons' });
    await link(store, '2', { handle: 'gone', category: 'addons', state: 'archived' });
    const s = shopify({ products: ['gone'] });
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe(REDIRECT_FALLBACK);
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

describe('isOffCatalogJunk', () => {
  // Redirecting a barber scissors to a pet page tells Google this shop sells
  // barber scissors. A 404 is the correct answer for a product that should
  // never have been imported, so these are deliberately left broken.
  it('excludes the whole more-to-love category - all 11 members are off-catalog', () => {
    expect(isOffCatalogJunk({ handle: 'set-diamond-love-more-pendant', category: 'more-to-love' })).toBe(true);
    expect(isOffCatalogJunk({ handle: 'household-vacuum-sealer-food-saver', category: 'more-to-love' })).toBe(true);
  });

  it('excludes the three junk handles filed under REAL pet categories', () => {
    // No category rule can reach these - they sit in pet-grooming, pet-health
    // and pet-cleaning alongside genuine products.
    expect(isOffCatalogJunk({ handle: 'barber-scissors', category: 'pet-grooming' })).toBe(true);
    expect(isOffCatalogJunk({ handle: 'hairdressing-scissors', category: 'pet-health' })).toBe(true);
    expect(isOffCatalogJunk({ handle: 'professional-scissors-sharpener-with-angle-adjustment', category: 'pet-cleaning' })).toBe(true);
  });

  it('does NOT exclude a genuine pet product', () => {
    expect(isOffCatalogJunk({ handle: 'dog-multivitamin-chews-with-glucosamine-probiotics', category: 'pet-health' })).toBe(false);
    expect(isOffCatalogJunk({ handle: 'pet-teeth-cleaning-powder-100g-1', category: 'pet-grooming' })).toBe(false);
  });

  it('survives a null handle or category rather than throwing', () => {
    expect(isOffCatalogJunk({})).toBe(false);
    expect(isOffCatalogJunk({ handle: null, category: null })).toBe(false);
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
