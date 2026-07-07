// src/blog/article.ts
//
// Admin API operations for the blog channel, run with the worker's own token
// (which carries write_content). Creates articles as DRAFTS (isPublished:false)
// so a human reviews and publishes - the system authors, never auto-publishes
// (docs/blog-rss-pinterest-traffic-prd-audit.md Q3). Shapes verified against the
// pinned 2026-04 Admin API by introspection 2026-07-07.

import type { AdminGraphql } from '../shopify-admin';
import type { BlogDraft } from './types';

export interface BlogRef { id: string; handle: string; title: string; }

const BLOGS_QUERY = `query pawscoutBlogs { blogs(first: 20) { nodes { id handle title } } }`;

/** Find a blog by handle (e.g. the default 'news'). Null if none. */
export async function findBlog(admin: AdminGraphql, handle: string): Promise<BlogRef | null> {
  const data = await admin(BLOGS_QUERY) as { blogs?: { nodes?: BlogRef[] } };
  return (data.blogs?.nodes ?? []).find((b) => b.handle === handle) ?? null;
}

const BLOG_UPDATE = `mutation pawscoutBlogRename($id: ID!, $blog: BlogUpdateInput!) {
  blogUpdate(id: $id, blog: $blog) { blog { id handle title } userErrors { field message } }
}`;

/** Rename a blog's title (handle is preserved by NOT sending a new handle, so
 *  the already-indexed /blogs/<handle> URL stays valid). Idempotent. */
export async function renameBlog(admin: AdminGraphql, blogId: string, title: string): Promise<BlogRef> {
  const data = await admin(BLOG_UPDATE, { id: blogId, blog: { title } }) as {
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
  opts: { blogId: string; draft: BlogDraft; authorName: string; imageUrl?: string; imageAlt?: string }
): Promise<CreatedArticle> {
  const { blogId, draft, authorName, imageUrl, imageAlt } = opts;
  const article: Record<string, unknown> = {
    blogId,
    title: draft.title,
    body: draft.bodyHtml,
    summary: draft.excerpt,
    isPublished: false,           // DRAFT - human publishes after review
    author: { name: authorName },
    tags: draft.tag ? [draft.tag] : [],
    metafields: [
      { namespace: 'global', key: 'title_tag', value: draft.metaTitle, type: 'single_line_text_field' },
      { namespace: 'global', key: 'description_tag', value: draft.metaDescription, type: 'single_line_text_field' }
    ]
  };
  if (imageUrl) article.image = { url: imageUrl, altText: imageAlt ?? draft.title };

  const data = await admin(ARTICLE_CREATE, { article }) as {
    articleCreate?: { article?: CreatedArticle; userErrors?: { message: string }[] };
  };
  const errs = data.articleCreate?.userErrors ?? [];
  if (errs.length) throw new Error(`articleCreate: ${errs.map((e) => e.message).join('; ')}`);
  const created = data.articleCreate?.article;
  if (!created?.id) throw new Error('articleCreate returned no article');
  return created;
}
