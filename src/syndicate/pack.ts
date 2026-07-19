// Creative pack copy (blog distribution phase 1, 2026-07-11): ONE small LLM
// call per published guide writes every channel's copy, validated by HARD code
// gates before anything can ship. The gates, not model confidence, are the
// safety layer: no currency amounts (pins live for months while the profit
// agent reprices every 15 minutes; the landing page shows the live price), no
// supplier brand tokens, per-platform length caps, and sanitizeOutbound (the
// em/en-dash rule) on every field. jsonChain re-asks the model when validate
// returns null, so a gate rejection self-corrects before degrading to null.
import type { LlmClient } from '../llm';
import { resolveChain } from '../llm-resolve';
import type { TenantStore } from '../tenant-store';
import type { TenantConfig } from '../types';
import { sanitizeOutbound } from '../inbox/draft';
import { BRAND_TOKENS, escapeRegex } from '../debrand';

export interface SyndicationCopy {
  pinTitle: string;  // Pinterest pin title
  pinDesc: string;   // Pinterest pin description
  caption: string;   // Facebook / Instagram caption
  teaser: string;    // email digest teaser (phase 3)
  altText: string;   // image alt text
  hashtags?: string; // Instagram-only discovery tags, appended after the caption's link
}

/** Per-platform length caps (Pinterest title/alt from Blotato's target spec;
 * description 500 per Pinterest; caption 2200 per Instagram). These are the
 * REQUIRED fields; `hashtags` is optional (validated separately when present,
 * so packs stored before the field existed stay valid). */
export const COPY_CAPS: Record<Exclude<keyof SyndicationCopy, 'hashtags'>, number> = {
  pinTitle: 100, pinDesc: 500, caption: 2200, teaser: 300, altText: 500
};

export const HASHTAGS_CAP = 120;
/** 1-5 space-separated #tags, letters/digits/underscores only. */
const HASHTAGS_RE = /^#[a-z0-9_]+(?:\s+#[a-z0-9_]+){0,4}$/i;

/** Currency amounts are banned in syndicated copy. Three shapes: symbol-first
 * (£9.99), amount-then-unit (9.99 GBP / 10 pounds), and code-first (GBP 9.99). */
const PRICE_RE = /[£$€]\s?\d|\b\d+(?:\.\d{1,2})?\s?(?:gbp|usd|eur|pounds?|quid|dollars?)\b|\b(?:gbp|usd|eur)\s?\d/i;

export function copyGateErrors(c: SyndicationCopy, brands: string[] = BRAND_TOKENS): string[] {
  const errs: string[] = [];
  const priceAndBrand = (k: string, v: string) => {
    if (PRICE_RE.test(v)) errs.push(`${k} contains a price`);
    for (const b of brands) {
      if (new RegExp(`\\b${escapeRegex(b)}\\b`, 'i').test(v)) errs.push(`${k} names supplier brand ${b}`);
    }
  };
  for (const k of Object.keys(COPY_CAPS) as (keyof typeof COPY_CAPS)[]) {
    const v = c[k];
    if (!v || !v.trim()) { errs.push(`${k} is empty`); continue; }
    if (v.length > COPY_CAPS[k]) errs.push(`${k} exceeds ${COPY_CAPS[k]} chars`);
    priceAndBrand(k, v);
  }
  if (c.hashtags !== undefined && c.hashtags.trim()) {
    if (c.hashtags.length > HASHTAGS_CAP) errs.push(`hashtags exceeds ${HASHTAGS_CAP} chars`);
    if (!HASHTAGS_RE.test(c.hashtags.trim())) errs.push('hashtags must be 1 to 5 space-separated #tags');
    priceAndBrand('hashtags', c.hashtags);
  }
  return errs;
}

/** Shape-check + sanitize + gate. Passed as jsonChain's validate, so a gate
 * rejection makes the model retry rather than shipping bad copy. */
export function validateCopy(v: unknown): SyndicationCopy | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = {} as SyndicationCopy;
  for (const k of Object.keys(COPY_CAPS) as (keyof typeof COPY_CAPS)[]) {
    if (typeof o[k] !== 'string') return null;
    out[k] = sanitizeOutbound((o[k] as string).trim());
  }
  // Optional field: a missing or non-string value is simply absent (packs
  // stored before the field existed parse fine); a PRESENT string is gated.
  if (typeof o.hashtags === 'string' && o.hashtags.trim()) out.hashtags = sanitizeOutbound(o.hashtags.trim());
  return copyGateErrors(out).length ? null : out;
}

const COPY_SYSTEM =
  'You write social copy for Active Paw, a UK pet-care store, announcing a newly published buying guide. ' +
  'You are given the guide TITLE, its opening QUICK ANSWER paragraph (the guide\'s core advice in its own words), its funnel collection, and the real product titles it features. ' +
  'HARD RULES: restate only what the title, quick answer and products imply, never invent claims, benefits, statistics or endorsements; ' +
  'NEVER mention a price, discount, or currency amount; NEVER name a manufacturer or supplier brand; ' +
  'never mention shipping times, dispatch, or where products ship from; at most one emoji per field; no hashtags in any field except the dedicated hashtags field. ' +
  'Voice: warm, useful, direct, British English. ' +
  'Reply with JSON only: {"pinTitle": string (<=100 chars, the guide as a benefit), ' +
  '"pinDesc": string (<=500 chars, why the guide helps + gentle invitation to read; Pinterest is a search engine, so naturally weave in the phrases a pet owner would actually search for), ' +
  '"caption": string (<=2200 chars but aim for 2-4 sentences, for Facebook/Instagram; lead with the most useful takeaway from the quick answer, not "we published a guide"), ' +
  '"teaser": string (<=300 chars, one-line email teaser), ' +
  '"altText": string (<=500 chars, literal description of a photo of the featured product for accessibility), ' +
  '"hashtags": string (3 to 5 short Instagram discovery tags separated by single spaces, each like #DogCare; generic pet-interest topics only, never a brand)}';

/** One copy call per pack build. Degrades to null (caller records the error on
 * the ledger rows); never throws. */
export async function buildCopy(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  input: { articleTitle: string; quickAnswer?: string; collectionHandle: string | null; productTitles: string[] }
): Promise<SyndicationCopy | null> {
  const result = await llm.jsonChain({
    chain: resolveChain(cfg, 'text'),
    maxTokens: 900,
    system: COPY_SYSTEM,
    user: JSON.stringify({
      guideTitle: input.articleTitle,
      quickAnswer: input.quickAnswer?.trim() ? input.quickAnswer.trim().slice(0, 600) : undefined,
      collection: input.collectionHandle ?? undefined,
      featuredProducts: input.productTitles.slice(0, 6)
    }),
    validate: validateCopy
  });
  if (!result.ok) {
    console.warn(`syndication copy failed for "${input.articleTitle}": ${result.error}`);
    return null;
  }
  await store.logLlmUsage('blog-syndication-copy', result.usage.model, result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd);
  return result.value;
}
