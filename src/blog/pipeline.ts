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
import type { BlogBrief, BlogTopicCandidate } from './types';
import { proposeBrief, proposeTopics, validateBrief, seasonForMonth } from './research';
import { groundCollection } from './ground';
import { draftArticle } from './draft';
import { findClaimFlags } from './quality';
import { selectShopBlock } from './select';
import { findBlog, renameBlog, createDraftArticle, ensureRelatedProductsDefinition, getArticleForEnrich, updateArticleAssets } from './article';

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
  relatedHandles?: string[];
  heroImageUrl?: string;
  heroSourceHandle?: string;
  heroIsHighRes?: boolean;
}

/**
 * Author one post. `topicHint` (optional) steers the research angle - the owner
 * can pass a topic, or leave it for the agent to choose. `nowMonth0` is injected
 * (0-11) so season is deterministic/testable. Every failure degrades to
 * {ok:false, error} and is safe to retry; nothing partial is published.
 */
/** Use the brief the owner picked from the suggestions (revalidated so a tampered
 *  or stale collection is rejected), or null to fall back to fresh research. This
 *  is the load-bearing passthrough: a picked topic must be written as-is, never
 *  re-derived, or the congruence gate is meaningless. */
export function resolvePipelineBrief(passed: BlogBrief | undefined, validHandles: string[]): BlogBrief | null {
  return passed ? validateBrief(passed, validHandles) : null;
}

export async function runBlogPipeline(
  env: Env, store: TenantStore, cfg: TenantConfig,
  opts: { topicHint?: string; brief?: BlogBrief; nowMonth0: number } , fetchImpl: typeof fetch = defaultFetch
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

  // Insurance so the theme's shop-block metafield read is never a silent miss.
  await ensureRelatedProductsDefinition(admin);

  const validHandles = Object.values(cfg.collectionMap).map((c) => c.handle).filter(Boolean);
  if (validHandles.length === 0) return { ok: false, error: 'No collections configured to funnel into.' };

  // Brief: reuse the validated one the owner picked from the suggestions (skip
  // re-research so the exact topic + collection they chose is what gets written),
  // else research fresh from an optional freehand topic hint.
  let brief = resolvePipelineBrief(opts.brief, validHandles);
  if (!brief) {
    brief = await proposeBrief(llm, store, cfg, {
      validHandles, season: seasonForMonth(opts.nowMonth0), topicHint: opts.topicHint
    });
  }
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

  // Shop block + hero: products the body links come first, then top up from the
  // funnel collection; the hero is the first pick that has an image.
  const sel = selectShopBlock(pack, draft.bodyHtml);

  // Create the DRAFT article (isPublished:false) + stage the bookkeeping row.
  let created;
  try {
    created = await createDraftArticle(admin, {
      blogId: blog.id, draft, authorName: AUTHOR_NAME,
      imageUrl: sel.heroImageUrl, imageAlt: sel.heroAlt, relatedHandles: sel.handles
    });
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
    relatedHandlesJson: JSON.stringify(sel.handles),
    heroImageUrl: sel.heroImageUrl,
    heroSourceHandle: sel.heroSourceHandle,
    model: 'blog-pipeline'
  });

  return {
    ok: true,
    articleId: created.id,
    articleHandle: created.handle,
    title: created.title,
    collectionHandle: brief.collectionHandle,
    claimFlags,
    briefAngle: brief.angle,
    relatedHandles: sel.handles,
    heroImageUrl: sel.heroImageUrl,
    heroSourceHandle: sel.heroSourceHandle,
    heroIsHighRes: sel.heroIsHighRes
  };
}

export interface BlogEnrichResult {
  ok: boolean;
  error?: string;
  articleId?: string;
  relatedHandles?: string[];
  heroImageUrl?: string;
  heroSourceHandle?: string;
  heroIsHighRes?: boolean; // hero source is >= 1200x1200 (a true 1200 og:image)
  imageSet?: boolean;   // did we set a hero (only when the article had none)
  hadImage?: boolean;   // did the article already carry a hero (left untouched)
}

/**
 * Backfill an EXISTING draft with the shop-block metafield + a hero image (used
 * for posts authored before the pipeline set these). Reads the article body to
 * pick the products it links, grounds the funnel collection to top up + supply
 * images, and writes the metafield. A hero image is set ONLY when the article
 * has none, so an owner-chosen image is never overwritten. The chosen set is
 * recorded to D1 so it can be confirmed later. `articleId` defaults to the most
 * recent draft. Never publishes; degrades to {ok:false,error} on any failure.
 */
export async function enrichBlogPost(
  env: Env, store: TenantStore, cfg: TenantConfig,
  opts: { articleId?: string }, fetchImpl: typeof fetch = defaultFetch
): Promise<BlogEnrichResult> {
  const rows = await store.listBlogPostDrafts();
  if (!rows.length) return { ok: false, error: 'No drafted posts to enrich.' };
  const row = opts.articleId
    ? rows.find((r) => r.shopify_article_id === opts.articleId)
    : rows[0];
  if (!row || !row.shopify_article_id) return { ok: false, error: 'Post not found.' };
  const articleId = row.shopify_article_id;
  if (!row.collection_handle) return { ok: false, error: 'Post has no funnel collection to source products from.' };

  const admin = await adminForShop(env, store, fetchImpl).catch(() => null);
  if (!admin) return { ok: false, error: 'Shopify connection unavailable (needs the write_content scope + a live token).' };

  await ensureRelatedProductsDefinition(admin);

  let article;
  try {
    article = await getArticleForEnrich(admin, articleId);
  } catch (e) {
    return { ok: false, error: `Could not read the article: ${(e as Error).message}` };
  }
  if (!article) return { ok: false, error: 'Article no longer exists.' };

  const pack = await groundCollection(admin, row.collection_handle);
  if (!pack) return { ok: false, error: `Funnel collection '${row.collection_handle}' has no products to source.` };

  const sel = selectShopBlock(pack, article.bodyHtml);
  if (!sel.handles.length) return { ok: false, error: 'No available products found to build the shop block.' };

  const setImage = !article.hasImage && !!sel.heroImageUrl;
  try {
    await updateArticleAssets(admin, {
      articleId,
      relatedHandles: sel.handles,
      imageUrl: setImage ? sel.heroImageUrl : undefined,
      imageAlt: sel.heroAlt
    });
  } catch (e) {
    return { ok: false, error: `Update failed: ${(e as Error).message}` };
  }

  await store.setBlogPostAssets(articleId, {
    relatedHandlesJson: JSON.stringify(sel.handles),
    heroImageUrl: setImage ? sel.heroImageUrl : (article.hasImage ? '(owner image kept)' : null),
    heroSourceHandle: setImage ? sel.heroSourceHandle : null
  });

  return {
    ok: true,
    articleId,
    relatedHandles: sel.handles,
    heroImageUrl: setImage ? sel.heroImageUrl : undefined,
    heroSourceHandle: setImage ? sel.heroSourceHandle : undefined,
    heroIsHighRes: setImage ? sel.heroIsHighRes : undefined,
    imageSet: setImage,
    hadImage: article.hasImage
  };
}

export interface BlogTopicsResult {
  ok: boolean;
  error?: string;
  candidates?: BlogTopicCandidate[];
}

// Enough live products to fill a 4-item shop block AND give the drafter products
// to link in the body without running dry.
const MIN_LIVE_FOR_TOPIC = 4;

/**
 * Research a set of topic suggestions the owner can pick from. Grounds EVERY
 * configured collection, keeps only those with enough live on-storefront
 * products, and asks the research agent to propose diverse topics FROM those
 * real products. Every returned candidate is therefore congruent + buildable
 * before drafting starts, and carries a full brief the owner sends straight to
 * generation. Degrades to {ok:false,error}.
 */
export async function proposeBlogTopics(
  env: Env, store: TenantStore, cfg: TenantConfig,
  opts: { nowMonth0: number }, fetchImpl: typeof fetch = defaultFetch
): Promise<BlogTopicsResult> {
  const admin = await adminForShop(env, store, fetchImpl).catch(() => null);
  if (!admin) return { ok: false, error: 'Shopify connection unavailable (needs the write_content scope + a live token).' };

  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);
  if (!llm.available) return { ok: false, error: 'No LLM configured.' };

  const validHandles = Object.values(cfg.collectionMap).map((c) => c.handle).filter(Boolean);
  if (!validHandles.length) return { ok: false, error: 'No collections configured to funnel into.' };

  const packs = [];
  for (const h of validHandles) {
    const pack = await groundCollection(admin, h, 12);
    if (pack && pack.products.filter((p) => p.available).length >= MIN_LIVE_FOR_TOPIC) packs.push(pack);
  }
  if (!packs.length) return { ok: false, error: 'No collection has enough live products yet to build a topic from.' };

  const candidates = await proposeTopics(llm, store, cfg, { packs, season: seasonForMonth(opts.nowMonth0) });
  if (!candidates.length) return { ok: false, error: 'Could not research topics right now. Please try again.' };
  return { ok: true, candidates };
}
