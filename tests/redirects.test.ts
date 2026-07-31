import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  findRedirect, createRedirect, deleteRedirect, pickRedirectTarget,
  isScopeDenial, REDIRECT_FALLBACK
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

  it('prefers the most-engaged live sibling in the same category', async () => {
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    await link(store, '2', { handle: 'sibling', category: 'pet-toys' });
    const s = shopify({ products: ['sibling'], collections: ['pet-toys'] });
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe('/products/sibling');
  });

  it('falls back to the collection when the sibling is NOT on the storefront', async () => {
    // state='imported' only means WE think it is live; an unpublished product
    // carries that state too, so the storefront check is what decides.
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    await link(store, '2', { handle: 'sibling', category: 'pet-toys' });
    const s = shopify({ collections: ['pet-toys'] }); // sibling not live
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe('/collections/pet-toys');
  });

  it('never redirects a product to itself', async () => {
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    const s = shopify({ products: ['dying'], collections: ['pet-toys'] });
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe('/collections/pet-toys');
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
    await link(store, '1', { handle: 'dying', category: 'pet-toys' });
    await link(store, '2', { handle: 'gone', category: 'pet-toys', state: 'archived' });
    const s = shopify({ products: ['gone'], collections: ['pet-toys'] });
    expect(await pickRedirectTarget(store, s.admin, 'dying')).toBe('/collections/pet-toys');
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
