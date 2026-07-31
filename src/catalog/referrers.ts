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
  /** The article's own handle - used as the referrer_id. */
  handle: string;
  bodyHtml: string;
  /** Curated picks from the related_products metafield. */
  relatedHandles: string[];
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
    await store.clearProductReferrers('blog', a.handle);
    const handles = new Set<string>([
      ...handlesInBody(a.bodyHtml),
      ...a.relatedHandles.map((h) => h.trim().toLowerCase()).filter(Boolean),
    ]);
    for (const h of handles) {
      await store.putProductReferrers(h, [{ referrerType: 'blog', referrerId: a.handle }]);
      written++;
    }
  }
  return written;
}
