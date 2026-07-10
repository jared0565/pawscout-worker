// src/blog/quality.ts
//
// Blog-specific quality + fabrication gate. ISOLATED from src/inbox/draft-quality.ts
// on purpose: the inbox gate penalises length over ~110 words and encodes
// reply-specific rules; a blog article needs the opposite. This module has its
// own deterministic scorers and its own refine loop. No I/O, no LLM.
//
// Two kinds of output, per docs/blog-rss-pinterest-traffic-prd-audit.md Q4:
//   findBlogIssues  -> MECHANICAL hard issues that drive the self-correction loop
//                      (too short/long, no product link, no meta description...).
//   findClaimFlags  -> sentences making health / safety / dosage / guarantee
//                      claims. NOT auto-fixable and NOT blocking: they are
//                      surfaced to the HUMAN reviewer ("verify this line"),
//                      because a regex can never verify an open-ended pet-care
//                      claim. The human publish gate is the real backstop.

import type { BlogDraft } from './types';

/** Strip HTML tags to plain text for word/sentence analysis. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** True when the body links to at least one real storefront path (a product or
 *  collection). The editorial rule: every post funnels into real stock. */
export function hasStorefrontLink(bodyHtml: string): boolean {
  return /href\s*=\s*["'](?:https?:\/\/[^"']*)?\/(?:products|collections)\/[a-z0-9-]+/i.test(bodyHtml);
}

/** Text of the opening paragraph, when a <p> opens the body before the first
 *  <h2>. Empty string otherwise. This is the "quick answer" search engines and
 *  AI assistants lift, so the gate can hold it to a standalone 40-60 words. */
export function quickAnswerText(bodyHtml: string): string {
  const h2At = bodyHtml.search(/<h2[\s>]/i);
  const head = h2At === -1 ? bodyHtml : bodyHtml.slice(0, h2At);
  const m = head.match(/<p[\s>][^]*?<\/p>/i);
  return m ? htmlToText(m[0]) : '';
}

export interface BlogQualityContext {
  minWords?: number; // floor (default 350: a real guide, not a thin snippet)
  maxWords?: number; // ceiling (default 1200)
}

/**
 * Mechanical issues that DRIVE the refine loop. Empty => the draft clears the
 * mechanical bar. Each string is actionable feedback for the reviser.
 */
export function findBlogIssues(draft: BlogDraft, ctx: BlogQualityContext = {}): string[] {
  const issues: string[] = [];
  const text = htmlToText(draft.bodyHtml);
  const words = countWords(text);
  const min = ctx.minWords ?? 350;
  const max = ctx.maxWords ?? 1200;

  if (!draft.title || draft.title.trim().length < 8) {
    issues.push('The title is missing or too short. Provide a clear, specific, search-friendly title.');
  }
  if (words < min) {
    issues.push(`The article is too short (${words} words). Write a genuinely useful guide of at least ${min} words, with real substance in each section.`);
  }
  if (words > max) {
    issues.push(`The article is too long (${words} words). Tighten it to under ${max} words without padding.`);
  }
  if (!/<h2[\s>]/i.test(draft.bodyHtml)) {
    issues.push('The article has no section headings. Structure it with <h2> sub-headings so it is skimmable.');
  }
  if (!hasStorefrontLink(draft.bodyHtml)) {
    issues.push('The article does not link to any real product or collection. Add at least one link to a real /products/<handle> or /collections/<handle> path from the provided facts (never invent a link).');
  }
  const md = draft.metaDescription?.trim() ?? '';
  if (md.length < 50 || md.length > 160) {
    issues.push(`The meta description must be 50-160 characters (currently ${md.length}). Write a compelling one-sentence summary in that range.`);
  }
  if (!draft.excerpt || draft.excerpt.trim().length < 20) {
    issues.push('The excerpt is missing or too short. Provide a one or two sentence summary for the listing card.');
  }
  // AI-citation shape: a standalone quick answer up top (what assistants and
  // search snippets lift), and a real FAQ (what they quote). Tolerances are
  // wider than the asked-for 40-60 words so a near-miss never loops the reviser.
  const qaWords = countWords(quickAnswerText(draft.bodyHtml));
  if (qaWords < 25 || qaWords > 80) {
    issues.push(`The body must OPEN with a quick answer: a single paragraph of 40-60 words, before the first <h2>, that directly and completely answers the reader's core question (currently ${qaWords} words there). No teasers like "read on".`);
  }
  const faqCount = draft.faq?.length ?? 0;
  if (faqCount < 3) {
    issues.push(`Include a "faq" array of 3-5 questions pet owners genuinely ask about this topic, each with a grounded 40-80 word plain-text answer (currently ${faqCount}).`);
  }
  return issues;
}

// Claim shapes that MUST be human-verified before a public, indexed article
// asserts them. These are not auto-fixed and not blocking - they are flagged
// for the reviewer. Kept deliberately broad (false positives are cheap: a human
// glances at the line; a missed fabricated health claim is not).
const CLAIM_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'medical/treatment claim', re: /\b(?:cures?|treats?|heals?|prevents?|diagnos\w+|remed(?:y|ies|ial)|therapeutic)\b/i },
  { label: 'veterinary endorsement', re: /\b(?:vet(?:erinarian)?[- ]?(?:recommended|approved|endorsed)|clinically proven|scientifically proven)\b/i },
  { label: 'dosage/quantity claim', re: /\b\d+(?:\.\d+)?\s?(?:mg|ml|g|kg|mcg|iu)\b|\b\d+\s?(?:times?|x)\s?(?:a|per)\s?(?:day|week)\b|\bper\s?(?:kg|kilo|pound|lb)\b/i },
  { label: 'safety guarantee', re: /\b(?:100%\s?safe|completely safe|totally safe|guaranteed(?:\s?(?:safe|to|results?))?|risk[- ]?free)\b/i },
  { label: 'absolute health claim', re: /\b(?:will (?:cure|prevent|stop|fix|heal)|eliminates?|kills? (?:all|100))\b/i },
];

/** Sentences that make a claim requiring human verification. Each entry names
 *  the sentence and the concern, for the reviewer's "verify this" list. */
export function findClaimFlags(bodyHtml: string): { sentence: string; concern: string }[] {
  const text = htmlToText(bodyHtml);
  const sentences = text.split(/(?<=[.!?])\s+/);
  const flags: { sentence: string; concern: string }[] = [];
  for (const s of sentences) {
    for (const { label, re } of CLAIM_PATTERNS) {
      if (re.test(s)) {
        flags.push({ sentence: s.slice(0, 240), concern: label });
        break; // one flag per sentence is enough for a reviewer
      }
    }
  }
  return flags;
}

/**
 * Blog self-correction loop (own copy - never the inbox refineUntilClean, which
 * is hard-wired to the inbox gate). While the draft has mechanical issues, ask
 * the injected reviser to fix them. Returns the BEST draft seen (fewest issues);
 * a reviser failure (null) degrades to the best so far. Bounded by maxAttempts.
 */
export async function refineBlogUntilClean(
  initial: BlogDraft,
  revise: (prev: BlogDraft, issues: string[]) => Promise<BlogDraft | null>,
  ctx: BlogQualityContext = {},
  maxAttempts = 2
): Promise<BlogDraft> {
  let best = initial;
  let bestCount = findBlogIssues(initial, ctx).length;
  let current = initial;
  let issues = findBlogIssues(current, ctx);

  for (let i = 0; i < maxAttempts && issues.length > 0; i++) {
    const revised = await revise(current, issues);
    if (!revised) break;
    current = revised;
    issues = findBlogIssues(current, ctx);
    if (issues.length < bestCount) { best = current; bestCount = issues.length; }
  }
  return best;
}
