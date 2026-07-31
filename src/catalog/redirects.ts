/**
 * URL redirects: what stands in a product's place after it is archived.
 *
 * An archive without a redirect is a 404, and 404s at scale are what put this
 * whole project in motion (112 archived product URLs are 404ing in Google's
 * index today). So the guard creates the redirect FIRST and archives only if
 * that succeeded.
 *
 * THE TARGET MUST BE PROVEN LIVE, NOT INFERRED. `product_links.category` is a
 * local record, not a promise that a matching collection still exists: measured
 * 2026-07-31, 11 archived products carry category `more-to-love`, a collection
 * retired on 2026-07-06 whose page returns a hard 404 today (curl-verified
 * alongside the five that return 200). Deriving the target from D1 alone would
 * therefore point 11 dead URLs at another dead URL - the exact failure this
 * module exists to prevent, laundered through a redirect. Every candidate is
 * checked against Shopify before it is used.
 *
 * Requires read/write_online_store_navigation. Verified live 2026-07-31: the
 * worker's token can execute urlRedirects (see src/shopify-scopes.ts).
 */
import type { AdminGraphql } from '../shopify-admin';
import type { TenantStore } from '../tenant-store';

// Validated against the pinned 2026-04 Admin schema (shopify.dev, 2026-07-31):
// urlRedirectCreate takes urlRedirect: UrlRedirectInput! and returns
// { urlRedirect { id }, userErrors { field message } }.
const CREATE = `mutation pawscoutRedirectCreate($urlRedirect: UrlRedirectInput!) {
  urlRedirectCreate(urlRedirect: $urlRedirect) {
    urlRedirect { id }
    userErrors { field message }
  }
}`;

const DELETE = `mutation pawscoutRedirectDelete($id: ID!) {
  urlRedirectDelete(id: $id) { deletedRedirectId userErrors { field message } }
}`;

const FIND = `query pawscoutRedirectFind($q: String!) {
  urlRedirects(first: 10, query: $q) { nodes { id path target } }
}`;

// Same collections(first:, query:) shape the blog grounding already uses
// (src/blog/ground.ts:13). onlineStoreUrl is the 404 truth - null when the
// collection is unpublished from the Online Store, which is precisely the
// more-to-love case.
const COLLECTION_LIVE = `query pawscoutRedirectCollection($q: String!) {
  collections(first: 1, query: $q) { nodes { handle onlineStoreUrl } }
}`;

const PRODUCT_LIVE = `query pawscoutRedirectProduct($q: String!) {
  products(first: 1, query: $q) { nodes { handle onlineStoreUrl } }
}`;

/** Shopify's built-in catch-all. Verified 200 on the live storefront
 *  2026-07-31; it exists on every store and cannot be unpublished, which is
 *  what makes it a safe terminal fallback. */
export const REDIRECT_FALLBACK = '/collections/all';

/**
 * Does this error mean the scope is absent, rather than the call failing?
 *
 * Distinguishing the two decides whether the cull is DORMANT (a configuration
 * state the owner can fix) or BROKEN (a bug). Reporting one as the other sends
 * whoever reads the log to the wrong place entirely.
 */
export function isScopeDenial(message: string): boolean {
  return /ACCESS_DENIED|not approved|required access scope|write_online_store_navigation|read_online_store_navigation/i.test(message);
}

/** Existing redirect for a path, or null. The backfill MUST call this first or
 *  a re-run mints duplicates. Shopify's `query` is a fuzzy match, so the exact
 *  path is re-checked in code rather than trusted from the search. */
export async function findRedirect(admin: AdminGraphql, path: string): Promise<{ id: string } | null> {
  const data = await admin(FIND, { q: `path:${path}` }) as {
    urlRedirects?: { nodes?: { id: string; path: string }[] };
  };
  const hit = (data.urlRedirects?.nodes ?? []).find((n) => n.path === path);
  return hit ? { id: hit.id } : null;
}

export async function createRedirect(admin: AdminGraphql, path: string, target: string): Promise<void> {
  const data = await admin(CREATE, { urlRedirect: { path, target } }) as {
    urlRedirectCreate?: { userErrors?: { message: string }[] };
  };
  const errs = data.urlRedirectCreate?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

export async function deleteRedirect(admin: AdminGraphql, id: string): Promise<void> {
  const data = await admin(DELETE, { id }) as {
    urlRedirectDelete?: { userErrors?: { message: string }[] };
  };
  const errs = data.urlRedirectDelete?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/**
 * Per-run memo of "is this path reachable on the storefront?".
 *
 * The 112-URL backfill would otherwise re-ask the same handful of collection
 * questions 112 times. Scoped to one run and thrown away, so it can never go
 * stale between runs.
 */
export type LivenessMemo = Map<string, boolean>;

async function pathIsLive(admin: AdminGraphql, path: string, memo: LivenessMemo): Promise<boolean> {
  const cached = memo.get(path);
  if (cached !== undefined) return cached;
  let live = false;
  try {
    if (path === REDIRECT_FALLBACK) {
      live = true; // built-in, cannot be unpublished
    } else if (path.startsWith('/collections/')) {
      const handle = path.slice('/collections/'.length);
      const d = await admin(COLLECTION_LIVE, { q: `handle:${handle}` }) as {
        collections?: { nodes?: { handle?: string; onlineStoreUrl?: string | null }[] };
      };
      const n = (d.collections?.nodes ?? []).find((x) => x.handle === handle);
      live = !!n?.onlineStoreUrl;
    } else if (path.startsWith('/products/')) {
      const handle = path.slice('/products/'.length);
      const d = await admin(PRODUCT_LIVE, { q: `handle:${handle}` }) as {
        products?: { nodes?: { handle?: string; onlineStoreUrl?: string | null }[] };
      };
      const n = (d.products?.nodes ?? []).find((x) => x.handle === handle);
      live = !!n?.onlineStoreUrl;
    }
  } catch {
    live = false; // an unverifiable target is not an acceptable target
  }
  memo.set(path, live);
  return live;
}

/**
 * Where a dead product URL should point.
 *
 * Order: the most-engaged live sibling in the same category, then the category
 * collection, then /collections/all. Deterministic and LLM-free so the 112-URL
 * backfill is cheap and reproducible - but every candidate above the fallback
 * is confirmed against Shopify, because the local category record is exactly
 * what would otherwise send the more-to-love products to a 404.
 */
export async function pickRedirectTarget(
  store: TenantStore,
  admin: AdminGraphql,
  handle: string,
  memo: LivenessMemo = new Map()
): Promise<string> {
  const link = await store.getLinkByHandle(handle);
  const category = link?.category ?? null;
  if (category) {
    const best = await store.topLiveHandleInCategory(category, handle);
    if (best) {
      const p = `/products/${best}`;
      if (await pathIsLive(admin, p, memo)) return p;
    }
    const c = `/collections/${category}`;
    if (await pathIsLive(admin, c, memo)) return c;
  }
  return REDIRECT_FALLBACK;
}
