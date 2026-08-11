// src/blog/research.ts
//
// The RESEARCH agent: propose ONE article brief (a plan a human approves before
// drafting). v1 signal is INTERNAL + seasonal - the real collections, a curated
// evergreen seed list, and the current season - so the drafter stays hermetic
// and no external dependency is needed to launch. External trend/keyword signal
// is a later enhancement that would inform the brief, never the drafter's facts.

import { LlmClient } from '../llm';
import { resolveChain, resolveSearchChain } from '../llm-resolve';
import type { TenantConfig } from '../types';
import type { TenantStore } from '../tenant-store';
import type {
  BlogBrief, TopicSeed, FactPack, BlogTopicCandidate, SourcedFact,
  DemandSignal, DemandEvidence
} from './types';
import { isApprovedSourceUrl, approvedSourcesPromptLine } from './sources';
import { GoogleSuggestSource, researchDemandDeterministic, type SuggestSource } from './demand-suggest';

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

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * The window a guide published TODAY is actually READ in.
 *
 * A new article needs weeks to be indexed and start ranking, and then earns
 * traffic for months. Choosing its topic from the CURRENT month is therefore
 * always a month or more late. Measured 2026-08-11: `seasonForMonth(7)` returned
 * "summer", the prompt said "Current season: summer. Prefer a topic that fits the
 * season", and the agent duly proposed "How to Keep Your Dog Cool on Summer
 * Walks", "Summer Cat Shedding" and "A Simple Summer Routine" - for a guide that
 * will be in front of readers across September, October and November.
 *
 * So: lead the calendar by a month, describe the three months the piece is for,
 * and take the season from the window's MIDPOINT rather than from today. This is
 * deliberately a NEW function rather than a change to `seasonForMonth`, which
 * `runBlogPipeline` still uses for the drafter and whose mapping is pinned by
 * tests - the drafter should know what season it is writing IN, while the topic
 * chooser needs to know what season it is writing FOR.
 */
export function publishWindow(month0: number): { season: string; months: string[] } {
  const start = (((month0 % 12) + 12) % 12) + 1;      // lead by one month
  const months = [0, 1, 2].map((i) => MONTH_NAMES[(start + i) % 12]);
  return { season: seasonForMonth((start + 1) % 12), months };
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

function buildBriefSystem(
  validHandles: string[], window: { season: string; months: string[] },
  seeds: TopicSeed[], topicHint: string | undefined, useWeb: boolean
): string {
  // Same web-first/hermetic-fallback split as the topic suggestions: web framing
  // ranks by REAL current demand; the hermetic variant keeps the feature alive
  // when web search is unavailable. Demand informs the BRIEF only, never the
  // drafter's facts.
  const monthList = window.months.join(', ');
  const demand = useWeb
    ? 'Use live web search to judge what UK pet owners are actually searching for RIGHT NOW around this direction, and pick the angle with genuine current demand. Never force a trending topic we cannot back with a real collection.'
    : 'Choose a durable evergreen angle rather than guessing at a trend you cannot check.';
  return [
    'You are a content strategist for Active Paw, a UK pet-care store for dogs and cats.',
    'Propose ONE blog article brief: a genuinely useful buying-guide or how-to that a pet owner would search for, and that funnels naturally into one of our real collections.',
    demand,
    'It must be honest and evergreen-to-seasonal, never clickbait, never a topic we cannot tie to a real product category.',
    `The collectionHandle in your brief MUST be exactly one of these real handles: ${validHandles.join(', ')}.`,
    // Forward-looking for the same reason as the topic chooser: a brief written
    // against TODAY's season ships a guide that is already a month late.
    `This guide is published now but will be READ across ${monthList} (${window.season}). Fit that window, not today's weather; otherwise prefer a strong evergreen.`,
    topicHint ? `The owner suggested this direction, build the brief around it: ${topicHint}` : `Some evergreen starting points (you may use or improve one, or propose your own): ${seeds.map((s) => `${s.workingTitle} [${s.collectionHandle}]`).join('; ')}.`,
    'Respond with ONLY JSON: {"title": <specific search-friendly title>, "angle": <the specific promise of the piece>, "targetKeyword": <primary search intent>, "collectionHandle": <one real handle from the list>, "whyNow": <one sentence: why this topic now, citing the demand signal>, "keyPoints": <array of 3-6 short points the article should cover>}.'
  ].join(' ');
}

/**
 * Propose a brief. `validHandles` are the real collection handles the brief may
 * funnel into. `topicHint` (optional) steers the angle (e.g. the owner picked a
 * topic); otherwise the agent chooses, guided by the seeds and the season.
 * Web-grounded demand first, hermetic catalog+season fallback (same pattern as
 * proposeTopics). Returns null when the LLM is unavailable.
 */
export async function proposeBrief(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  opts: { validHandles: string[]; window: { season: string; months: string[] }; topicHint?: string }
): Promise<BlogBrief | null> {
  const chain = resolveChain(cfg, 'text');
  const seeds = SEED_TOPICS.filter((s) => opts.validHandles.includes(s.collectionHandle));
  const user = JSON.stringify({ readInMonths: opts.window.months, season: opts.window.season, topicHint: opts.topicHint ?? null });

  // `required` so this cannot quietly be served by the non-searching floor tier
  // and then logged as 'blog-research-web'. A failure here is real and lands in
  // the hermetic branch below, which no longer claims to know what is trending.
  const web = await llm.jsonChain<BlogBrief>({
    chain: resolveSearchChain(cfg), maxTokens: 700, web: { maxResults: 6, required: true },
    system: buildBriefSystem(opts.validHandles, opts.window, seeds, opts.topicHint, true),
    user,
    validate: (v) => validateBrief(v, opts.validHandles)
  });
  if (web.ok) {
    await store.logLlmUsage('blog-research-web', web.usage.model, web.usage.promptTokens, web.usage.completionTokens, web.usage.costUsd);
    return web.value;
  }
  console.warn(`blog research: web grounding produced nothing (${web.error}); falling back to hermetic seeds.`);

  const r = await llm.jsonChain<BlogBrief>({
    chain, maxTokens: 700,
    system: buildBriefSystem(opts.validHandles, opts.window, seeds, opts.topicHint, false),
    user,
    validate: (v) => validateBrief(v, opts.validHandles)
  });
  if (!r.ok) { console.warn(`blog research failed: ${r.error}`); return null; }
  await store.logLlmUsage('blog-research', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  return r.value;
}

/** Validate a `{facts:[...]}` payload: short claims with a real http(s) source
 *  page each, deduped, capped at 4. An empty array is VALID - "nothing could be
 *  verified" must be an acceptable answer or the model is pushed to invent. */
export function validateSourcedFacts(v: unknown): SourcedFact[] | null {
  const arr = (v as { facts?: unknown })?.facts;
  if (!Array.isArray(arr)) return null;
  const out: SourcedFact[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    const fact = typeof o?.fact === 'string' ? o.fact.trim() : '';
    const sourceUrl = typeof o?.sourceUrl === 'string' ? o.sourceUrl.trim() : '';
    const sourceName = typeof o?.sourceName === 'string' ? o.sourceName.trim() : '';
    if (!fact || !sourceName) continue;
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(sourceUrl)) continue;    // a real, linkable page
    if (/activepaw/i.test(sourceUrl)) continue;                    // external sources only
    if (!isApprovedSourceUrl(sourceUrl)) continue;                 // non-commercial authorities only - never a retailer/competitor
    const key = (fact + sourceUrl).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fact: fact.slice(0, 240), sourceUrl: sourceUrl.slice(0, 500), sourceName: sourceName.slice(0, 120) });
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Web-research 2-4 SHORT verifiable facts for a brief, each with the source
 * page that states it. These become the ONLY external statistics the drafter
 * may cite (linked inline), which is what makes the article quotable by AI
 * engines without opening the fabrication door. Empty on any failure - the
 * drafter then writes hermetically, exactly as before. The claim-flag pass and
 * the human publish gate still apply to every cited line.
 */
export async function collectSourcedFacts(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  opts: { title: string; angle: string; keyPoints: string[] }
): Promise<SourcedFact[]> {
  if (!llm.available) return [];
  const system = [
    'You are a careful fact researcher for a pet-care publication.',
    'Using live web search, find 2-4 SHORT, verifiable, genuinely useful facts or statistics directly relevant to the article described, each from a reputable source (veterinary bodies, animal welfare charities, academic or government pages).',
    approvedSourcesPromptLine(),
    'Only include a fact you actually found stated on the source page, with that page\'s URL. NEVER invent, estimate, round beyond the source, or cite from memory.',
    'Prefer facts a reader would quote (a number, a threshold, a frequency). Skip anything medical-dosage shaped.',
    'If you cannot verify enough, return fewer, or an empty list. An empty list is a good answer; an unverified fact is not.',
    'Respond with ONLY JSON: {"facts": [{"fact": <the claim, short and quotable>, "sourceUrl": <the exact page URL>, "sourceName": <the source display name>}]}.'
  ].join(' ');

  // Search chain, same as demand research: this call is worthless without live
  // search, and it had quietly degraded the same way - its last logged run
  // (2026-08-01) was served by the OpenAI floor and thrown away by the guard
  // below, so the drafter has been writing without cited facts. Model choice
  // here affects research QUALITY only; what keeps citations safe is the
  // approved-source allowlist in validateSourcedFacts plus the provider check,
  // and neither depends on which model ran the search.
  // `required` also makes that guard cheaper rather than redundant: the OpenAI
  // tier is no longer CALLED for a job it cannot do, so we stop paying for an
  // answer we would only throw away.
  const r = await llm.jsonChain<SourcedFact[]>({
    chain: resolveSearchChain(cfg), maxTokens: 700, web: { maxResults: 6, required: true },
    system,
    user: JSON.stringify({ title: opts.title, angle: opts.angle, keyPoints: opts.keyPoints }),
    validate: validateSourcedFacts
  });
  if (!r.ok) { console.warn(`blog facts research produced nothing: ${r.error}`); return []; }
  await store.logLlmUsage('blog-facts', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  // Provenance guard: the web plugin exists only on the OpenRouter tier. A
  // floor-served (OpenAI) response had NO live search, so its "facts" and
  // source URLs are model memory - exactly the fabricated-citation class this
  // feature must never ship. Drop them; the drafter writes hermetically.
  if (r.usage.provider === 'openai') {
    console.warn('blog facts served without web search (floor tier) - discarded');
    return [];
  }
  return r.value;
}

/**
 * Validate a `{signals:[...]}` demand payload against the collections we can
 * actually fulfil. A signal for a category we do not stock is dropped, not
 * bent to fit - proposing a topic we cannot back with products is the failure
 * mode this whole gate exists to prevent.
 *
 * NOTE on source URLs: unlike `validateSourcedFacts`, this does NOT apply the
 * approved-source allowlist. That allowlist exists because cited facts get
 * PUBLISHED into an article, where linking a retailer would surface a competitor
 * ([[no-competitor-supplier-brands]]). Demand evidence is the opposite case:
 * it is internal, shown only in the owner's console to justify a suggestion,
 * and the honest sources for "what are people buying right now" are trade press
 * and retail trend pages. These URLs must never be handed to the drafter.
 */
/** Strip inline markup from a demand field before it is stored or displayed.
 *  The OpenRouter web plugin makes models annotate searched claims with
 *  `<cite index="45-1,45-6">...</cite>`, and the first live run after this
 *  feature shipped put exactly that in front of the owner: the console escapes
 *  the text, so it was safe but read as raw tags. Keep the sentence, drop the
 *  scaffolding. */
export function plainDemandText(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export function validateDemandSignals(v: unknown, validHandles: string[]): DemandSignal[] | null {
  const arr = (v as { signals?: unknown })?.signals;
  if (!Array.isArray(arr)) return null;
  const out: DemandSignal[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const o = item as Record<string, unknown>;
    const term = typeof o?.term === 'string' ? plainDemandText(o.term) : '';
    const collectionHandle = typeof o?.collectionHandle === 'string' ? o.collectionHandle.trim() : '';
    const why = typeof o?.why === 'string' ? plainDemandText(o.why) : '';
    if (!term || !validHandles.includes(collectionHandle)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rawUrl = typeof o?.sourceUrl === 'string' ? o.sourceUrl.trim() : '';
    const rawName = typeof o?.sourceName === 'string' ? plainDemandText(o.sourceName) : '';
    const usableSource = /^https?:\/\/[^\s"'<>]+$/i.test(rawUrl) && !/activepaw/i.test(rawUrl);
    out.push({
      term: term.slice(0, 120),
      collectionHandle,
      why: why.slice(0, 200),
      ...(usableSource ? { sourceUrl: rawUrl.slice(0, 500) } : {}),
      ...(usableSource && rawName ? { sourceName: rawName.slice(0, 120) } : {})
    });
    if (out.length >= 8) break;
  }
  return out.length ? out : null;
}

/**
 * THE DEMAND STEP the owner asked for (2026-08-11): before proposing anything,
 * go and find out what pet owners are ACTUALLY searching for and buying right
 * now, and rank OUR stocked categories by that.
 *
 * `web.required` is the point of this function. Only the OpenRouter tier can run
 * live search, so requiring it means this step either does real research or
 * honestly returns nothing - it can no longer quietly fall through to a tier that
 * answers from model memory and have the result banked as "researched". An empty
 * return is a legitimate answer; the caller degrades visibly rather than
 * pretending.
 */
export async function researchDemand(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  opts: { validHandles: string[]; catalog: string; window: { season: string; months: string[] } }
): Promise<DemandSignal[]> {
  if (!llm.available) return [];
  const chain = resolveSearchChain(cfg);
  const monthList = opts.window.months.join(', ');
  const system = [
    'You are a demand researcher for a UK pet-care store that sells to dog and cat owners.',
    'Use live web search to find what UK pet owners are SEARCHING FOR AND BUYING RIGHT NOW: rising search interest, trending pet product categories, current retail and trade reporting, seasonal buying patterns just starting to build.',
    `Weight your answer toward the period this content is FOR: ${monthList} (${opts.window.season}). Something already peaking is nearly over; prefer interest that is building INTO that window.`,
    'Report only what your search results actually support. Do not pad the list from general knowledge, and never invent a source. Fewer real signals beat a full list of guesses.',
    `Map every signal onto EXACTLY ONE of these collections we genuinely stock: ${opts.validHandles.join(', ')}. Discard any demand we cannot serve from these, however strong - a topic we cannot back with products is worthless to us.`,
    `Our real collections and their in-stock products:\n${opts.catalog}`,
    'Order the list strongest current demand first.',
    'Respond with ONLY JSON: {"signals": [ up to 8 objects, each {"term": <what people actually search or ask for, in their words>, "collectionHandle": <one handle from the list>, "why": <one sentence: the evidence that this is current>, "sourceName": <source display name>, "sourceUrl": <the exact page URL you found it on>} ]}.'
  ].join(' ');

  const r = await llm.jsonChain<DemandSignal[]>({
    chain, maxTokens: 1400, web: { maxResults: 8, required: true },
    system,
    user: JSON.stringify({ readInMonths: opts.window.months, season: opts.window.season }),
    validate: (v) => validateDemandSignals(v, opts.validHandles)
  });
  if (!r.ok) { console.warn(`blog demand research produced nothing: ${r.error}`); return []; }
  await store.logLlmUsage('blog-demand', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  // Belt AND braces with `web.required`: that flag stops the OpenAI tier being
  // TRIED, this check stops an OpenAI-served answer being TRUSTED if the chain
  // shape ever changes. The guard `collectSourcedFacts` already had is the only
  // reason its fabricated citations never shipped; topic research went without
  // one and spent nine days quietly ungrounded.
  if (r.usage.provider === 'openai') {
    console.warn('blog demand research served without web search (floor tier) - discarded');
    return [];
  }
  console.log(`blog demand: ${r.value.length} signal(s) via ${r.usage.model}, promptTokens=${r.usage.promptTokens}`);
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
    const rawTerm = (item as Record<string, unknown>)?.demandTerm;
    const cleanTerm = typeof rawTerm === 'string' ? plainDemandText(rawTerm) : '';
    const demandTerm = cleanTerm ? cleanTerm.slice(0, 120) : undefined;
    out.push({
      brief,
      collectionTitle: pack.collectionTitle,
      liveProductCount: live.length,
      sampleProducts: live.slice(0, 3).map((p) => p.title),
      ...(demandTerm ? { demandTerm } : {})
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
function buildTopicSystem(
  handles: string[], catalog: string, window: { season: string; months: string[] },
  count: number, signals: DemandSignal[]
): string {
  const monthList = window.months.join(', ');
  // Demand is now RESEARCHED EVIDENCE passed in, not an instruction to "judge"
  // demand. When the research step returned signals the strategist's job is to
  // turn the strongest ones into articles; when it returned nothing we say so
  // plainly and ask for durable evergreen topics, because the honest fallback
  // for "we don't know what's trending" is a piece that is useful in any month -
  // NOT a guess dressed as a trend. The old prompt's fallback leaned on the
  // season alone, which is exactly how a mid-August run produced three summer
  // topics for an autumn readership.
  const demand = signals.length
    ? [
        'These are the demand signals a live web-search pass just found, strongest first. Build your topics on THEM:',
        signals.map((s, i) => `${i + 1}. "${s.term}" [${s.collectionHandle}] - ${s.why}`).join('\n'),
        `Cover the strongest signals you can while keeping the collections diverse. Set demandTerm on each topic to the exact signal term it answers, and make whyNow state that signal's evidence. Do not invent demand beyond this list; if you need more topics than there are signals, make the extras strong EVERGREEN buying guides and leave their demandTerm empty.`
      ].join(' ')
    : 'No live demand research was available for this run, so do NOT pretend to know what is trending. Propose durable EVERGREEN buying guides and how-tos that a pet owner searches for in any month, leave demandTerm empty, and let whyNow give the honest catalog reason rather than a claimed trend.';
  return [
    'You are a content strategist for Active Paw, a UK pet-care store for dogs and cats.',
    `Propose ${count} DIVERSE blog article topics a pet owner would genuinely search for. Each MUST funnel into one of the real collections below and be congruent with that collection's actual products.`,
    demand,
    'Diversity is required: spread topics across DIFFERENT collections; do not propose several topics for the same collection unless there are fewer collections than requested topics.',
    'Honest and useful only: never clickbait, never a topic we cannot tie to the listed products.',
    `Timing: this guide is published now but will be READ across ${monthList} (${window.season}). Write for that window, not for today - a topic that is peaking this week is already too late to be worth publishing. Do not anchor to the current month's weather.`,
    `Real collections and their in-stock products (choose collectionHandle EXACTLY from: ${handles.join(', ')}):\n${catalog}`,
    `Respond with ONLY JSON: {"topics": [ ${count} objects, each {"title": <specific search-friendly title>, "angle": <the specific promise>, "targetKeyword": <primary search intent>, "collectionHandle": <one real handle from the list>, "demandTerm": <the demand signal term this answers, or "">, "whyNow": <one sentence, cite the demand evidence or say it is evergreen>, "keyPoints": <array of 3-6 short points to cover>} ]}.`
  ].join(' ');
}

export interface TopicResearchResult {
  candidates: BlogTopicCandidate[];
  demand: DemandEvidence;
}

/** Which demand source to use.
 *
 *  'fast'  - deterministic autocomplete mining (src/blog/demand-suggest.ts).
 *            ~1,900 tokens of input, effectively free, real search phrases.
 *  'deep'  - the LLM web-search pass. ~$0.21 a run, and the only mode that can
 *            produce seasonal "why now" reasoning from trade sources.
 *
 *  'fast' is the default because 99.6% of a 'deep' click is the search step and
 *  three of them cost 41% of a month's LLM bill. 'deep' must stay an explicit
 *  owner choice: an automatic escalation would spend money nobody asked for. */
export type DemandMode = 'fast' | 'deep';

export async function proposeTopics(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  opts: {
    packs: FactPack[]; window: { season: string; months: string[] }; count?: number;
    mode?: DemandMode; suggestSource?: SuggestSource;
  }
): Promise<TopicResearchResult> {
  const count = opts.count ?? 5;
  const mode: DemandMode = opts.mode ?? 'fast';
  const packByHandle = new Map(opts.packs.map((p) => [p.collectionHandle, p]));
  const handles = [...packByHandle.keys()];
  const monthList = opts.window.months.join(', ');
  if (!handles.length) {
    return { candidates: [], demand: { grounded: false, signals: [], note: 'No collection was eligible.' } };
  }

  const catalog = opts.packs.map((p) => {
    const names = p.products.filter((x) => x.available).slice(0, 6).map((x) => x.title).join(', ');
    return `- ${p.collectionTitle} [${p.collectionHandle}]: ${names}`;
  }).join('\n');

  // STEP 1: go and find out what people are actually searching for. Separating
  // this from topic generation is the substance of the 2026-08-11 change. The
  // old single call told one model to "judge demand" while also writing titles,
  // so when its search silently stopped working there was no observable
  // difference between a researched answer and a seasonal guess. Now the
  // evidence exists as data before any topic is written, and its absence is
  // visible to the owner instead of being swallowed by a fallback.
  let signals: DemandSignal[];
  let sourceLabel: string;
  if (mode === 'deep') {
    signals = await researchDemand(llm, store, cfg, { validHandles: handles, catalog, window: opts.window });
    sourceLabel = 'live web research';
  } else {
    const source = opts.suggestSource ?? new GoogleSuggestSource();
    const out = await researchDemandDeterministic(opts.packs, source, { max: 8 });
    signals = out.signals;
    sourceLabel = 'real search-autocomplete data';
    console.log(`blog demand (fast): ${signals.length} signal(s) from ${out.seeds.length} seed(s), sourceFailed=${out.sourceFailed}`);
    if (signals.length) {
      // Snapshot every run. The rising/falling signal autocomplete cannot give
      // us today is recoverable by DIFFING these over months, and it cannot be
      // backfilled, so the cost of storing from day one is the price of having
      // the option at all.
      await store.saveDemandSnapshot(mode, signals).catch((e) => console.warn(`demand snapshot failed: ${(e as Error).message}`));
    }
  }

  const demand: DemandEvidence = signals.length
    ? {
        grounded: true,
        signals,
        note: `Ranked on ${signals.length} demand signal(s) from ${sourceLabel}, for ${monthList}.`
      }
    : {
        grounded: false,
        signals: [],
        note: mode === 'deep'
          ? `Live web research was unavailable, so these are evergreen picks from your in-stock collections for ${monthList}, not trend-ranked suggestions.`
          : `Search-autocomplete data was unavailable, so these are evergreen picks for ${monthList}. Deep research can still be run deliberately.`
      };

  // STEP 2: turn the evidence into buildable topics. One call, no hidden
  // fallback: the prompt already knows whether it has demand evidence, and says
  // so honestly either way.
  const chain = resolveChain(cfg, 'text');
  const r = await llm.jsonChain<BlogTopicCandidate[]>({
    chain, maxTokens: 1800,
    system: buildTopicSystem(handles, catalog, opts.window, count, signals),
    user: JSON.stringify({ readInMonths: opts.window.months, season: opts.window.season, count }),
    validate: (v) => validateCandidates(v, packByHandle, count)
  });
  if (!r.ok) { console.warn(`blog topic research failed: ${r.error}`); return { candidates: [], demand }; }
  // Always 'blog-topics'. Naming this row for whether the SEPARATE demand pass
  // succeeded would recreate the exact ambiguity this change removes: this call
  // never carries the web plugin, so a '-web' label on it would again describe
  // something other than the request it records. Whether a run was researched is
  // told by the presence of a 'blog-demand' row, whose token count makes real
  // search self-evident.
  await store.logLlmUsage('blog-topics', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  console.log(`blog topics: ${r.value.length} candidate(s), demandGrounded=${demand.grounded}, costUsd=${r.usage.costUsd}`);
  return { candidates: r.value, demand };
}
