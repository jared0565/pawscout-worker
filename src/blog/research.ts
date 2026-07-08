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
import type { BlogBrief, TopicSeed, FactPack, BlogTopicCandidate } from './types';

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

export function validateBrief(v: unknown, validHandles: string[]): BlogBrief | null {
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

/**
 * Validate + assemble topic candidates from a raw LLM `{topics:[...]}` payload.
 * Each brief is validated against the eligible (already product-gated) handles,
 * hallucinated collections are dropped, titles are deduped, and coverage is
 * spread across collections (at most `maxPerCollection`) so the dropdown is not
 * five flavours of one collection. Returns null when nothing survives.
 */
function validateCandidates(
  v: unknown, packByHandle: Map<string, FactPack>, count: number
): BlogTopicCandidate[] | null {
  const arr = (v as { topics?: unknown })?.topics;
  if (!Array.isArray(arr)) return null;
  const handles = [...packByHandle.keys()];
  const maxPerCollection = Math.max(1, Math.ceil(count / handles.length));
  const perCollection = new Map<string, number>();
  const seenTitles = new Set<string>();
  const out: BlogTopicCandidate[] = [];
  for (const item of arr) {
    const brief = validateBrief(item, handles);
    if (!brief) continue;
    const key = brief.title.toLowerCase();
    if (seenTitles.has(key)) continue;
    const used = perCollection.get(brief.collectionHandle) ?? 0;
    if (used >= maxPerCollection) continue;
    const pack = packByHandle.get(brief.collectionHandle)!;
    const live = pack.products.filter((p) => p.available);
    out.push({
      brief,
      collectionTitle: pack.collectionTitle,
      liveProductCount: live.length,
      sampleProducts: live.slice(0, 3).map((p) => p.title)
    });
    seenTitles.add(key);
    perCollection.set(brief.collectionHandle, used + 1);
    if (out.length >= count) break;
  }
  return out.length ? out : null;
}

/**
 * Propose several DIVERSE topic candidates FROM already-grounded collections.
 * The caller passes only packs it has gated (enough live, on-storefront
 * products), so every suggestion is congruent AND buildable before drafting
 * starts. Each candidate carries a full brief the owner can send straight to
 * generation. Hermetic: signal is the real catalog + season, not live trend
 * data (that is a later enhancement, and would inform the brief only). Returns
 * [] when the LLM is unavailable or nothing validates.
 */
function buildTopicSystem(handles: string[], catalog: string, season: string, count: number, useWeb: boolean): string {
  // The demand instruction is the ONLY difference between the web + hermetic
  // prompts. Web framing (advisor): rank OUR coverable categories by REAL current
  // demand and never force a trend we cannot stock - the collection gate then
  // guarantees we only surface topics we can actually fulfill.
  const demand = useWeb
    ? 'Use live web search to judge which of these stocked categories has REAL current search demand right now (this season, current pet-owner interest) and the SPECIFIC angle people are actually searching for. Rank your suggestions by genuine current demand. Never invent or force a trending topic onto a category we cannot stock - only propose topics we can fully back with the products listed below.'
    : 'Judge which of these stocked categories a pet owner is most likely to search for this season, and the specific angle they want.';
  return [
    'You are a content strategist for Active Paw, a UK pet-care store for dogs and cats.',
    `Propose ${count} DIVERSE blog article topics a pet owner would genuinely search for. Each MUST funnel into one of the real collections below and be congruent with that collection's actual products.`,
    demand,
    'Diversity is required: spread topics across DIFFERENT collections; do not propose several topics for the same collection unless there are fewer collections than requested topics.',
    'Honest and useful only: never clickbait, never a topic we cannot tie to the listed products.',
    `Current season: ${season}.`,
    `Real collections and their in-stock products (choose collectionHandle EXACTLY from: ${handles.join(', ')}):\n${catalog}`,
    `Respond with ONLY JSON: {"topics": [ ${count} objects, each {"title": <specific search-friendly title>, "angle": <the specific promise>, "targetKeyword": <primary search intent>, "collectionHandle": <one real handle from the list>, "whyNow": <one sentence, cite the demand signal>, "keyPoints": <array of 3-6 short points to cover>} ]}.`
  ].join(' ');
}

export async function proposeTopics(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  opts: { packs: FactPack[]; season: string; count?: number }
): Promise<BlogTopicCandidate[]> {
  const count = opts.count ?? 5;
  const packByHandle = new Map(opts.packs.map((p) => [p.collectionHandle, p]));
  const handles = [...packByHandle.keys()];
  if (!handles.length) return [];

  const catalog = opts.packs.map((p) => {
    const names = p.products.filter((x) => x.available).slice(0, 6).map((x) => x.title).join(', ');
    return `- ${p.collectionTitle} [${p.collectionHandle}]: ${names}`;
  }).join('\n');
  const chain = resolveChain(cfg, 'text');
  const user = JSON.stringify({ season: opts.season, count });

  // 1) Demand-driven: web search grounds the topics in what people search NOW.
  const web = await llm.jsonChain<BlogTopicCandidate[]>({
    chain, maxTokens: 1800, web: { maxResults: 6 },
    system: buildTopicSystem(handles, catalog, opts.season, count, true),
    user,
    validate: (v) => validateCandidates(v, packByHandle, count)
  });
  if (web.ok && web.value.length) {
    await store.logLlmUsage('blog-topics-web', web.usage.model, web.usage.promptTokens, web.usage.completionTokens, web.usage.costUsd);
    console.log(`blog topics: web-grounded ok, ${web.value.length} candidates, costUsd=${web.usage.costUsd}`);
    return web.value;
  }
  console.warn(`blog topics: web grounding produced nothing (${web.ok ? 'no valid candidates' : web.error}); falling back to hermetic catalog+season.`);

  // 2) Fallback: hermetic (catalog + season only) so the feature still works if
  //    web search is unavailable or does not compose on the current models.
  const r = await llm.jsonChain<BlogTopicCandidate[]>({
    chain, maxTokens: 1800,
    system: buildTopicSystem(handles, catalog, opts.season, count, false),
    user,
    validate: (v) => validateCandidates(v, packByHandle, count)
  });
  if (!r.ok) { console.warn(`blog topic research failed: ${r.error}`); return []; }
  await store.logLlmUsage('blog-topics', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  return r.value;
}
