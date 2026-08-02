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
 * Order: the category COLLECTION, then the most-engaged live sibling in that
 * category, then /collections/all. Deterministic and LLM-free so the 112-URL
 * backfill is cheap and reproducible - but every candidate above the fallback
 * is confirmed against Shopify, because the local category record is exactly
 * what would otherwise send the more-to-love products to a 404.
 *
 * COLLECTION FIRST, AND THAT ORDER IS LOAD-BEARING. It was sibling-first until
 * the backfill dry run measured what that actually produces (2026-08-01): all
 * 112 dead URLs collapsed onto SEVEN product pages, exactly one per category,
 * because topLiveHandleInCategory returns the same "top" product for every
 * member of a category. The mappings that fell out included dog multivitamins
 * -> cat water fountain and barber scissors -> cat water fountain. Google
 * treats a redirect to an irrelevant page as a soft 404, so consolidating at
 * 16-to-1 buys an index full of discounted redirects rather than a repair, and
 * it reads as manipulative consolidation on a store already under GMC
 * Misrepresentation review. The category page is the honest "this product is
 * gone, here is where it lived" signal.
 *
 * The sibling is kept as the SECOND choice rather than deleted, for a category
 * whose own collection is dead (more-to-love, addons - both curl-confirmed 404
 * on 2026-08-01). There a live product still beats /collections/all.
 *
 * Cheaper too, incidentally: the collection question is shared across a run and
 * memoised, so most products never trigger the per-product lookup at all.
 *
 * A BLOG POST OUTRANKS BOTH (owner rule, 2026-08-01). A guide is a content page
 * that can legitimately serve many products, where a product page cannot - so
 * "this product is gone, here is the guide that covers it" is a claim that
 * stays true, and it is the one destination that reads as an answer rather than
 * a dead end. `preferArticleIds` is the guard handing over the guides it just
 * repaired, which is exact congruence; the category guide is inferred.
 *
 * NEVER RETURNS A 404, by owner instruction. /collections/all is a Shopify
 * built-in that cannot be unpublished, so the chain always terminates somewhere
 * live even for products that never belonged in the catalog.
 */
export async function pickRedirectTarget(
  store: TenantStore,
  admin: AdminGraphql,
  handle: string,
  memo: LivenessMemo = new Map(),
  ctx: { articles?: ArticleTargets | null; preferArticleIds?: string[] } = {}
): Promise<RedirectChoice> {
  const link = await store.getLinkByHandle(handle);

  // 1 and 2 - see pickGuideTarget.
  const guide = pickGuideTarget(link, ctx.articles ?? null, ctx.preferArticleIds);
  if (guide) return guide;

  const category = link?.category ?? null;
  if (category) {
    // 3. The category collection.
    const c = `/collections/${category}`;
    if (await pathIsLive(admin, c, memo)) return { path: c, tier: 'collection' };

    // 4. A live sibling, for a category whose own collection is dead.
    const best = await store.topLiveHandleInCategory(category, handle);
    if (best) {
      const p = `/products/${best}`;
      if (await pathIsLive(admin, p, memo)) return { path: p, tier: 'sibling' };
    }
  }
  return { path: REDIRECT_FALLBACK, tier: 'fallback' };
}

// Article handles + publish state, for turning a referrer id into a real URL.
// isPublished is the field the blog pipeline already uses (blog/article.ts:59);
// a draft has no storefront page, so redirecting to one would manufacture the
// 404 this module exists to prevent. pageInfo at BOTH levels for the same
// reason listArticlesForIndex selects it: either boundary can hide an article.
const ARTICLE_TARGETS = `query pawscoutRedirectArticles {
  blogs(first: 20) {
    nodes {
      handle
      articles(first: 100) {
        nodes { id handle isPublished }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage }
  }
}`;

/**
 * Which rung of the chain answered. The archive gate turns on this: the owner
 * ruled on 2026-08-01 that a product is archived only when its URL can land on
 * a real guide, so a `collection`/`sibling`/`fallback` answer is good enough to
 * REPAIR an already-dead URL but not good enough to KILL a live one.
 */
export type RedirectTier = 'referring-guide' | 'category-guide' | 'collection' | 'sibling' | 'fallback';

export interface RedirectChoice { path: string; tier: RedirectTier; }

/** A congruent blog post, i.e. what the owner's rule actually asks for. */
export function isGuideTier(tier: RedirectTier): boolean {
  return tier === 'referring-guide' || tier === 'category-guide';
}

/**
 * The guide rungs of the chain, and ONLY those. Returns null when no congruent
 * blog post exists.
 *
 * Deliberately synchronous and Shopify-free. The archive gate asks this
 * question before it writes anything, and routing it through a Shopify call
 * would be actively harmful: pathIsLive swallows admin errors by design, so a
 * scope denial would come back as "no guide exists" and send whoever reads the
 * log off to write a blog post when the real fix is to grant a scope. It also
 * means a refused archive costs no API call at all.
 *
 * Publication was already checked when the index was built, so a hit here is a
 * live storefront page.
 *
 *  - `referring-guide`: this guide actually recommended the product. Sorted so
 *    a product appearing in two guides resolves the same way on every run.
 *  - `category-guide`: the guide covering the product's category, inferred from
 *    what each guide recommends.
 */
export function pickGuideTarget(
  link: { category?: string | null } | null,
  articles: ArticleTargets | null,
  preferArticleIds: string[] = []
): RedirectChoice | null {
  if (!articles) return null;
  for (const id of [...preferArticleIds].sort()) {
    const p = articles.byId.get(id);
    if (p) return { path: p, tier: 'referring-guide' };
  }
  const category = link?.category ?? null;
  if (category) {
    const g = articles.byCategory.get(category);
    if (g) return { path: g, tier: 'category-guide' };
  }
  return null;
}

export interface ArticleTargets {
  /** Article GID -> storefront path. PUBLISHED articles only. */
  byId: Map<string, string>;
  /** Category -> the path of the guide that best covers it. */
  byCategory: Map<string, string>;
  truncated: boolean;
}

export const EMPTY_ARTICLE_TARGETS: ArticleTargets = {
  byId: new Map(), byCategory: new Map(), truncated: false
};

interface Candidate { id: string; n: number; onSubject: boolean; }

/**
 * Article GIDs must be ordered by their NUMERIC suffix, never as strings.
 * `.../99999999999` sorts above `.../100000000000` lexicographically, so the
 * day Shopify ids gain a digit a string comparison silently inverts and the
 * category winner flips for no visible reason.
 */
export function articleSeq(gid: string): number {
  const m = /(\d+)\s*$/.exec(gid);
  return m ? Number(m[1]) : 0;
}

/**
 * Does candidate `a` beat the incumbent `b` for a category?
 *
 * 1. ON-SUBJECT WINS. A guide written about this category beats one merely
 *    inferred from the products it links. The brief knew; the inference guessed.
 * 2. Then the most products linked in that category.
 * 3. Then the NEWEST article, and that direction is a deliberate reversal.
 *    It used to prefer the lexicographically smaller (older) id, which meant
 *    commissioning a guide for a category that already had one did NOTHING -
 *    measured 2026-08-02, a brand new guide about grooming brushes tied the
 *    2-month-old nail guide at one linked product each and lost, so the owner
 *    paid for a guide that changed no redirect. Newest-wins makes commissioning
 *    a guide take effect, which is the whole point of commissioning one.
 */
function better(a: Candidate, b: Candidate): boolean {
  if (a.onSubject !== b.onSubject) return a.onSubject;
  if (a.n !== b.n) return a.n > b.n;
  return articleSeq(a.id) > articleSeq(b.id);
}

/**
 * Build the guide index a dead product URL is aimed at.
 *
 * The owner's rule (2026-08-01) is that an archived product must land on a
 * congruent blog post rather than 404. Two levels of congruence are available
 * and they are very different in quality:
 *
 *  - `byId` is EXACT. The archive guard knows which guides referenced the dying
 *    product, because it just repaired them. That article is congruent by
 *    construction, not by inference.
 *  - `byCategory` is DECLARED first and inferred only as a fallback. A guide's
 *    brief already recorded the collection it was written against
 *    (`blog_post_drafts.collection_handle`, read via `articleSubjects`), and
 *    that beats guessing from the products it links. Where no guide declares a
 *    category, the old inference still applies: an article recommending six
 *    pet-toys products is the pet-toys guide on the evidence. See `better()`
 *    for the full ordering and why the tie-break now prefers the NEWEST guide.
 *
 * Built once per run and passed down, like LivenessMemo - the 112-URL backfill
 * must not re-ask this per product.
 *
 * A failure returns EMPTY rather than throwing: losing article targets degrades
 * the chain to collection-then-fallback, which still never 404s. That is the
 * right trade here, unlike in listArticlesForIndex where an empty scan would be
 * read as "nothing is referenced" and unblock archives that should be refused.
 */
export async function buildArticleTargets(store: TenantStore, admin: AdminGraphql): Promise<ArticleTargets> {
  const byId = new Map<string, string>();
  let truncated = false;
  try {
    const data = await admin(ARTICLE_TARGETS) as {
      blogs?: {
        nodes?: {
          handle?: string;
          articles?: {
            nodes?: { id?: string; handle?: string; isPublished?: boolean }[];
            pageInfo?: { hasNextPage?: boolean };
          };
        }[];
        pageInfo?: { hasNextPage?: boolean };
      };
    };
    truncated = data.blogs?.pageInfo?.hasNextPage === true;
    for (const blog of data.blogs?.nodes ?? []) {
      if (blog.articles?.pageInfo?.hasNextPage) truncated = true;
      for (const a of blog.articles?.nodes ?? []) {
        if (!a.id || !a.handle || a.isPublished !== true || !blog.handle) continue;
        byId.set(a.id, `/blogs/${blog.handle}/${a.handle}`);
      }
    }
  } catch (e) {
    console.warn(`article redirect targets unavailable: ${(e as Error).message}`);
    return EMPTY_ARTICLE_TARGETS;
  }

  const byCategory = new Map<string, string>();
  try {
    const subjects = new Map<string, string>();
    for (const s of await store.articleSubjects()) subjects.set(s.referrerId, s.category);

    const best = new Map<string, Candidate>();
    const consider = (category: string, id: string, n: number) => {
      if (!byId.has(id)) return;                       // unpublished or gone
      const declared = subjects.get(id);
      // A guide that declares a subject may ONLY represent that subject. This
      // is what stops the grooming guide becoming the `more-to-love` guide
      // just because it happened to link one item filed there. A category left
      // with no candidate at all is the honest outcome: no guide covers it, so
      // the archive gate refuses and the URL keeps its collection fallback.
      if (declared && declared !== category) return;
      const onSubject = declared === category;
      const cur = best.get(category);
      if (!cur || better({ id, n, onSubject }, cur)) best.set(category, { id, n, onSubject });
    };
    for (const w of await store.articleCategoryWeights()) consider(w.category, w.referrerId, w.n);
    // Second pass so a guide claims its declared subject even with n = 0 there.
    for (const [id, category] of subjects) consider(category, id, 0);
    for (const [category, { id }] of best) byCategory.set(category, byId.get(id)!);
  } catch (e) {
    console.warn(`article category weights unavailable: ${(e as Error).message}`);
  }
  return { byId, byCategory, truncated };
}
