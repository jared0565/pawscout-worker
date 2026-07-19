// src/catalog-debrand.ts
//
// The catalog de-brand SWEEP: strip manufacturer/supplier brands (src/debrand.ts)
// from existing product TITLES and already-published blog ARTICLE bodies. This is
// the remediation half of the de-brand system (import.ts + ground.ts handle new
// products and new prose). The same article pass also scrubs non-approved
// external links (src/blog/sources.ts) so a competitor/retailer link can never
// persist in a published post, even one authored before the gate existed.
// Idempotent and self-healing: it re-scans every run and only writes the few
// items that still carry a brand or a bad link, so it is a cheap no-op once the
// catalog is clean. Wired as a nightly maintenance stage AND an owner-triggered
// console action (POST /api/catalog/debrand).

import type { AdminGraphql } from './shopify-admin';
import { debrandTitle, debrandText, BRAND_TOKENS } from './debrand';
import { scrubExternalLinks } from './blog/sources';

const PRODUCTS_PAGE = `query pawscoutDebrandProducts($cursor: String) {
  products(first: 100, after: $cursor) {
    nodes { id title }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PRODUCT_TITLE_UPDATE = `mutation pawscoutDebrandTitle($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

const ARTICLES_QUERY = `query pawscoutDebrandArticles {
  blogs(first: 20) {
    nodes {
      id handle
      articles(first: 100) {
        nodes { id title body image { url altText } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

const ARTICLE_BODY_UPDATE = `mutation pawscoutDebrandArticle($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) { article { id } userErrors { field message } }
}`;

export interface DebrandResult {
  productsScanned: number;
  titlesRenamed: number;
  articlesScanned: number;
  bodiesUpdated: number;
  errors: string[];
  samples: string[]; // a few before -> after examples for the console/log
}

/** Paginate all products and de-brand any title that still carries a brand. */
async function debrandProductTitles(
  admin: AdminGraphql, brands: string[], result: DebrandResult
): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) { // safety bound (5000 products)
    let data: { products?: { nodes?: { id: string; title: string }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
    try {
      data = await admin(PRODUCTS_PAGE, { cursor }) as typeof data;
    } catch (e) {
      result.errors.push(`products query: ${(e as Error).message}`);
      return; // a failed page read must never crash the sweep/stage
    }
    const conn = data.products;
    for (const p of conn?.nodes ?? []) {
      result.productsScanned++;
      const cleaned = debrandTitle(p.title, brands);
      if (cleaned === p.title) continue;
      try {
        const r = await admin(PRODUCT_TITLE_UPDATE, { input: { id: p.id, title: cleaned } }) as {
          productUpdate?: { userErrors?: { message: string }[] };
        };
        const errs = r.productUpdate?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
        result.titlesRenamed++;
        if (result.samples.length < 12) result.samples.push(`title: "${p.title}" -> "${cleaned}"`);
      } catch (e) {
        result.errors.push(`product ${p.id}: ${(e as Error).message}`);
      }
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
}

/** Scan published blog articles and de-brand any brand left in the body text.
 *  HTML-safe: debrandText is case-sensitive so product-link handles (lowercase
 *  in the href) are never altered - only the visible brand word is removed. */
async function debrandArticleBodies(
  admin: AdminGraphql, brands: string[], result: DebrandResult
): Promise<void> {
  let data: { blogs?: { nodes?: { handle?: string; articles?: { nodes?: { id: string; title?: string; body?: string; image?: { url?: string; altText?: string } }[]; pageInfo?: { hasNextPage?: boolean } } }[] } };
  try {
    data = await admin(ARTICLES_QUERY) as typeof data;
  } catch (e) {
    result.errors.push(`articles query: ${(e as Error).message}`);
    return; // a failed article read must never crash the sweep/stage
  }
  for (const blog of data.blogs?.nodes ?? []) {
    for (const a of blog.articles?.nodes ?? []) {
      result.articlesScanned++;
      const article: Record<string, unknown> = {};
      const changes: string[] = [];
      if (a.body) {
        const debranded = debrandText(a.body, brands);
        const cleaned = scrubExternalLinks(debranded);
        if (cleaned !== a.body) {
          article.body = cleaned;
          if (debranded !== a.body) changes.push('body');
          if (cleaned !== debranded) changes.push('external links');
        }
      }
      // The featured-image alt is a snapshot of the hero product title taken at
      // creation, so it can still carry a brand after the title rename. Use
      // debrandTitle (plain string, no URL to damage) and re-pass the current
      // image url (a harmless re-process of the same photo) so og:image:alt,
      // twitter:image:alt and the hero <img alt> all go clean in one write.
      if (a.image?.altText) {
        const cleanedAlt = debrandTitle(a.image.altText, brands);
        if (cleanedAlt !== a.image.altText) { article.image = { url: a.image.url, altText: cleanedAlt }; changes.push('image alt'); }
      }
      if (!changes.length) continue;
      try {
        const r = await admin(ARTICLE_BODY_UPDATE, { id: a.id, article }) as {
          articleUpdate?: { userErrors?: { message: string }[] };
        };
        const errs = r.articleUpdate?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
        result.bodiesUpdated++;
        if (result.samples.length < 12) result.samples.push(`article "${a.title ?? a.id}" de-branded (${changes.join(' + ')})`);
      } catch (e) {
        result.errors.push(`article ${a.id}: ${(e as Error).message}`);
      }
    }
    if (blog.articles?.pageInfo?.hasNextPage) {
      result.errors.push(`blog ${blog.handle ?? '?'}: >100 articles, tail not swept this run`);
    }
  }
}

/**
 * De-brand the whole catalog: product titles + published article bodies.
 * Never throws - per-item failures are collected in `errors` so one bad write
 * never aborts the sweep. Safe to run repeatedly (nightly and on demand).
 */
export async function debrandCatalog(
  admin: AdminGraphql, brands: string[] = BRAND_TOKENS
): Promise<DebrandResult> {
  const result: DebrandResult = {
    productsScanned: 0, titlesRenamed: 0, articlesScanned: 0, bodiesUpdated: 0, errors: [], samples: []
  };
  await debrandProductTitles(admin, brands, result);
  await debrandArticleBodies(admin, brands, result);
  if (result.titlesRenamed || result.bodiesUpdated) {
    console.log(`debrand: renamed ${result.titlesRenamed} title(s), updated ${result.bodiesUpdated} article body(ies)`);
  }
  return result;
}
