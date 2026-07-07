// src/blog/pipeline.ts
//
// Orchestrates the blog agents end to end: research (brief) -> ground (real
// products) -> draft (LLM writes, gate refines) -> create a Shopify DRAFT
// article -> stage a bookkeeping row. This is "the system authors the post."
// It NEVER publishes - the article is created isPublished:false for the owner
// to review and publish (docs/blog-rss-pinterest-traffic-prd-audit.md Q3).

import { LlmClient } from '../llm';
import { TenantStore } from '../tenant-store';
import { adminForShop } from '../inbox/invoice-routes';
import { defaultFetch } from '../safe-fetch';
import type { Env, TenantConfig } from '../types';
import { proposeBrief, seasonForMonth } from './research';
import { groundCollection } from './ground';
import { draftArticle } from './draft';
import { findClaimFlags } from './quality';
import { findBlog, renameBlog, createDraftArticle } from './article';

const BLOG_HANDLE = 'news';                // the already-indexed blog we reuse
const BLOG_TITLE = 'Pet Care Guides';      // its new display title
const AUTHOR_NAME = 'Active Paw';

export interface BlogPipelineResult {
  ok: boolean;
  error?: string;
  articleId?: string;
  articleHandle?: string;
  title?: string;
  collectionHandle?: string;
  claimFlags?: { sentence: string; concern: string }[];
  briefAngle?: string;
}

/**
 * Author one post. `topicHint` (optional) steers the research angle - the owner
 * can pass a topic, or leave it for the agent to choose. `nowMonth0` is injected
 * (0-11) so season is deterministic/testable. Every failure degrades to
 * {ok:false, error} and is safe to retry; nothing partial is published.
 */
export async function runBlogPipeline(
  env: Env, store: TenantStore, cfg: TenantConfig,
  opts: { topicHint?: string; nowMonth0: number } , fetchImpl: typeof fetch = defaultFetch
): Promise<BlogPipelineResult> {
  const admin = await adminForShop(env, store, fetchImpl).catch(() => null);
  if (!admin) return { ok: false, error: 'Shopify connection unavailable (needs the write_content scope + a live token).' };

  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);
  if (!llm.available) return { ok: false, error: 'No LLM configured.' };

  // Blog: find + rename (idempotent) the reused 'news' blog.
  let blog;
  try {
    blog = await findBlog(admin, BLOG_HANDLE);
    if (!blog) return { ok: false, error: `Blog '${BLOG_HANDLE}' not found.` };
    if (blog.title !== BLOG_TITLE) blog = await renameBlog(admin, blog.id, BLOG_TITLE);
  } catch (e) {
    return { ok: false, error: `Blog access failed: ${(e as Error).message}` };
  }

  const validHandles = Object.values(cfg.collectionMap).map((c) => c.handle).filter(Boolean);
  if (validHandles.length === 0) return { ok: false, error: 'No collections configured to funnel into.' };

  // Research -> brief.
  const brief = await proposeBrief(llm, store, cfg, {
    validHandles, season: seasonForMonth(opts.nowMonth0), topicHint: opts.topicHint
  });
  if (!brief) return { ok: false, error: 'Research agent could not produce a brief.' };

  // Ground -> real products for the chosen collection (fall back through others
  // if the chosen one is empty, so a thin collection never forces a fabrication).
  let pack = await groundCollection(admin, brief.collectionHandle);
  if (!pack) {
    for (const h of validHandles) {
      if (h === brief.collectionHandle) continue;
      pack = await groundCollection(admin, h);
      if (pack) { brief.collectionHandle = h; break; }
    }
  }
  if (!pack) return { ok: false, error: 'No collection with products to ground the article in.' };

  // Draft -> LLM writes, blog gate refines.
  const draft = await draftArticle(llm, store, cfg, brief, pack);
  if (!draft) return { ok: false, error: 'Draft agent could not produce an article.' };

  const claimFlags = findClaimFlags(draft.bodyHtml);

  // Create the DRAFT article (isPublished:false) + stage the bookkeeping row.
  let created;
  try {
    created = await createDraftArticle(admin, { blogId: blog.id, draft, authorName: AUTHOR_NAME });
  } catch (e) {
    return { ok: false, error: `Article creation failed: ${(e as Error).message}` };
  }

  await store.insertBlogPostDraft({
    id: crypto.randomUUID(),
    shopifyArticleId: created.id,
    blogHandle: BLOG_HANDLE,
    title: created.title,
    collectionHandle: brief.collectionHandle,
    briefJson: JSON.stringify(brief),
    claimFlagsJson: JSON.stringify(claimFlags),
    model: 'blog-pipeline'
  });

  return {
    ok: true,
    articleId: created.id,
    articleHandle: created.handle,
    title: created.title,
    collectionHandle: brief.collectionHandle,
    claimFlags,
    briefAngle: brief.angle
  };
}
