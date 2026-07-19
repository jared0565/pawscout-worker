// src/blog/article.ts
//
// Admin API operations for the blog channel, run with the worker's own token
// (which carries write_content). Creates articles as DRAFTS (isPublished:false)
// so a human reviews and publishes - the system authors, never auto-publishes
// (docs/blog-rss-pinterest-traffic-prd-audit.md Q3). Shapes verified against the
// pinned 2026-04 Admin API by introspection 2026-07-07.

import type { AdminGraphql } from '../shopify-admin';
import type { BlogDraft } from './types';
import { debrandTitle } from '../debrand';

export interface BlogRef { id: string; handle: string; title: string; }

// The "Shop this guide" metafield: a list of product handles the theme renders
// via all_products[handle]. Handles (not product GIDs) keep the worker side
// GID-free and let the theme resolve live, market-priced product cards.
export const RELATED_NS = 'blog';
export const RELATED_KEY = 'related_products';
export const RELATED_TYPE = 'list.single_line_text_field';

// The article FAQ metafield: [{q, a}...] the theme renders as a visible FAQ
// section AND as FAQPage JSON-LD from the SAME source, so the schema can never
// drift from what the reader sees.
export const FAQ_NS = 'blog';
export const FAQ_KEY = 'faq_json';
export const FAQ_TYPE = 'json';

const BLOGS_QUERY = `query pawscoutBlogs { blogs(first: 20) { nodes { id handle title } } }`;

/** Find a blog by handle (e.g. the default 'news'). Null if none. */
export async function findBlog(admin: AdminGraphql, handle: string): Promise<BlogRef | null> {
  const data = await admin(BLOGS_QUERY) as { blogs?: { nodes?: BlogRef[] } };
  return (data.blogs?.nodes ?? []).find((b) => b.handle === handle) ?? null;
}

const BLOG_UPDATE = `mutation pawscoutBlogRename($id: ID!, $blog: BlogUpdateInput!) {
  blogUpdate(id: $id, blog: $blog) { blog { id handle title } userErrors { field message } }
}`;

/** Rename a blog's title, and optionally its handle. Passing no `handle` keeps
 *  the existing one (title-only rename). Passing a `handle` migrates the URL
 *  (e.g. news -> guides). Idempotent. */
export async function renameBlog(admin: AdminGraphql, blogId: string, title: string, handle?: string): Promise<BlogRef> {
  const blogInput: Record<string, unknown> = { title };
  if (handle) blogInput.handle = handle;
  const data = await admin(BLOG_UPDATE, { id: blogId, blog: blogInput }) as {
    blogUpdate?: { blog?: BlogRef; userErrors?: { message: string }[] };
  };
  const errs = data.blogUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(`blogUpdate: ${errs.map((e) => e.message).join('; ')}`);
  const blog = data.blogUpdate?.blog;
  if (!blog) throw new Error('blogUpdate returned no blog');
  return blog;
}

const ARTICLE_CREATE = `mutation pawscoutArticleCreate($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article { id handle title isPublished }
    userErrors { field message }
  }
}`;

export interface CreatedArticle { id: string; handle: string; title: string; isPublished: boolean; }

/**
 * Create a DRAFT article (isPublished:false) under the blog from a finished
 * BlogDraft. SEO title/description ride the standard global.title_tag /
 * description_tag metafields. A featured image is optional here - it is
 * publish-blocking in the review step, not creation-blocking - so the owner can
 * add the image when they review before publishing.
 */
export async function createDraftArticle(
  admin: AdminGraphql,
  opts: { blogId: string; draft: BlogDraft; authorName: string; imageUrl?: string; imageAlt?: string; relatedHandles?: string[] }
): Promise<CreatedArticle> {
  const { blogId, draft, authorName, imageUrl, imageAlt, relatedHandles } = opts;
  const metafields: Record<string, unknown>[] = [
    { namespace: 'global', key: 'title_tag', value: draft.metaTitle, type: 'single_line_text_field' },
    { namespace: 'global', key: 'description_tag', value: draft.metaDescription, type: 'single_line_text_field' }
  ];
  if (relatedHandles && relatedHandles.length) {
    metafields.push({ namespace: RELATED_NS, key: RELATED_KEY, value: JSON.stringify(relatedHandles), type: RELATED_TYPE });
  }
  if (draft.faq && draft.faq.length) {
    metafields.push({ namespace: FAQ_NS, key: FAQ_KEY, value: JSON.stringify(draft.faq), type: FAQ_TYPE });
  }
  const article: Record<string, unknown> = {
    blogId,
    title: draft.title,
    body: draft.bodyHtml,
    summary: draft.excerpt,
    isPublished: false,           // DRAFT - human publishes after review
    author: { name: authorName },
    tags: draft.tag ? [draft.tag] : [],
    metafields
  };
  // De-brand the featured-image alt (it becomes og:image:alt / twitter:image:alt
  // and the hero <img alt>). The alt is a snapshot of the hero product's title,
  // so strip any manufacturer brand here, at the write choke point. See src/debrand.ts.
  if (imageUrl) article.image = { url: imageUrl, altText: debrandTitle(imageAlt ?? draft.title) };

  const data = await admin(ARTICLE_CREATE, { article }) as {
    articleCreate?: { article?: CreatedArticle; userErrors?: { message: string }[] };
  };
  const errs = data.articleCreate?.userErrors ?? [];
  if (errs.length) throw new Error(`articleCreate: ${errs.map((e) => e.message).join('; ')}`);
  const created = data.articleCreate?.article;
  if (!created?.id) throw new Error('articleCreate returned no article');
  return created;
}

const METAFIELD_DEFINITION_CREATE = `mutation pawscoutBlogMfDef($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id }
    userErrors { field message code }
  }
}`;

/**
 * Best-effort: register the blog article metafield definitions (related_products
 * + faq_json) on ARTICLE with storefront read access. Online Store Liquid can
 * read set metafields even without a definition, so this is INSURANCE (and gives
 * the metafields admin-UI visibility + Storefront-API access), never a hard
 * dependency. Idempotent: a pre-existing definition returns a TAKEN userError,
 * which we swallow; any other failure is logged and ignored so it can never
 * break article creation.
 */
export async function ensureRelatedProductsDefinition(admin: AdminGraphql): Promise<void> {
  const definitions = [
    { name: 'Shop this guide products', namespace: RELATED_NS, key: RELATED_KEY, ownerType: 'ARTICLE', type: RELATED_TYPE, access: { storefront: 'PUBLIC_READ' } },
    { name: 'Article FAQ', namespace: FAQ_NS, key: FAQ_KEY, ownerType: 'ARTICLE', type: FAQ_TYPE, access: { storefront: 'PUBLIC_READ' } }
  ];
  for (const definition of definitions) {
    try {
      const data = await admin(METAFIELD_DEFINITION_CREATE, { definition }) as {
        metafieldDefinitionCreate?: { userErrors?: { code?: string; message: string }[] };
      };
      const errs = data.metafieldDefinitionCreate?.userErrors ?? [];
      const hard = errs.filter((e) => e.code !== 'TAKEN');
      if (hard.length) console.warn(`blog metafield definition ${definition.key}: ${hard.map((e) => e.message).join('; ')}`);
    } catch (e) {
      console.warn(`blog metafield definition create failed (non-fatal, ${definition.key}): ${(e as Error).message}`);
    }
  }
}

const ARTICLES_PUBLISHED = `query pawscoutArticlesPublished($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Article { id isPublished } }
}`;

/** isPublished by article id, for the staged rows whose D1 status may lag the
 *  owner's publish action in Shopify admin. Missing/deleted articles are simply
 *  absent from the map. Throws on transport errors (caller degrades). */
export async function getPublishedMap(admin: AdminGraphql, ids: string[]): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (!ids.length) return map;
  const data = await admin(ARTICLES_PUBLISHED, { ids }) as {
    nodes?: ({ id?: string; isPublished?: boolean } | null)[];
  };
  for (const n of data.nodes ?? []) {
    if (n?.id) map.set(n.id, n.isPublished === true);
  }
  return map;
}

const ARTICLES_FOR_SYNDICATION = `query pawscoutArticlesSyndication($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Article { id handle title isPublished body image { url } } }
}`;

export interface ArticleSyndicationInfo { id: string; handle: string; title: string; imageUrl: string | null; isPublished: boolean; body: string }

/** Live handle + title + CURRENT featured image per article id, for the
 * syndication pack build. Shopify is the source of truth here (an owner-swapped
 * hero must be what gets pinned, not the stale D1 bookkeeping url). Missing or
 * deleted articles are simply absent. Throws on transport errors (caller
 * degrades). */
export async function getArticlesForSyndication(admin: AdminGraphql, ids: string[]): Promise<Map<string, ArticleSyndicationInfo>> {
  const map = new Map<string, ArticleSyndicationInfo>();
  if (!ids.length) return map;
  const data = await admin(ARTICLES_FOR_SYNDICATION, { ids }) as {
    nodes?: ({ id?: string; handle?: string; title?: string; isPublished?: boolean; body?: string; image?: { url?: string } | null } | null)[];
  };
  for (const n of data.nodes ?? []) {
    if (!n?.id || !n.handle) continue;
    map.set(n.id, { id: n.id, handle: n.handle, title: n.title ?? '', imageUrl: n.image?.url ?? null, isPublished: n.isPublished === true, body: n.body ?? '' });
  }
  return map;
}

const ARTICLE_READ = `query pawscoutArticleRead($id: ID!) {
  article(id: $id) { id handle title image { url } body }
}`;

export interface ArticleForEnrich { id: string; handle: string; title: string; hasImage: boolean; bodyHtml: string; }

/** Read the fields enrich needs: whether a hero image already exists (never
 *  clobber an owner-set one) and the body (to see which products it links). */
export async function getArticleForEnrich(admin: AdminGraphql, articleId: string): Promise<ArticleForEnrich | null> {
  const data = await admin(ARTICLE_READ, { id: articleId }) as {
    article?: { id?: string; handle?: string; title?: string; image?: { url?: string } | null; body?: string };
  };
  const a = data.article;
  if (!a?.id) return null;
  return {
    id: a.id,
    handle: a.handle ?? '',
    title: a.title ?? '',
    hasImage: !!a.image?.url,
    bodyHtml: a.body ?? ''
  };
}

const ARTICLE_UPDATE = `mutation pawscoutArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
  articleUpdate(id: $id, article: $article) {
    article { id handle }
    userErrors { field message }
  }
}`;

/**
 * Attach the shop-block metafield and (optionally) a hero image to an existing
 * article. `imageUrl` is set only when provided - the caller decides whether to
 * fill a missing image so an owner-chosen one is never overwritten. Throws on
 * userErrors so the caller surfaces the failure.
 */
export async function updateArticleAssets(
  admin: AdminGraphql,
  opts: { articleId: string; relatedHandles?: string[]; imageUrl?: string; imageAlt?: string }
): Promise<void> {
  const { articleId, relatedHandles, imageUrl, imageAlt } = opts;
  const article: Record<string, unknown> = {};
  if (relatedHandles && relatedHandles.length) {
    article.metafields = [
      { namespace: RELATED_NS, key: RELATED_KEY, value: JSON.stringify(relatedHandles), type: RELATED_TYPE }
    ];
  }
  if (imageUrl) article.image = { url: imageUrl, altText: debrandTitle(imageAlt ?? '') };
  if (Object.keys(article).length === 0) return; // nothing to do

  const data = await admin(ARTICLE_UPDATE, { id: articleId, article }) as {
    articleUpdate?: { userErrors?: { message: string }[] };
  };
  const errs = data.articleUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(`articleUpdate: ${errs.map((e) => e.message).join('; ')}`);
}
