// src/blog/demand-suggest.ts
//
// DETERMINISTIC demand research: what people actually type into a search box,
// from Google's autocomplete endpoint, ranked by code rather than by a model.
//
// WHY THIS EXISTS. The LLM web-search pass (`researchDemand` in research.ts)
// works and costs ~$0.21 a click, of which 99.6% is the search step: one
// measured run injected 138,095 prompt tokens for $0.2576, and three clicks on
// 2026-08-11 came to 41% of that month's entire LLM bill. This repo has already
// solved that exact problem once - see the header of `src/market.ts`, where an
// LLM acting as a search engine (~$0.29/lookup, 98% of spend) was replaced with
// a structured source plus deterministic code. Same shape, same fix.
//
// Measured 2026-08-11: 22 requests -> 216 unique real search phrases, 7,722
// bytes (~1,930 tokens), zero failures. About 70x less input than the LLM pass,
// and it surfaces the same signals - the LLM's top pick was "cat water fountain
// stainless steel", which autocomplete returns as suggestion #2 for free.
//
// WHAT IT CANNOT DO: there is no volume figure and no rising/falling signal, so
// it cannot produce reasoning like "back-to-routine purchases peak in
// September-October". That is why this is the DEFAULT and not the only mode -
// the LLM pass stays available as an explicit "deep research" choice.
//
// Every `why` string here is generated from observed evidence (rank, recurrence)
// and never written by a model, so a signal cannot be fabricated.

import type { DemandSignal, FactPack } from './types';
import { titleTokens, titleSimilarity } from '../market';
import { defaultFetch } from '../safe-fetch';

/** A source of real search phrases for a seed. `null` means the SOURCE failed
 *  (network/HTTP) so the caller may degrade; `[]` means it answered and had
 *  nothing. Same null-vs-empty contract as MarketSource.search in market.ts. */
export interface SuggestSource {
  name: string;
  suggest(seed: string): Promise<string[] | null>;
}

const SUGGEST_URL = 'https://suggestqueries.google.com/complete/search';

/** Google autocomplete. No key, no auth, ~351 bytes per request. */
export class GoogleSuggestSource implements SuggestSource {
  readonly name = 'google-autocomplete';
  constructor(private readonly fetchImpl: typeof fetch = defaultFetch) {}

  async suggest(seed: string): Promise<string[] | null> {
    const url = `${SUGGEST_URL}?client=firefox&hl=en&gl=uk&q=${encodeURIComponent(seed)}`;
    try {
      const r = await this.fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) { console.warn(`suggest failed for "${seed}": HTTP ${r.status}`); return null; }
      const parsed = JSON.parse(await r.text()) as unknown;
      // Shape: [query, [suggestions], [], {...}]
      const terms = Array.isArray(parsed) ? (parsed as unknown[])[1] : null;
      if (!Array.isArray(terms)) return [];
      return terms.filter((t): t is string => typeof t === 'string');
    } catch (e) {
      console.warn(`suggest error for "${seed}": ${(e as Error).message}`);
      return null;
    }
  }
}

// --- Noise: what autocomplete returns that is NOT a content topic ---
//
// All three classes below were observed in the real 2026-08-11 measurement, not
// imagined. Keeping them as explicit word lists (rather than clever heuristics)
// is deliberate: this is exactly the kind of filter that must be readable and
// testable, because a miss ends up as a published article title.

/** Retailers and marketplaces. Dropping these is REQUIRED, not a nicety: the
 *  standing rule is that no competitor or supplier brand may surface
 *  customer-facing, and a topic built on "dog bed bunnings" would do exactly
 *  that. Observed: "dog bed bunnings", "cat water fountain kmart",
 *  "cat water fountain amazon". */
const RETAILER_TOKENS = [
  'amazon', 'ebay', 'etsy', 'temu', 'aliexpress', 'wish', 'shein', 'alibaba',
  'argos', 'wilko', 'dunelm', 'homebase', 'wickes', 'screwfix', 'ikea', 'costco',
  'asda', 'tesco', 'sainsburys', 'sainsbury', 'morrisons', 'aldi', 'lidl',
  'wilkinsons', 'poundland', 'wayfair', 'matalan', 'primark', 'currys',
  'bunnings', 'kmart', 'walmart', 'target', 'petsmart', 'petco', 'chewy',
  'petsathome', 'zooplus', 'jollyes', 'range', 'homebargains', 'bm', 'temuuk'
];

/** Geo-qualified queries are SHOPPING-navigational, not content. Note this is
 *  market-neutral on purpose: Active Paw is multi-market (UK primary, plus US,
 *  CA, EU, AU), so "cat bed uk" is no more useful as a guide topic than
 *  "cat bed nz". Both are someone looking for a shop, not a guide. */
const GEO_TOKENS = [
  'uk', 'usa', 'nz', 'australia', 'australian', 'canada', 'canadian', 'ireland',
  'india', 'dubai', 'singapore', 'malaysia', 'philippines', 'pakistan', 'kenya',
  'nigeria', 'europe', 'scotland', 'wales'
];

/** Local / transactional / DIY intent. A DIY query wants instructions for making
 *  the thing we sell, so it funnels badly even when the topic looks adjacent. */
const INTENT_NOISE = [
  /\bnear\s?me\b/, /\bnearby\b/, /\bopening\s+times\b/, /\bfor\s+sale\b/,
  /\bsecond\s?hand\b/, /\bused\b/, /\bcheap(est)?\b/, /\bdiscount\b/,
  /\bvoucher\b/, /\bcoupon\b/, /\bdiy\b/, /\bhomemade\b/, /\bhow\s+to\s+make\b/,
  /\bfree\s+delivery\b/, /\bwholesale\b/, /\bb&m\b/, /\bpets\s+at\s+home\b/,
  /\bhome\s+bargains\b/
];

/** True when a phrase is a shop-hunt, a competitor query, or a DIY request
 *  rather than something an article could answer. */
export function isNoisePhrase(phrase: string): boolean {
  const p = ` ${(phrase || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim()} `;
  if (!p.trim()) return true;
  for (const re of INTENT_NOISE) if (re.test(p)) return true;
  // WHOLE-WORD only. An earlier version also tested tokens against the phrase
  // with its spaces removed, which made every token over 4 characters match as
  // a SUBSTRING: "range" hit inside "orange", "target" inside "targeted", so
  // "cat litter box orange" would have been silently dropped as a retailer
  // query. Multi-word retailer names live in INTENT_NOISE as regexes instead.
  for (const t of RETAILER_TOKENS) if (p.includes(` ${t} `)) return true;
  for (const t of GEO_TOKENS) if (p.includes(` ${t} `)) return true;
  return false;
}

// --- Seeds ---

/** Seed phrases to expand, built from what we ACTUALLY stock so every signal is
 *  answerable from the catalog. Collection titles give breadth; the most common
 *  content tokens across live product titles give the specifics people search.
 *  Each seed is one HTTP request, so the count is capped. */
export function buildSeeds(packs: FactPack[], maxSeeds = 12): string[] {
  const seeds: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const k = s.toLowerCase().trim();
    if (k && !seen.has(k)) { seen.add(k); seeds.push(k); }
  };

  for (const p of packs) {
    // The collection itself is a real category people search.
    push(p.collectionTitle);

    // Then product vocabulary. Two rules, both learned by running this against
    // the REAL catalog instead of tidy fixtures - see
    // tests/demand-suggest-realcatalog.test.ts:
    //
    // 1. Alphabetic tokens only. Live titles carry sizes and pack counts, and
    //    the naive version emitted the seed `63cm cat`, lifted from a real
    //    product title. Nobody searches that, and autocomplete returns junk
    //    for it. titleTokens drops BARE numbers but keeps `63cm`.
    // 2. The bigram must RECUR across at least two products. A phrase that
    //    appears in one title is a fragment of that title, not catalog
    //    vocabulary - that is what turned `6-Panel Metal Dog Playpen` into the
    //    seed `panel metal`. Recurrence is the cheapest available proxy for
    //    `this is what this category is actually called`.
    //
    // A collection whose vocabulary is too thin to clear rule 2 contributes
    // only its title, which is the correct conservative outcome.
    const freq = new Map<string, number>();
    for (const prod of p.products.filter((x) => x.available)) {
      const toks = titleTokens(prod.title).filter((t) => /^[a-z]+$/.test(t) && t.length > 2);
      const seenHere = new Set<string>();
      for (let i = 0; i < toks.length - 1; i++) {
        const bigram = `${toks[i]} ${toks[i + 1]}`;
        if (seenHere.has(bigram)) continue;   // count each product once
        seenHere.add(bigram);
        freq.set(bigram, (freq.get(bigram) ?? 0) + 1);
      }
    }
    const top = [...freq.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2);
    for (const [bigram] of top) push(bigram);
  }
  return seeds.slice(0, maxSeeds);
}

// --- Mapping + ranking ---

const MAP_MIN_SIM = 0.34;
/** A phrase must also resemble a REAL PRODUCT, not merely the category name.
 *  Observed on the first live run (2026-08-13): seeding with the collection
 *  title `pet health` made autocomplete return `pet health insurance`, which
 *  matched the collection title strongly and was published as a demand signal -
 *  for a category-level query we cannot sell anything against. Matching the
 *  CATEGORY NAME is not evidence we can answer the query; matching a product is. */
const MIN_PRODUCT_SIM = 0.2;

/** Which stocked collection a phrase belongs to, by token overlap against the
 *  collection title AND its live product titles. Below threshold returns null
 *  and the phrase is DROPPED - we would rather lose a real signal than propose
 *  a topic we cannot back with products. No LLM. */
export function mapToCollection(phrase: string, packs: FactPack[]): string | null {
  let best: { handle: string; sim: number; prodSim: number } | null = null;
  for (const p of packs) {
    let prodSim = 0;
    for (const prod of p.products.filter((x) => x.available)) {
      const s = titleSimilarity(phrase, prod.title);
      if (s > prodSim) prodSim = s;
    }
    const sim = Math.max(titleSimilarity(phrase, p.collectionTitle), prodSim);
    if (!best || sim > best.sim) best = { handle: p.collectionHandle, sim, prodSim };
  }
  if (!best || best.sim < MAP_MIN_SIM) return null;
  // Matched the category name but nothing we stock -> we cannot back a topic
  // about it, so drop rather than funnel it somewhere plausible-looking.
  if (best.prodSim < MIN_PRODUCT_SIM) return null;
  return best.handle;
}

/** One raw observation of a phrase: which seed produced it and at what rank. */
export interface RawSuggestion { phrase: string; seed: string; rank: number }

/**
 * Rank observations into DemandSignals.
 *
 * Autocomplete is roughly popularity-ordered, so a low rank is a strong signal;
 * a phrase recurring across DIFFERENT seeds is stronger still, because it means
 * the interest is not an artefact of one seed's wording. Score is deliberately
 * simple and total-order-stable so the same input always yields the same list.
 */
export function rankSignals(raw: RawSuggestion[], packs: FactPack[], max = 8): DemandSignal[] {
  const byPhrase = new Map<string, { bestRank: number; seeds: Set<string> }>();
  for (const r of raw) {
    const key = r.phrase.toLowerCase().trim();
    if (!key || isNoisePhrase(key)) continue;
    // A suggestion identical to the seed that produced it is not DISCOVERY, it
    // is our own vocabulary handed back. The first live run surfaced `pet toys`
    // and `pet accessories` as top signals purely because they are the seeds.
    // The whole value here is the phrases we did not already know.
    if (key === r.seed.toLowerCase().trim()) continue;
    const cur = byPhrase.get(key);
    if (cur) { cur.bestRank = Math.min(cur.bestRank, r.rank); cur.seeds.add(r.seed); }
    else byPhrase.set(key, { bestRank: r.rank, seeds: new Set([r.seed]) });
  }

  const scored: { sig: DemandSignal; score: number; phrase: string }[] = [];
  for (const [phrase, obs] of byPhrase) {
    const handle = mapToCollection(phrase, packs);
    if (!handle) continue;
    // A seed is itself a suggestion at rank 0; that is not evidence of demand
    // for anything beyond the category we already knew we stock.
    const recurrence = obs.seeds.size;
    const score = recurrence * 10 - obs.bestRank;
    const seedList = [...obs.seeds].sort();
    scored.push({
      phrase,
      score,
      sig: {
        term: phrase,
        collectionHandle: handle,
        why: recurrence > 1
          ? `Autocomplete rank ${obs.bestRank + 1}, recurring across ${recurrence} product areas (${seedList.slice(0, 3).join('; ')}).`
          : `Autocomplete rank ${obs.bestRank + 1} for "${seedList[0]}".`
      }
    });
  }
  scored.sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));

  // Spread across collections so the list is not one category five times over.
  const perCollection = new Map<string, number>();
  const cap = Math.max(1, Math.ceil(max / Math.max(1, packs.length)));
  const out: DemandSignal[] = [];
  for (const s of scored) {
    const used = perCollection.get(s.sig.collectionHandle) ?? 0;
    if (used >= cap) continue;
    perCollection.set(s.sig.collectionHandle, used + 1);
    out.push(s.sig);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The deterministic demand pass. Returns [] when the source is unreachable, and
 * the caller then degrades VISIBLY rather than silently escalating to the paid
 * LLM path: spending $0.21 the owner did not ask for is a worse failure than
 * showing evergreen topics and saying so.
 */
export async function researchDemandDeterministic(
  packs: FactPack[],
  source: SuggestSource,
  opts: { max?: number; maxSeeds?: number } = {}
): Promise<{ signals: DemandSignal[]; seeds: string[]; sourceFailed: boolean }> {
  const seeds = buildSeeds(packs, opts.maxSeeds ?? 12);
  const raw: RawSuggestion[] = [];
  let failures = 0;
  // Sequential on purpose: a burst is the quickest way to get rate limited, and
  // 12 requests of ~350 bytes is not worth parallelising.
  for (const seed of seeds) {
    const terms = await source.suggest(seed);
    if (terms === null) { failures++; continue; }
    terms.forEach((phrase, rank) => raw.push({ phrase, seed, rank }));
  }
  const sourceFailed = failures === seeds.length && seeds.length > 0;
  return { signals: rankSignals(raw, packs, opts.max ?? 8), seeds, sourceFailed };
}
