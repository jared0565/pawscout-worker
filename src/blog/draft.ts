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
import type { BlogBrief, BlogDraft, BlogFaqEntry, FactPack, SourcedFact } from './types';
import { factPackToPrompt } from './ground';
import { refineBlogUntilClean, htmlToText, type BlogQualityContext } from './quality';
import { scrubExternalLinks } from './sources';

/** Strip em/en dashes from generated HTML (house rule; the inbox sanitiser is
 *  inbox code, so the blog keeps its own one-liner). */
export function sanitizeBlogHtml(html: string): string {
  return html.replace(/[—–―]/g, '-');
}

const BLOG_STORE_CONTEXT =
  'Active Paw is a UK pet-care store for dogs and cats. It ships to the UK and internationally. ' +
  'NEVER claim or imply Active Paw ships or dispatches from its own UK warehouse, and never name a dispatch country or a supplier. ' +
  'Do not invent prices, delivery dates, discounts, stock levels, statistics, or study citations. The ONLY statistics or external claims you may use are the VERIFIED FACTS explicitly provided to you, cited with their source link. ' +
  'You may reference ONLY the real products given to you in the facts, using their EXACT link paths.';

const BLOG_WRITING_RULES =
  'You are an expert pet-care writer for Active Paw. Write a genuinely useful, honest buying-guide / how-to article for pet owners. ' +
  'Voice: warm, practical, plain UK English a normal pet owner instantly understands. No jargon, no hype, no fluff, no corporate phrasing. ' +
  'Ground every factual claim in common, widely-accepted pet-care knowledge or in the provided product facts. ' +
  'HEALTH SAFETY: you may give general lifestyle guidance, but never state medical, veterinary, dosage, or safety-guarantee claims. When a topic touches health, hedge honestly and tell the reader to consult their vet for anything sudden or serious. Never say "vet recommended", "clinically proven", "cures", "prevents", or give doses. ' +
  'QUICK ANSWER FIRST: the body MUST open with a single <p> of 40-60 words that directly and completely answers the reader\'s core question, before the first <h2>. Search engines and AI assistants lift this paragraph verbatim, so it must stand alone: no "read on to find out", no teaser. ' +
  'Structure after the quick answer: 3-6 <h2> sections, short paragraphs, and <ul> lists where they help. Naturally work in a link to at least one real product or the collection using the EXACT paths provided (an <a href="/products/..."> or <a href="/collections/...">). Do not force it; make the tie-in genuinely relevant. ' +
  'Never use em-dashes or en-dashes; use a comma, a full stop, or a hyphen. ' +
  'The body is HTML using only <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, and <a> tags. No inline styles, no headings above <h2>, no <h1> (the theme renders the title).';

function outputContract(): string {
  return 'Respond with ONLY JSON in this field order: {' +
    '"title": <the article title, specific and search-friendly, no site name>, ' +
    '"bodyHtml": <the article body as HTML per the rules>, ' +
    '"excerpt": <one or two plain-sentence summary for the listing card>, ' +
    '"metaTitle": <SEO title, <= 60 chars>, ' +
    '"metaDescription": <SEO meta description, 50-160 chars, compelling>, ' +
    '"faq": <array of 3-5 {"q": <a question a pet owner genuinely asks about this topic, natural phrasing>, "a": <a 40-80 word plain-text answer, grounded exactly like the article, no HTML>}>}.';
}

function factsToPrompt(facts: SourcedFact[]): string {
  if (!facts.length) return '';
  const lines = facts.map((f) => `- "${f.fact}" (source: ${f.sourceName}, ${f.sourceUrl})`);
  return [
    'VERIFIED FACTS you may cite (optional; use one only where it genuinely strengthens the article).',
    'When you use one, weave it in naturally and hyperlink its source inline, e.g. <a href="URL">source name</a>. Never alter the numbers, never cite anything not in this list.',
    'These are the ONLY external links the article may contain; any other external link is stripped automatically:',
    ...lines
  ].join('\n');
}

function buildSystem(brief: BlogBrief, factPackText: string, facts: SourcedFact[], revisionIssues?: string[]): string {
  return [
    BLOG_WRITING_RULES,
    BLOG_STORE_CONTEXT,
    `Brief you are writing to: title "${brief.title}"; angle: ${brief.angle}; target reader intent: ${brief.targetKeyword}. Cover these points: ${brief.keyPoints.join('; ')}.`,
    factPackText,
    factsToPrompt(facts),
    revisionIssues?.length
      ? `REVISION REQUIRED: your previous draft (provided as previousDraft) was rejected by a quality reviewer. Rewrite it in full to fix EVERY issue, staying accurate and grounded: ${revisionIssues.join(' ')}`
      : '',
    outputContract()
  ].filter(Boolean).join(' ');
}

/** Parse the faq array: plain-text Q&As only (tags stripped), capped at 5.
 *  Anything malformed is dropped rather than failing the whole draft - the
 *  quality gate then asks the reviser for a proper FAQ. */
export function validateFaq(v: unknown): BlogFaqEntry[] {
  if (!Array.isArray(v)) return [];
  const out: BlogFaqEntry[] = [];
  for (const item of v) {
    const o = item as Record<string, unknown>;
    const q = typeof o?.q === 'string' ? htmlToText(sanitizeBlogHtml(o.q)).trim() : '';
    const a = typeof o?.a === 'string' ? htmlToText(sanitizeBlogHtml(o.a)).trim() : '';
    if (!q || !a) continue;
    out.push({ q: q.slice(0, 200), a: a.slice(0, 600) });
    if (out.length >= 5) break;
  }
  return out;
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
  // scrubExternalLinks runs on EVERY draft and revision: a competitor or
  // retailer link can never survive to Shopify no matter what the LLM wrote.
  return {
    title: title.slice(0, 180),
    bodyHtml: scrubExternalLinks(sanitizeBlogHtml(bodyHtml)).slice(0, 40000),
    excerpt: scrubExternalLinks(sanitizeBlogHtml(excerpt)).slice(0, 500),
    metaTitle: (metaTitle || title).slice(0, 70),
    metaDescription: sanitizeBlogHtml(metaDescription).slice(0, 200),
    tag,
    faq: validateFaq(o.faq)
  };
}

/**
 * Draft an article for a brief, grounded in the fact pack. Returns the best
 * draft after the refine loop, or null if the LLM is unavailable. The tag is
 * the brief's collection handle (drives the theme's related-products block).
 * `facts` are the research step's verified, source-linked facts: the ONLY
 * external statistics the drafter is allowed to cite.
 */
export async function draftArticle(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  brief: BlogBrief, pack: FactPack, ctx: BlogQualityContext = {}, facts: SourcedFact[] = []
): Promise<BlogDraft | null> {
  const chain = resolveChain(cfg, 'text');
  const factPackText = factPackToPrompt(pack);
  const tag = brief.collectionHandle;
  const baseUser = JSON.stringify({ title: brief.title, angle: brief.angle, keyPoints: brief.keyPoints });

  const initialResult = await llm.jsonChain<BlogDraft>({
    chain, maxTokens: 4800,
    system: buildSystem(brief, factPackText, facts),
    user: baseUser,
    validate: (v) => validateBlogDraft(v, tag)
  });
  if (!initialResult.ok) { console.warn(`blog draft failed: ${initialResult.error}`); return null; }
  await store.logLlmUsage('blog-draft', initialResult.usage.model, initialResult.usage.promptTokens, initialResult.usage.completionTokens, initialResult.usage.costUsd);

  const revise = async (prev: BlogDraft, issues: string[]): Promise<BlogDraft | null> => {
    const r = await llm.jsonChain<BlogDraft>({
      chain, maxTokens: 4800,
      system: buildSystem(brief, factPackText, facts, issues),
      user: JSON.stringify({ ...JSON.parse(baseUser), previousDraft: prev.bodyHtml.slice(0, 6000) }),
      validate: (v) => validateBlogDraft(v, tag)
    });
    if (!r.ok) { console.warn(`blog revise failed: ${r.error}`); return null; }
    await store.logLlmUsage('blog-revise', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
    return r.value;
  };

  return refineBlogUntilClean(initialResult.value, revise, ctx);
}
