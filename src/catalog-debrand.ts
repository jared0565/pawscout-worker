// src/catalog-debrand.ts
//
// The catalog de-brand SWEEP: strip manufacturer/supplier brands (src/debrand.ts)
// from existing product TITLES and already-published blog ARTICLE bodies. This is
// the remediation half of the de-brand system (import.ts + ground.ts handle new
// products and new prose). Idempotent and self-healing: it re-scans every run and
// only writes the few items that still carry a brand, so it is a cheap no-op once
// the catalog is clean. Wired as a nightly maintenance stage AND an owner-triggered
// console action (POST /api/catalog/debrand).

import type { AdminGraphql } from './shopify-admin';
import { debrandTitle, debrandText, BRAND_TOKENS } from './debrand';

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
        nodes { id title body }
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
  let data: { blogs?: { nodes?: { handle?: string; articles?: { nodes?: { id: string; title?: string; body?: string }[]; pageInfo?: { hasNextPage?: boolean } } }[] } };
  try {
    data = await admin(ARTICLES_QUERY) as typeof data;
  } catch (e) {
    result.errors.push(`articles query: ${(e as Error).message}`);
    return; // a failed article read must never crash the sweep/stage
  }
  for (const blog of data.blogs?.nodes ?? []) {
    for (const a of blog.articles?.nodes ?? []) {
      result.articlesScanned++;
      if (!a.body) continue;
      const cleaned = debrandText(a.body, brands);
      if (cleaned === a.body) continue;
      try {
        const r = await admin(ARTICLE_BODY_UPDATE, { id: a.id, article: { body: cleaned } }) as {
          articleUpdate?: { userErrors?: { message: string }[] };
        };
        const errs = r.articleUpdate?.userErrors ?? [];
        if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
        result.bodiesUpdated++;
        if (result.samples.length < 12) result.samples.push(`article: "${a.title ?? a.id}" body de-branded`);
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
