/**
 * The product-referrer index: which internal surfaces point at a product handle.
 *
 * WHY IT EXISTS: the no-movement cull is the only remaining automated takedown,
 * and a takedown must never silently break a guide that recommends the product.
 * Parsing every article on demand at archive time would be slow and would hit
 * the Shopify API once per candidate, so the answer is precomputed here.
 *
 * IT IS A DERIVED CACHE, NEVER A SOURCE OF TRUTH. The truth stays in the article
 * bodies, the related_products metafield and syndication_ledger. Consequently a
 * MISS means "unknown" and must BLOCK an archive - archiveProductGuarded must
 * never read an empty result as "safe to archive".
 *
 * NOTE: this module must not touch D1. tests/guard.test.ts enforces that only
 * tenant-store.ts does, so every read and write goes through TenantStore.
 */
import type { TenantStore } from '../tenant-store';
import type { AdminGraphql } from '../shopify-admin';

/**
 * Distinct product handles a body links, in order of first appearance.
 *
 * Deliberately a local copy of the extractor in blog/article-health.ts rather
 * than an import: the index must not depend on the heal pass, and the two are
 * allowed to diverge if the heal pass ever narrows its own matching.
 */
export function handlesInBody(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*['"]\/products\/([a-zA-Z0-9][a-zA-Z0-9-]*)['"]/g)) {
    const h = m[1].toLowerCase();
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

export interface ArticleSource {
  /** The article GID - used as the referrer_id. NOT the handle: a rename would
   *  orphan handle-keyed rows (clearProductReferrers is scoped to one id) and
   *  block that product from ever archiving. The GID is also what
   *  ARTICLE_BODY_UPDATE takes, so an in-article repair needs no second lookup. */
  articleId: string;
  bodyHtml: string;
  /** Curated picks from the related_products metafield. */
  relatedHandles: string[];
}

/** Result of reading the blog. `truncated` is the load-bearing field: an article
 *  we failed to read contributes no rows, and a missing row is indistinguishable
 *  from "unreferenced" at archive time. */
export interface ArticleScan {
  articles: ArticleSource[];
  truncated: boolean;
}

// Same shape runArticleHealth uses (blog/article-health.ts:192), which is
// validated against the pinned 2026-04 schema. The metafield namespace/key are
// `blog`/`related_products` - read from that query rather than assumed.
// pageInfo is selected at BOTH levels because either boundary can hide an
// article from the index.
const INDEX_ARTICLES = `query pawscoutArticlesForIndex {
  blogs(first: 20) {
    nodes {
      handle
      articles(first: 100) {
        nodes { id body metafield(namespace: "blog", key: "related_products") { value } }
        pageInfo { hasNextPage }
      }
    }
    pageInfo { hasNextPage }
  }
}`;

/**
 * Every article the shop will admit to, shaped for rebuildBlogReferrers.
 *
 * Throws on a query failure rather than returning an empty scan. A caught error
 * here would look like "no articles reference anything", which is the single
 * most dangerous lie this module can tell.
 */
export async function listArticlesForIndex(admin: AdminGraphql): Promise<ArticleScan> {
  const data = await admin(INDEX_ARTICLES) as {
    blogs?: {
      nodes?: {
        articles?: {
          nodes?: { id: string; body?: string; metafield?: { value?: string } | null }[];
          pageInfo?: { hasNextPage?: boolean };
        };
      }[];
      pageInfo?: { hasNextPage?: boolean };
    };
  };
  const articles: ArticleSource[] = [];
  let truncated = data.blogs?.pageInfo?.hasNextPage === true;
  for (const blog of data.blogs?.nodes ?? []) {
    if (blog.articles?.pageInfo?.hasNextPage) truncated = true;
    for (const a of blog.articles?.nodes ?? []) {
      let relatedHandles: string[] = [];
      if (a.metafield?.value) {
        try {
          const parsed = JSON.parse(a.metafield.value);
          if (Array.isArray(parsed)) relatedHandles = parsed.filter((h) => typeof h === 'string');
        } catch { relatedHandles = []; }
      }
      articles.push({ articleId: a.id, bodyHtml: a.body ?? '', relatedHandles });
    }
  }
  return { articles, truncated };
}

/**
 * Rebuild the blog slice of the index.
 *
 * Each article is CLEARED before its rows are written, so a handle the article
 * no longer mentions stops being a referrer. Without that the index would only
 * ever grow and would block those products from archiving forever. Clearing is
 * scoped to the one article, so another article referencing the same product is
 * untouched.
 *
 * Returns the number of (handle, article) rows written.
 */
export async function rebuildBlogReferrers(
  store: TenantStore,
  articles: ArticleSource[]
): Promise<number> {
  let written = 0;
  for (const a of articles) {
    await store.clearProductReferrers('blog', a.articleId);
    const handles = new Set<string>([
      ...handlesInBody(a.bodyHtml),
      ...a.relatedHandles.map((h) => h.trim().toLowerCase()).filter(Boolean),
    ]);
    for (const h of handles) {
      await store.putProductReferrers(h, [{ referrerType: 'blog', referrerId: a.articleId }]);
      written++;
    }
  }
  return written;
}

/**
 * Reindex ONE article straight after it is written, from the body and picks
 * already in hand - no Admin round trip.
 *
 * Deliberately does NOT touch the completeness stamp. A single-article refresh
 * says nothing about whether the whole blog was read, and moving indexedAt here
 * would let a stale index masquerade as fresh every time the owner regenerated
 * a post. Correctness still rests on the nightly stage; this only stops the
 * index lagging a rewrite by up to a day.
 *
 * Never throws: an article write must not be rolled back because a derived
 * cache could not be updated. A miss here is corrected by the nightly rebuild,
 * and until then it can only over-block, never over-archive.
 */
export async function reindexArticle(
  store: TenantStore,
  article: ArticleSource
): Promise<void> {
  try {
    await rebuildBlogReferrers(store, [article]);
  } catch (e) {
    console.warn(`referrer reindex failed for ${article.articleId}: ${(e as Error).message}`);
  }
}

/**
 * The whole rebuild: read, write, and stamp what was actually covered.
 *
 * The stamp is written even when the scan was truncated - with truncated=true,
 * so the guard can refuse deliberately and say why. Writing no stamp at all
 * would be indistinguishable from "never ran".
 */
export async function rebuildReferrerIndex(
  store: TenantStore,
  admin: AdminGraphql
): Promise<{ articleCount: number; rowCount: number; truncated: boolean }> {
  const scan = await listArticlesForIndex(admin);
  const rowCount = await rebuildBlogReferrers(store, scan.articles);
  await store.putReferrerIndexStamp({
    indexedAt: new Date().toISOString(),
    articleCount: scan.articles.length,
    rowCount,
    truncated: scan.truncated,
  });
  if (scan.truncated) {
    // Loud: while this is true every archive is refused, so a silent version of
    // this line would read as a broken cull rather than a working safety gate.
    console.error(`referrer-index: TRUNCATED at a page boundary, ${scan.articles.length} article(s) read; archives will refuse until the lister paginates`);
  }
  return { articleCount: scan.articles.length, rowCount, truncated: scan.truncated };
}
