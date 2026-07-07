// src/blog/draft.ts
//
// The DRAFT agent: given an approved brief + a grounded fact pack, the LLM
// writes a full article, then the blog quality/fabrication gate refines it.
// Blog-local scaffolding (NOT imported from src/inbox): the rules overlap with
// the store's reply voice but the job is different, and isolation keeps the
// tested inbox path untouched.

import { LlmClient } from '../llm';
import { resolveChain } from '../llm-resolve';
import type { TenantConfig } from '../types';
import type { TenantStore } from '../tenant-store';
import type { BlogBrief, BlogDraft, FactPack } from './types';
import { factPackToPrompt } from './ground';
import { refineBlogUntilClean, type BlogQualityContext } from './quality';

/** Strip em/en dashes from generated HTML (house rule; the inbox sanitiser is
 *  inbox code, so the blog keeps its own one-liner). */
export function sanitizeBlogHtml(html: string): string {
  return html.replace(/[—–―]/g, '-');
}

const BLOG_STORE_CONTEXT =
  'Active Paw is a UK pet-care store for dogs and cats. It ships to the UK and internationally. ' +
  'NEVER claim or imply Active Paw ships or dispatches from its own UK warehouse, and never name a dispatch country or a supplier. ' +
  'Do not invent prices, delivery dates, discounts, stock levels, statistics, or study citations. ' +
  'You may reference ONLY the real products given to you in the facts, using their EXACT link paths.';

const BLOG_WRITING_RULES =
  'You are an expert pet-care writer for Active Paw. Write a genuinely useful, honest buying-guide / how-to article for pet owners. ' +
  'Voice: warm, practical, plain UK English a normal pet owner instantly understands. No jargon, no hype, no fluff, no corporate phrasing. ' +
  'Ground every factual claim in common, widely-accepted pet-care knowledge or in the provided product facts. ' +
  'HEALTH SAFETY: you may give general lifestyle guidance, but never state medical, veterinary, dosage, or safety-guarantee claims. When a topic touches health, hedge honestly and tell the reader to consult their vet for anything sudden or serious. Never say "vet recommended", "clinically proven", "cures", "prevents", or give doses. ' +
  'Structure: an inviting opening, then 3-6 <h2> sections, short paragraphs, and <ul> lists where they help. Naturally work in a link to at least one real product or the collection using the EXACT paths provided (an <a href="/products/..."> or <a href="/collections/...">). Do not force it; make the tie-in genuinely relevant. ' +
  'Never use em-dashes or en-dashes; use a comma, a full stop, or a hyphen. ' +
  'The body is HTML using only <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, and <a> tags. No inline styles, no headings above <h2>, no <h1> (the theme renders the title).';

function outputContract(): string {
  return 'Respond with ONLY JSON in this field order: {' +
    '"title": <the article title, specific and search-friendly, no site name>, ' +
    '"bodyHtml": <the article body as HTML per the rules>, ' +
    '"excerpt": <one or two plain-sentence summary for the listing card>, ' +
    '"metaTitle": <SEO title, <= 60 chars>, ' +
    '"metaDescription": <SEO meta description, 50-160 chars, compelling>}.';
}

function buildSystem(brief: BlogBrief, factPackText: string, revisionIssues?: string[]): string {
  return [
    BLOG_WRITING_RULES,
    BLOG_STORE_CONTEXT,
    `Brief you are writing to: title "${brief.title}"; angle: ${brief.angle}; target reader intent: ${brief.targetKeyword}. Cover these points: ${brief.keyPoints.join('; ')}.`,
    factPackText,
    revisionIssues?.length
      ? `REVISION REQUIRED: your previous draft (provided as previousDraft) was rejected by a quality reviewer. Rewrite it in full to fix EVERY issue, staying accurate and grounded: ${revisionIssues.join(' ')}`
      : '',
    outputContract()
  ].filter(Boolean).join(' ');
}

function validateBlogDraft(v: unknown, tag: string): BlogDraft | null {
  const o = v as Record<string, unknown>;
  if (typeof o !== 'object' || o === null) return null;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const bodyHtml = typeof o.bodyHtml === 'string' ? o.bodyHtml.trim() : '';
  const excerpt = typeof o.excerpt === 'string' ? o.excerpt.trim() : '';
  const metaTitle = typeof o.metaTitle === 'string' ? o.metaTitle.trim() : '';
  const metaDescription = typeof o.metaDescription === 'string' ? o.metaDescription.trim() : '';
  if (!title || !bodyHtml) return null;
  return {
    title: title.slice(0, 180),
    bodyHtml: sanitizeBlogHtml(bodyHtml).slice(0, 40000),
    excerpt: sanitizeBlogHtml(excerpt).slice(0, 500),
    metaTitle: (metaTitle || title).slice(0, 70),
    metaDescription: sanitizeBlogHtml(metaDescription).slice(0, 200),
    tag
  };
}

/**
 * Draft an article for a brief, grounded in the fact pack. Returns the best
 * draft after the refine loop, or null if the LLM is unavailable. The tag is
 * the brief's collection handle (drives the theme's related-products block).
 */
export async function draftArticle(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  brief: BlogBrief, pack: FactPack, ctx: BlogQualityContext = {}
): Promise<BlogDraft | null> {
  const chain = resolveChain(cfg, 'text');
  const factPackText = factPackToPrompt(pack);
  const tag = brief.collectionHandle;
  const baseUser = JSON.stringify({ title: brief.title, angle: brief.angle, keyPoints: brief.keyPoints });

  const initialResult = await llm.jsonChain<BlogDraft>({
    chain, maxTokens: 2600,
    system: buildSystem(brief, factPackText),
    user: baseUser,
    validate: (v) => validateBlogDraft(v, tag)
  });
  if (!initialResult.ok) { console.warn(`blog draft failed: ${initialResult.error}`); return null; }
  await store.logLlmUsage('blog-draft', initialResult.usage.model, initialResult.usage.promptTokens, initialResult.usage.completionTokens, initialResult.usage.costUsd);

  const revise = async (prev: BlogDraft, issues: string[]): Promise<BlogDraft | null> => {
    const r = await llm.jsonChain<BlogDraft>({
      chain, maxTokens: 2600,
      system: buildSystem(brief, factPackText, issues),
      user: JSON.stringify({ ...JSON.parse(baseUser), previousDraft: prev.bodyHtml.slice(0, 6000) }),
      validate: (v) => validateBlogDraft(v, tag)
    });
    if (!r.ok) { console.warn(`blog revise failed: ${r.error}`); return null; }
    await store.logLlmUsage('blog-revise', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
    return r.value;
  };

  return refineBlogUntilClean(initialResult.value, revise, ctx);
}
