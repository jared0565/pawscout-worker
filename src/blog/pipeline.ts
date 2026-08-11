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
import type { BlogBrief, BlogTopicCandidate, DemandEvidence } from './types';
// Both former seasonForMonth call sites now use publishWindow: the pipeline only
// ever asked "what season is it" in order to CHOOSE a topic, which is exactly the
// question that needs to lead the calendar. seasonForMonth stays exported and is
// still what publishWindow is built from.
import { proposeBrief, proposeTopics, validateBrief, publishWindow, collectSourcedFacts } from './research';
import { groundCollection } from './ground';
import { draftArticle } from './draft';
import { findClaimFlags } from './quality';
import { selectShopBlock, pickHeroFields, extractProductHandles } from './select';
import type { ShopBlockSelection } from './select';
import { pickComboHandles, availableByHandle } from './combo';
import type { ComboArticle } from './combo';
import { getProductImages, pickBlogHeroImage } from './hero';
import type { AdminGraphql } from '../shopify-admin';
import { findBlog, renameBlog, createDraftArticle, ensureRelatedProductsDefinition, getArticleForEnrich, updateArticleAssets, getPublishedMap, updateArticleContent } from './article';
import type { FactPack } from './types';
import { reindexArticle } from '../catalog/referrers';

/**
 * Resolve the hero image: prefer a pet-with-product LIFESTYLE frame (converts
 * better in an article) from the chosen product's full gallery, falling back to
 * the plain featured pick the selector already made. The vision pass knows the
 * ARTICLE title and may reject the whole gallery (2026-07-10 defect: a hero
 * disconnected from the post's subject), in which case the congruent product's
 * featured image stands. Returns the url + whether it is a true >=1200 square
 * (a lifestyle frame may be smaller - that trade-off is surfaced to the owner,
 * not hidden).
 */
async function resolveHero(
  admin: AdminGraphql, llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  sel: ShopBlockSelection, articleTitle: string
): Promise<{ url?: string; alt?: string; highRes?: boolean }> {
  let url = sel.heroImageUrl;
  const alt = sel.heroAlt;
  let highRes = sel.heroIsHighRes;
  if (sel.heroSourceHandle) {
    const imgs = await getProductImages(admin, sel.heroSourceHandle);
    const picked = await pickBlogHeroImage(llm, store, cfg, { articleTitle, productTitle: alt ?? articleTitle }, imgs);
    if (picked) {
      url = picked.url;
      highRes = picked.width >= 1200 && picked.height >= 1200;
    }
  }
  return { url, alt, highRes };
}

/**
 * Choose the final "Shop this guide" selection for an article: ground every
 * other configured collection (best effort), let the merchandiser pick a
 * congruent set across the WHOLE live catalog (body-linked products always
 * lead), and derive the hero from the FINAL set. Falls back to the old
 * deterministic single-collection selection only when the merchandiser has no
 * better answer (no LLM and nothing linked), so the block never blind-pads
 * with off-topic items when a judgment was possible.
 */
async function selectShopBlockAcross(
  admin: AdminGraphql, llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  opts: { primary: FactPack; validHandles: string[]; article: ComboArticle }
): Promise<ShopBlockSelection> {
  const packs: FactPack[] = [opts.primary];
  for (const h of opts.validHandles) {
    if (h === opts.primary.collectionHandle) continue;
    const pack = await groundCollection(admin, h);
    if (pack) packs.push(pack);
  }
  const combo = await pickComboHandles(llm, store, cfg, {
    article: opts.article, packs, linkedHandles: extractProductHandles(opts.article.bodyHtml)
  });
  if (combo === null) return selectShopBlock(opts.primary, opts.article.bodyHtml);
  return { handles: combo.handles, ...pickHeroFields(availableByHandle(packs), combo.handles, combo.linkedCount) };
}

export const BLOG_HANDLE = 'guides';       // the clean handle we want: /blogs/guides (also imported by src/syndicate)
const BLOG_LEGACY_HANDLE = 'news';         // the default blog we reuse + migrate FROM
const BLOG_TITLE = 'Pet Care Guides';      // its display title
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
    if (!blog) {
      // First run after the /blogs/guides choice: migrate the reused default
      // blog (handle 'news') to the clean handle + title, once. Idempotent
      // thereafter (found directly by 'guides').
      const legacy = await findBlog(admin, BLOG_LEGACY_HANDLE);
      if (!legacy) return { ok: false, error: `Blog not found ('${BLOG_HANDLE}' or '${BLOG_LEGACY_HANDLE}').` };
      blog = await renameBlog(admin, legacy.id, BLOG_TITLE, BLOG_HANDLE);
    } else if (blog.title !== BLOG_TITLE) {
      blog = await renameBlog(admin, blog.id, BLOG_TITLE);
    }
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
      validHandles, window: publishWindow(opts.nowMonth0), topicHint: opts.topicHint
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

  // Verified, source-linked facts the drafter may cite (best effort: an empty
  // list keeps the drafter hermetic exactly as before).
  const facts = await collectSourcedFacts(llm, store, cfg, {
    title: brief.title, angle: brief.angle, keyPoints: brief.keyPoints
  });

  // Draft -> LLM writes, blog gate refines.
  const draft = await draftArticle(llm, store, cfg, brief, pack, {}, facts);
  if (!draft) return { ok: false, error: 'Draft agent could not produce an article.' };

  const claimFlags = findClaimFlags(draft.bodyHtml);

  // Shop block + hero: products the body links come first, then the merchandiser
  // tops up with CONGRUENT picks from across all collections (never blind
  // same-collection padding). The hero prefers a pet-with-product lifestyle frame.
  const sel = await selectShopBlockAcross(admin, llm, store, cfg, {
    primary: pack, validHandles,
    article: { title: draft.title, angle: brief.angle, bodyHtml: draft.bodyHtml }
  });
  const hero = await resolveHero(admin, llm, store, cfg, sel, draft.title);

  // Create the DRAFT article (isPublished:false) + stage the bookkeeping row.
  let created;
  try {
    created = await createDraftArticle(admin, {
      blogId: blog.id, draft, authorName: AUTHOR_NAME,
      imageUrl: hero.url, imageAlt: hero.alt, relatedHandles: sel.handles
    });
  } catch (e) {
    return { ok: false, error: `Article creation failed: ${(e as Error).message}` };
  }

  // Bookkeeping is best-effort: the DRAFT article already exists in Shopify, so a
  // D1 hiccup must never surface as a 500 (which would read as "post failed" when
  // it actually succeeded). Log and continue.
  try {
    await store.insertBlogPostDraft({
      id: crypto.randomUUID(),
      shopifyArticleId: created.id,
      blogHandle: BLOG_HANDLE,
      title: created.title,
      collectionHandle: brief.collectionHandle,
      briefJson: JSON.stringify(brief),
      claimFlagsJson: JSON.stringify(claimFlags),
      relatedHandlesJson: JSON.stringify(sel.handles),
      heroImageUrl: hero.url,
      heroSourceHandle: sel.heroSourceHandle,
      model: 'blog-pipeline'
    });
  } catch (e) {
    console.warn(`blog bookkeeping insert failed (article ${created.id} was created): ${(e as Error).message}`);
  }

  return {
    ok: true,
    articleId: created.id,
    articleHandle: created.handle,
    title: created.title,
    collectionHandle: brief.collectionHandle,
    claimFlags,
    briefAngle: brief.angle,
    relatedHandles: sel.handles,
    heroImageUrl: hero.url,
    heroSourceHandle: sel.heroSourceHandle,
    heroIsHighRes: hero.highRes
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
export interface BlogRegenResult {
  ok: boolean;
  error?: string;
  articleId?: string;
  handle?: string;
  title?: string;
  claimFlags?: ReturnType<typeof findClaimFlags>;
}

/**
 * REGENERATE an existing article's whole content in place.
 *
 * Why this exists (owner, 2026-07-27): refreshing the Shop-this-guide block only
 * rewrites the related_products metafield, so it can never repair the article
 * BODY. When a published post is structurally wrong (the case here: two links to
 * charities that run competing shops), repointing links is a patch; rewriting
 * the piece with the current, gated pipeline is the real remedy. There was no
 * route for that at all, only "generate a NEW post".
 *
 * The rewrite reuses the article's OWN title and funnel tag as the brief, so it
 * stays the same piece of content rather than drifting to a new topic, and the
 * handle is preserved so the live URL keeps working. Everything the normal
 * pipeline enforces applies, including the link hard gate: if the fresh draft
 * cannot pass it, draftArticle returns null and NOTHING is written, leaving the
 * existing article untouched.
 */
export async function regenerateArticle(
  env: Env, store: TenantStore, cfg: TenantConfig,
  opts: { articleId: string }, fetchImpl: typeof fetch = defaultFetch
): Promise<BlogRegenResult> {
  const admin = await adminForShop(env, store, fetchImpl).catch(() => null);
  if (!admin) return { ok: false, error: 'Shopify connection unavailable (needs the write_content scope + a live token).' };

  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);
  if (!llm.available) return { ok: false, error: 'No LLM configured.' };

  const existing = await getArticleForEnrich(admin, opts.articleId).catch(() => null);
  if (!existing) return { ok: false, error: 'Article not found.' };

  const validHandles = Object.values(cfg.collectionMap).map((c) => c.handle).filter(Boolean);
  if (validHandles.length === 0) return { ok: false, error: 'No collections configured to funnel into.' };

  // Keep the article on its own funnel collection when the tag still resolves;
  // otherwise fall through to any collection that has live products, exactly as
  // the create path does, so a retired collection cannot strand a rewrite.
  const tagged = existing.tags.find((t) => validHandles.includes(t));
  let pack = tagged ? await groundCollection(admin, tagged) : null;
  if (!pack) {
    for (const h of validHandles) {
      pack = await groundCollection(admin, h);
      if (pack && pack.products.some((p) => p.available)) break;
      pack = null;
    }
  }
  if (!pack) return { ok: false, error: 'No collection with products to ground the rewrite in.' };

  // The article IS the brief: same title, same funnel, so a regeneration is a
  // rewrite of this piece and not a new topic.
  const brief: BlogBrief = {
    title: existing.title,
    angle: `Rewrite of the existing guide "${existing.title}", same subject and reader promise.`,
    targetKeyword: existing.title,
    collectionHandle: pack.collectionHandle,
    whyNow: 'Regenerated on owner request.',
    keyPoints: ['Cover the same ground as the existing guide', 'Ground every product claim in the supplied facts', 'Link only Active Paw pages']
  };

  // No external sources exist any more (src/blog/sources.ts), so this is [].
  const facts = await collectSourcedFacts(llm, store, cfg, {
    title: brief.title, angle: brief.angle, keyPoints: brief.keyPoints
  });

  const draft = await draftArticle(llm, store, cfg, brief, pack, {}, facts);
  if (!draft) return { ok: false, error: 'Draft agent could not produce a clean article (the link gate blocks a draft that carries an external link). The existing article was left untouched.' };

  const claimFlags = findClaimFlags(draft.bodyHtml);

  const sel = await selectShopBlockAcross(admin, llm, store, cfg, {
    primary: pack, validHandles,
    article: { title: draft.title, angle: brief.angle, bodyHtml: draft.bodyHtml }
  });
  const hero = await resolveHero(admin, llm, store, cfg, sel, draft.title);

  try {
    const updated = await updateArticleContent(admin, {
      articleId: existing.id, draft,
      imageUrl: hero.url, imageAlt: hero.alt, relatedHandles: sel.handles
    });
    // A rewrite changes which products this guide points at, in both directions.
    // Reindex from what we just wrote so the guard sees the new picks without
    // waiting for tonight's rebuild.
    await reindexArticle(store, { articleId: existing.id, bodyHtml: draft.bodyHtml, relatedHandles: sel.handles });
    return { ok: true, articleId: updated.id, handle: updated.handle, title: updated.title, claimFlags };
  } catch (e) {
    return { ok: false, error: `Article update failed: ${(e as Error).message}` };
  }
}

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

  const llm = new LlmClient({ openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY }, fetchImpl);

  let article;
  try {
    article = await getArticleForEnrich(admin, articleId);
  } catch (e) {
    return { ok: false, error: `Could not read the article: ${(e as Error).message}` };
  }
  if (!article) return { ok: false, error: 'Article no longer exists.' };

  const pack = await groundCollection(admin, row.collection_handle);
  if (!pack) return { ok: false, error: `Funnel collection '${row.collection_handle}' has no products to source.` };

  // Same merchandiser flow as generation, so re-running enrich on an older post
  // replaces a blind same-collection top-up with congruent cross-catalog picks.
  const validHandles = Object.values(cfg.collectionMap).map((c) => c.handle).filter(Boolean);
  const sel = await selectShopBlockAcross(admin, llm, store, cfg, {
    primary: pack, validHandles,
    article: { title: article.title || 'Active Paw guide', bodyHtml: article.bodyHtml }
  });
  if (!sel.handles.length) return { ok: false, error: 'No available products found to build the shop block.' };

  const setImage = !article.hasImage && !!sel.heroImageUrl;
  // Only pay for the vision hero pick when we are actually going to set an image.
  const hero = setImage
    ? await resolveHero(admin, llm, store, cfg, sel, article.title || 'Active Paw guide')
    : { url: undefined as string | undefined, alt: sel.heroAlt, highRes: undefined as boolean | undefined };
  try {
    await updateArticleAssets(admin, {
      articleId,
      relatedHandles: sel.handles,
      imageUrl: setImage ? hero.url : undefined,
      imageAlt: sel.heroAlt
    });
  } catch (e) {
    return { ok: false, error: `Update failed: ${(e as Error).message}` };
  }

  // Enrich replaces the Shop-this-guide picks, which are referrers in their own
  // right. Body is unchanged here, so it is re-read from the article we already
  // fetched rather than re-queried.
  await reindexArticle(store, { articleId, bodyHtml: article.bodyHtml, relatedHandles: sel.handles });

  await store.setBlogPostAssets(articleId, {
    relatedHandlesJson: JSON.stringify(sel.handles),
    heroImageUrl: setImage ? hero.url : (article.hasImage ? '(owner image kept)' : null),
    heroSourceHandle: setImage ? sel.heroSourceHandle : null
  });

  return {
    ok: true,
    articleId,
    relatedHandles: sel.handles,
    heroImageUrl: setImage ? hero.url : undefined,
    heroSourceHandle: setImage ? sel.heroSourceHandle : undefined,
    heroIsHighRes: setImage ? hero.highRes : undefined,
    imageSet: setImage,
    hadImage: article.hasImage
  };
}

export interface BlogTopicsResult {
  ok: boolean;
  error?: string;
  candidates?: BlogTopicCandidate[];
  /** Whether these were ranked on live demand research, and the evidence.
   *  Carried to the console so a degraded run is VISIBLE instead of looking
   *  identical to a researched one. */
  demand?: DemandEvidence;
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
    const pack = await groundCollection(admin, h);
    if (pack && pack.products.filter((p) => p.available).length >= MIN_LIVE_FOR_TOPIC) packs.push(pack);
  }
  if (!packs.length) return { ok: false, error: 'No collection has enough live products yet to build a topic from.' };

  const { candidates, demand } = await proposeTopics(llm, store, cfg, { packs, window: publishWindow(opts.nowMonth0) });
  if (!candidates.length) return { ok: false, error: 'Could not research topics right now. Please try again.' };
  return { ok: true, candidates, demand };
}

type BlogPostRow = Awaited<ReturnType<TenantStore['listBlogPostDrafts']>>[number];

/**
 * List the staged posts, first flipping any 'drafted' row whose Shopify article
 * the owner has since published (publishing happens in Shopify admin, so D1
 * follows Shopify, never the other way round). Sync is best-effort: if the
 * Admin API is unreachable the list still returns, just with stale statuses.
 */
export async function listPostsSynced(
  env: Env, store: TenantStore, fetchImpl: typeof fetch = defaultFetch
): Promise<BlogPostRow[]> {
  const rows = await store.listBlogPostDrafts();
  const stale = rows.filter((r) => r.status === 'drafted' && r.shopify_article_id);
  if (stale.length) {
    try {
      const admin = await adminForShop(env, store, fetchImpl);
      if (!admin) return rows; // no Shopify connection: stale statuses beat a 500
      const published = await getPublishedMap(admin, stale.map((r) => r.shopify_article_id as string));
      for (const r of stale) {
        if (published.get(r.shopify_article_id as string) !== true) continue;
        await store.setBlogPostStatus(r.id, 'published');
        r.status = 'published';
      }
    } catch (e) {
      console.warn(`blog status sync skipped: ${(e as Error).message}`);
    }
  }
  return rows;
}
