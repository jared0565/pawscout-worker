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
import { BRAND_TOKENS } from '../debrand';

export interface SyndicationCopy {
  pinTitle: string;  // Pinterest pin title
  pinDesc: string;   // Pinterest pin description
  caption: string;   // Facebook / Instagram caption
  teaser: string;    // email digest teaser (phase 3)
  altText: string;   // image alt text
}

/** Per-platform length caps (Pinterest title/alt from Blotato's target spec;
 * description 500 per Pinterest; caption 2200 per Instagram). */
export const COPY_CAPS: Record<keyof SyndicationCopy, number> = {
  pinTitle: 100, pinDesc: 500, caption: 2200, teaser: 300, altText: 500
};

/** Currency amounts are banned in syndicated copy. */
const PRICE_RE = /[£$€]\s?\d|\b\d+(?:\.\d{1,2})?\s?(?:gbp|usd|eur|pounds?|quid|dollars?)\b/i;

export function copyGateErrors(c: SyndicationCopy): string[] {
  const errs: string[] = [];
  for (const k of Object.keys(COPY_CAPS) as (keyof SyndicationCopy)[]) {
    const v = c[k];
    if (!v || !v.trim()) { errs.push(`${k} is empty`); continue; }
    if (v.length > COPY_CAPS[k]) errs.push(`${k} exceeds ${COPY_CAPS[k]} chars`);
    if (PRICE_RE.test(v)) errs.push(`${k} contains a price`);
    for (const b of BRAND_TOKENS) {
      if (new RegExp(`\\b${b}\\b`, 'i').test(v)) errs.push(`${k} names supplier brand ${b}`);
    }
  }
  return errs;
}

/** Shape-check + sanitize + gate. Passed as jsonChain's validate, so a gate
 * rejection makes the model retry rather than shipping bad copy. */
export function validateCopy(v: unknown): SyndicationCopy | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = {} as SyndicationCopy;
  for (const k of Object.keys(COPY_CAPS) as (keyof SyndicationCopy)[]) {
    if (typeof o[k] !== 'string') return null;
    out[k] = sanitizeOutbound((o[k] as string).trim());
  }
  return copyGateErrors(out).length ? null : out;
}

const COPY_SYSTEM =
  'You write social copy for Active Paw, a UK pet-care store, announcing a newly published buying guide. ' +
  'You are given the guide TITLE, its funnel collection, and the real product titles it features. ' +
  'HARD RULES: restate only what the title and products imply, never invent claims, benefits, statistics or endorsements; ' +
  'NEVER mention a price, discount, or currency amount; NEVER name a manufacturer or supplier brand; ' +
  'never mention shipping times, dispatch, or where products ship from; at most one emoji per field; no hashtags except at most two at the end of caption. ' +
  'Voice: warm, useful, direct, British English. ' +
  'Reply with JSON only: {"pinTitle": string (<=100 chars, the guide as a benefit), ' +
  '"pinDesc": string (<=500 chars, why the guide helps + gentle invitation to read), ' +
  '"caption": string (<=2200 chars but aim for 2-4 sentences, for Facebook/Instagram), ' +
  '"teaser": string (<=300 chars, one-line email teaser), ' +
  '"altText": string (<=500 chars, literal description of a photo of the featured product for accessibility)}';

/** One copy call per pack build. Degrades to null (caller records the error on
 * the ledger rows); never throws. */
export async function buildCopy(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  input: { articleTitle: string; collectionHandle: string | null; productTitles: string[] }
): Promise<SyndicationCopy | null> {
  const result = await llm.jsonChain({
    chain: resolveChain(cfg, 'text'),
    maxTokens: 900,
    system: COPY_SYSTEM,
    user: JSON.stringify({
      guideTitle: input.articleTitle,
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
