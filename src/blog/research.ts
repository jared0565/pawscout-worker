// src/blog/research.ts
//
// The RESEARCH agent: propose ONE article brief (a plan a human approves before
// drafting). v1 signal is INTERNAL + seasonal - the real collections, a curated
// evergreen seed list, and the current season - so the drafter stays hermetic
// and no external dependency is needed to launch. External trend/keyword signal
// is a later enhancement that would inform the brief, never the drafter's facts.

import { LlmClient } from '../llm';
import { resolveChain } from '../llm-resolve';
import type { TenantConfig } from '../types';
import type { TenantStore } from '../tenant-store';
import type { BlogBrief, TopicSeed } from './types';

/** Curated evergreen starting points, one+ per real collection. The research
 *  agent may pick from these or propose its own, but the collection it funnels
 *  into MUST be a real handle passed in `validHandles`. */
export const SEED_TOPICS: TopicSeed[] = [
  { collectionHandle: 'pet-health', workingTitle: "Why won't my cat drink enough water?", note: 'Evergreen hydration concern; funnels to fountains/bowls.' },
  { collectionHandle: 'pet-cleaning', workingTitle: 'How often should you really clean a cat litter box?', note: 'High-intent evergreen; funnels to litter trays and scoops.' },
  { collectionHandle: 'pet-grooming', workingTitle: 'Deshedding 101: brush types and how often to use them', note: 'Seasonal in spring/autumn shed; funnels to grooming tools.' },
  { collectionHandle: 'pet-toys', workingTitle: 'Best ways to keep a dog busy when home alone', note: 'Evergreen enrichment; funnels to interactive/puzzle toys.' },
  { collectionHandle: 'pet-accessories', workingTitle: 'Choosing the right size dog crate: a simple measuring guide', note: 'High-intent buying guide; funnels to crates/carriers.' },
];

/** Rough northern-hemisphere season from a month index (0-11). Passed IN so the
 *  agent has seasonal signal without this module reading the clock itself. */
export function seasonForMonth(month0: number): string {
  if (month0 <= 1 || month0 === 11) return 'winter';
  if (month0 <= 4) return 'spring';
  if (month0 <= 7) return 'summer';
  return 'autumn';
}

function validateBrief(v: unknown, validHandles: string[]): BlogBrief | null {
  const o = v as Record<string, unknown>;
  if (typeof o !== 'object' || o === null) return null;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const angle = typeof o.angle === 'string' ? o.angle.trim() : '';
  const targetKeyword = typeof o.targetKeyword === 'string' ? o.targetKeyword.trim() : '';
  const collectionHandle = typeof o.collectionHandle === 'string' ? o.collectionHandle.trim() : '';
  const whyNow = typeof o.whyNow === 'string' ? o.whyNow.trim() : '';
  const keyPoints = Array.isArray(o.keyPoints)
    ? o.keyPoints.filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 200)).slice(0, 8)
    : [];
  if (!title || !angle || !collectionHandle || keyPoints.length < 3) return null;
  // Ground the funnel: reject a hallucinated collection.
  if (!validHandles.includes(collectionHandle)) return null;
  return { title: title.slice(0, 180), angle: angle.slice(0, 400), targetKeyword: targetKeyword.slice(0, 120), collectionHandle, whyNow: whyNow.slice(0, 400), keyPoints };
}

/**
 * Propose a brief. `validHandles` are the real collection handles the brief may
 * funnel into. `topicHint` (optional) steers the angle (e.g. the owner picked a
 * topic); otherwise the agent chooses, guided by the seeds and the season.
 * Returns null when the LLM is unavailable.
 */
export async function proposeBrief(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  opts: { validHandles: string[]; season: string; topicHint?: string }
): Promise<BlogBrief | null> {
  const chain = resolveChain(cfg, 'text');
  const seeds = SEED_TOPICS.filter((s) => opts.validHandles.includes(s.collectionHandle));
  const system = [
    'You are a content strategist for Active Paw, a UK pet-care store for dogs and cats.',
    'Propose ONE blog article brief: a genuinely useful buying-guide or how-to that a pet owner would search for, and that funnels naturally into one of our real collections.',
    'It must be honest and evergreen-to-seasonal, never clickbait, never a topic we cannot tie to a real product category.',
    `The collectionHandle in your brief MUST be exactly one of these real handles: ${opts.validHandles.join(', ')}.`,
    `Current season: ${opts.season}. Prefer a topic that fits the season when there is a good one, otherwise a strong evergreen.`,
    opts.topicHint ? `The owner suggested this direction, build the brief around it: ${opts.topicHint}` : `Some evergreen starting points (you may use or improve one, or propose your own): ${seeds.map((s) => `${s.workingTitle} [${s.collectionHandle}]`).join('; ')}.`,
    'Respond with ONLY JSON: {"title": <specific search-friendly title>, "angle": <the specific promise of the piece>, "targetKeyword": <primary search intent>, "collectionHandle": <one real handle from the list>, "whyNow": <one sentence: why this topic now>, "keyPoints": <array of 3-6 short points the article should cover>}.'
  ].join(' ');

  const r = await llm.jsonChain<BlogBrief>({
    chain, maxTokens: 700, system,
    user: JSON.stringify({ season: opts.season, topicHint: opts.topicHint ?? null }),
    validate: (v) => validateBrief(v, opts.validHandles)
  });
  if (!r.ok) { console.warn(`blog research failed: ${r.error}`); return null; }
  await store.logLlmUsage('blog-research', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  return r.value;
}
