// src/blog/combo.ts
//
// The MERCHANDISER agent: choose the "Shop this guide" block from the WHOLE
// live catalog (every grounded collection), congruent with the article that was
// actually written. This replaces the blind same-collection top-up that put a
// dog ramp and a pet scale under a cat-cooling guide (2026-07-10 audit).
//
// Deterministic frame around one LLM judgment:
//   - products the body links ALWAYS lead and are never removed (the writer
//     chose them as relevant),
//   - the LLM only fills the remaining slots, from a candidate list of real,
//     available, on-storefront products across ALL collections,
//   - every pick is validated against that candidate set (hallucination-proof),
//   - an empty top-up is a VALID outcome: fewer congruent picks beat a full but
//     off-topic block,
//   - LLM unavailable or failed -> linked-only when the body linked products,
//     else null so the caller keeps its deterministic selection.

import { LlmClient } from '../llm';
import { resolveChain } from '../llm-resolve';
import type { TenantConfig } from '../types';
import type { TenantStore } from '../tenant-store';
import type { FactPack, GroundedProduct } from './types';
import { htmlToText } from './quality';

/** One candidate the merchandiser may pick, tagged with its collection so the
 *  model can reason about complements across categories. */
export interface ComboCandidate extends GroundedProduct { collectionTitle: string; }

/** All AVAILABLE products across the packs, deduped by handle (first pack wins).
 *  This is both the candidate list and the validation universe. */
export function availableByHandle(packs: FactPack[]): Map<string, ComboCandidate> {
  const out = new Map<string, ComboCandidate>();
  for (const pack of packs) {
    for (const p of pack.products) {
      if (!p.available || out.has(p.handle)) continue;
      out.set(p.handle, { ...p, collectionTitle: pack.collectionTitle });
    }
  }
  return out;
}

export interface ComboArticle { title: string; angle?: string; bodyHtml: string; }

const MAX_BODY_CHARS = 1800; // enough context to judge congruence, cheap to send

function validateComboHandles(v: unknown, allowed: Set<string>, max: number): { handles: string[] } | null {
  const arr = (v as { handles?: unknown })?.handles;
  if (!Array.isArray(arr)) return null;
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const h of arr) {
    if (typeof h !== 'string') continue;
    const key = h.trim().toLowerCase();
    if (!allowed.has(key) || seen.has(key)) continue; // hallucinated or duplicate -> dropped
    seen.add(key);
    handles.push(key);
    if (handles.length >= max) break;
  }
  return { handles }; // empty is valid: nothing congruent beats padding with off-topic items
}

/**
 * Pick the final shop-block handle list for an article. Returns the handles in
 * display order (body-linked first, then the merchandiser's congruent top-up),
 * or null when there is no better answer than the caller's own deterministic
 * selection (no LLM AND nothing linked).
 */
export async function pickComboHandles(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  opts: { article: ComboArticle; packs: FactPack[]; linkedHandles: string[]; max?: number }
): Promise<string[] | null> {
  const max = opts.max ?? 4;
  const byHandle = availableByHandle(opts.packs);

  // The writer's own picks lead, deduped, capped. These are never removed.
  const linked: string[] = [];
  for (const h of opts.linkedHandles) {
    const key = h.toLowerCase();
    if (byHandle.has(key) && !linked.includes(key)) linked.push(key);
    if (linked.length >= max) break;
  }

  const slots = max - linked.length;
  if (slots <= 0) return linked;

  const linkedSet = new Set(linked);
  const candidates = [...byHandle.values()].filter((p) => !linkedSet.has(p.handle));
  if (!candidates.length) return linked.length ? linked : null;

  if (!llm.available || !cfg.llm.enabled) return linked.length ? linked : null;

  const chain = resolveChain(cfg, 'text');
  const system = [
    'You are the merchandiser for Active Paw, a UK pet-care store for dogs and cats.',
    'A blog article is about to show a "Shop this guide" block at its end. Choose which of the store\'s real products fill the remaining slots.',
    'The ONLY rule that matters is congruence: a reader who just finished THIS article must look at every pick and think "yes, that belongs with what I just read". Complementary picks that complete the task the article describes are ideal (the kit a reader would actually assemble).',
    'Never pick an off-topic product just to fill slots. If fewer than the requested number are genuinely congruent, return fewer. An empty list is acceptable when nothing fits.',
    'Do not repeat products listed under alreadyFeatured (they are already in the block).',
    `Respond with ONLY JSON: {"handles": <array of 0 to N candidate handles, best first, chosen ONLY from the provided candidates>}.`
  ].join(' ');

  const user = JSON.stringify({
    article: {
      title: opts.article.title,
      angle: opts.article.angle ?? null,
      text: htmlToText(opts.article.bodyHtml).slice(0, MAX_BODY_CHARS)
    },
    alreadyFeatured: linked.map((h) => ({ handle: h, title: byHandle.get(h)?.title ?? h })),
    chooseUpTo: slots,
    candidates: candidates.map((p) => ({ handle: p.handle, title: p.title, priceGbp: p.priceGbp, collection: p.collectionTitle }))
  });

  const allowed = new Set(candidates.map((p) => p.handle));
  const r = await llm.jsonChain<{ handles: string[] }>({
    chain, maxTokens: 300, system, user,
    validate: (v) => validateComboHandles(v, allowed, slots)
  });
  if (!r.ok) {
    console.warn(`blog combo pick failed: ${r.error}`);
    return linked.length ? linked : null; // defensible fallback: never blind-pad
  }
  await store.logLlmUsage('blog-combo', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  return [...linked, ...r.value.handles];
}
