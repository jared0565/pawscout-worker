import type { CjClient, CjSearchItem } from '../cj';
import type { TenantStore, WarehouseRow } from '../tenant-store';
import type { Gates, TenantConfig } from '../types';
import { retailPriceGbp } from '../pricing';
import { getKeywordMeta, type LlmClient } from '../llm';
import { getExpansions } from '../semantic/library';

export const CACHE_TTL_DAYS = 30; // PS retention promise: cached supplier data lives 30 days

export interface GhostCard {
  pid: string;
  title: string;
  image: string;
  price: number; // GBP retail under the tenant's pricing rule
  state: 'ghost' | 'imported';
  url: string | null; // real PDP when already imported
}

export function normalizeKeyword(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 80);
}

// Words that carry no product meaning — dropped before matching so
// "toys for cats" behaves like "toy cat".
const STOPWORDS = new Set(['for', 'the', 'and', 'with', 'an', 'to', 'of', 'in', 'on', 'my', 'your', 'a']);

/** Light plural → singular stem so "toys" matches a "Toy" title (the #1 search miss). */
function stemToken(w: string): string {
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2); // brushes→brush, boxes→box
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1); // toys→toy, balls→ball
  return w;
}

/** Significant, plural-normalised query tokens (stopwords + 1-char noise dropped). */
export function keywordTokens(keyword: string): string[] {
  return [
    ...new Set(
      keyword
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
        .map(stemToken)
    )
  ];
}

// --- Mechanical pet-relevance guard (LLM-free) ---
// The LLM curation gate is the real niche filter, but admission degrades to
// mechanical gates when the LLM is down — and those don't check pet-relevance,
// which is how human/kitchen/garden tools slipped in once. This is the floor:
// a clear pet signal always admits; with no pet signal, a clear NON-pet signal
// rejects. Ambiguous (neither signal) admits — the LLM tightens it when up.
const PET_TOKENS = new Set([
  'pet', 'pets', 'dog', 'dogs', 'puppy', 'puppies', 'pup', 'pups', 'canine', 'doggy', 'doggie',
  'cat', 'cats', 'kitten', 'kittens', 'kitty', 'feline', 'paw', 'paws', 'kennel', 'leash', 'collar',
  'harness', 'litter', 'aquarium', 'fish', 'bird', 'rabbit', 'hamster', 'pup', 'kitties'
]);
// Distinctive non-pet markers (human grooming, kitchen, garden, power tools,
// and human jewelry/accessories). Each is matched as a substring of the lowercased
// text, so every entry MUST be a phrase that never legitimately appears in a pet
// product title — that's why jewelry words like 'necklace'/'pendant' are safe but
// 'ring' (chew ring), 'sweater'/'shirt' (pet apparel is a real category) are NOT
// listed here (the LLM curation gate handles those ambiguous apparel cases).
const NONPET_MARKERS = [
  'kitchen', 'knife sharpen', 'pruning', 'tree branch', 'branch cutter', 'garden', 'lawn',
  'hairdress', 'barber', 'tailor', 'sewing', 'chainsaw', 'human hair', 'nail art', 'manicure',
  'necklace', 'pendant', 'bracelet', 'earring', 'brooch', 'lingerie', 'phone case', 'pearl chain'
];

/** LLM-free floor: would a human reasonably see this as a pet product? */
export function isLikelyPetProduct(text: string): boolean {
  const t = (text || '').toLowerCase();
  const words = t.split(/[^a-z0-9]+/);
  if (words.some((w) => PET_TOKENS.has(w))) return true; // explicit pet signal → admit
  return !NONPET_MARKERS.some((m) => t.includes(m));     // no pet signal: reject only on a clear non-pet marker
}

/**
 * STRICT live-feed pet gate: REQUIRE an explicit pet signal. Unlike isLikelyPetProduct,
 * an ambiguous item (no pet token AND no non-pet marker) is REJECTED, not admitted.
 * Used ONLY on the live-CJ supplier feed, where a non-pet false positive (human/baby/car
 * shampoo for a bare "shampoo" search) is the worst outcome — precision beats recall on a
 * supplemental feed. Safe because RAW CJ titles are keyword-stuffed (a real pet product
 * says "pet/dog/cat"; a human one does not) — note imported store titles are DE-stuffed by
 * curateProduct, so this gate is only sound on raw CJ results. PET_TOKENS is the recall
 * lever: if a legitimate pet product is dropped, EXPAND that set — don't drop the gate.
 */
export function isPetProductStrict(text: string): boolean {
  const words = (text || '').toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => PET_TOKENS.has(w));
}

// --- Title signature for dedupe-at-admission ---
const TITLE_STOP = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'with', 'of', 'to', 'your', 'in', 'on', 'by', 'pet', 'pets']);

/**
 * Order-independent fingerprint of a title's significant tokens. Two listings
 * with the same significant words (incl. reorderings, and the literal twins like
 * the duplicate "Pet Teeth Cleaning Powder 100g") collapse to one signature;
 * genuinely different products (glove vs spa vs shampoo brush) do NOT — so it
 * blocks true duplicates at admission without over-merging distinct items.
 */
export function titleSignature(title: string): string {
  const toks = [
    ...new Set(
      (title || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !TITLE_STOP.has(t))
    )
  ].sort();
  return toks.join(',');
}

// --- Category signal (LLM-free): map a title to ONE collection, or nothing ---
// Keyed to the standard Active Paw collections; a sweep only re-files a product
// when its title points unambiguously at a single category that differs from
// where it sits — so it never overrides a reasonable (possibly LLM-made) call.
const CATEGORY_SIGNALS: Record<string, string[]> = {
  'pet-health': ['dental', 'teeth', 'tooth', 'toothbrush', 'oral', 'tartar', 'gum', 'dewormer', 'supplement', 'vitamin', 'wound', 'first aid'],
  'pet-toys': ['toy', 'toys', 'ball', 'chew', 'squeaky', 'squeak', 'teaser', 'catnip', 'scratcher', 'fetch', 'plush', 'kicker', 'wand'],
  'pet-cleaning': ['bath', 'shampoo', 'towel', 'bathrobe', 'wash', 'shower', 'paw clean', 'paw cleaner'],
  'pet-grooming': ['comb', 'nail clipper', 'nail grinder', 'grinder', 'scissor', 'deshed', 'shedding', 'grooming', 'trimmer', 'clipper', 'slicker', 'detangle', 'detangling', 'razor'],
  'pet-accessories': ['leash', 'harness', 'collar', 'bowl', 'feeder', 'water bottle', 'carrier', 'diaper', 'airtag', 'raincoat', 'apparel']
};

/** The single collection a title clearly belongs to, or null if 0 or >1 match. */
export function signaledCategory(title: string): string | null {
  const t = (title || '').toLowerCase();
  const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
  const matched = new Set<string>();
  for (const [cat, signals] of Object.entries(CATEGORY_SIGNALS)) {
    for (const sig of signals) {
      const hit = sig.includes(' ') ? t.includes(sig) : tokens.some((tok) => tok === sig || tok.startsWith(sig));
      if (hit) { matched.add(cat); break; }
    }
  }
  return matched.size === 1 ? [...matched][0] : null;
}

// --- Live-CJ category gate (LLM-free, raw-feed only) ---
// CJ's own top-level category (oneCategoryName) is independent of the title.
// CJ MIS-FILES some real pet items into catch-all tops (Home/Garden, Sports),
// so a top category can be trusted to DROP but not to ADMIT. These markers are
// tops that never legitimately hold a pet product → a match is a hard drop even
// when the title carries a pet token (the jewelry / phone-case / human-shampoo
// false positives the title floor alone misses). Matched as case-insensitive
// substrings of oneCategoryName; extend when a new non-pet top bearing
// pet-token items is observed in the live feed.
const HARD_DROP_TOP_CATEGORIES = [
  'jewelry', 'phone', 'beauty', 'apparel', 'clothing', 'electronics', 'automobile', 'motorcycle'
];

/**
 * Live-CJ category gate: reject only when CJ's TOP category is unambiguously
 * non-pet. Blank/absent or an ambiguous catch-all → admit (defer to the title
 * pet floor). Composes WITH isPetProductStrict — it never replaces it, so the
 * change is additive: an absent category behaves exactly as before.
 */
export function categoryAdmitsLiveCj(topCategory?: string): boolean {
  const t = (topCategory || '').toLowerCase();
  if (!t) return true; // no category signal → defer to the title floor
  return !HARD_DROP_TOP_CATEGORIES.some((m) => t.includes(m));
}

// Species vocabulary — the single most important relevance signal in a
// pet store (a "dog toy" search must never show cat products).
const DOG_WORDS = new Set(['dog', 'dogs', 'puppy', 'puppies', 'pup', 'pups', 'canine', 'doggy', 'doggie']);
const CAT_WORDS = new Set(['cat', 'cats', 'kitten', 'kittens', 'kitty', 'kitties', 'feline']);

/** Detect the target animal named in free text. 'both' when dog AND cat appear. */
function detectSpecies(text: string): 'dog' | 'cat' | 'both' | null {
  let dog = false;
  let cat = false;
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (DOG_WORDS.has(w)) dog = true;
    else if (CAT_WORDS.has(w)) cat = true;
  }
  return dog && cat ? 'both' : dog ? 'dog' : cat ? 'cat' : null;
}

/** The species a query names, if any. */
export function querySpecies(keyword: string): 'dog' | 'cat' | 'both' | null {
  return detectSpecies(keyword);
}

/** True only when query and title name DIFFERENT single species (dog vs cat). */
export function speciesConflict(keyword: string, title: string): boolean {
  const q = detectSpecies(keyword);
  const t = detectSpecies(title);
  if (!q || !t || q === 'both' || t === 'both') return false;
  return q !== t;
}

export function relevanceMatch(keyword: string, title: string, mode: Gates['relevance']): boolean {
  // Species gate FIRST — a cat product never matches a dog query, in any mode.
  if (speciesConflict(keyword, title)) return false;
  if (mode === 'loose') return true; // trust the source's own match
  // Word-boundary match: build the SET of stemmed title words, so a query
  // token only matches a whole word. "cat" must NOT match "catapult"; "toys"
  // still matches "Toy" because both sides are stemmed to their singular root.
  const titleWords = new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(stemToken)
  );
  const tokens = keywordTokens(keyword);
  if (!tokens.length) return false;
  return mode === 'strict' ? tokens.every((tok) => titleWords.has(tok)) : tokens.some((tok) => titleWords.has(tok));
}

/**
 * Gate for LIVE CJ (listV2) results. listV2 is CJ's elasticsearch search and
 * already did the category work, so we TRUST its relevance and instead enforce
 * the two things it doesn't: price/quality and SPECIES. When the query names an
 * animal, the product must be that animal — which both reaches the grid target
 * (any genuine dog product fills a "dog toy" search, not just ones with the
 * literal word "toy") AND blocks species-less junk (advent calendars) and the
 * wrong species. Non-species queries fall back to category-token matching.
 */
export function liveCjPasses(item: CjSearchItem, gates: Gates, keyword: string): boolean {
  if (item.listedNum < gates.popularityFloor) return false;
  if (item.sellPriceUsd < gates.priceMin || item.sellPriceUsd > gates.priceMax) return false;
  const qs = detectSpecies(keyword);
  if (qs && qs !== 'both') {
    const ts = detectSpecies(item.nameEn);
    return ts === qs || ts === 'both';
  }
  return relevanceMatch(keyword, item.nameEn, gates.relevance);
}

export function passesGates(item: CjSearchItem, gates: Gates, keyword: string): boolean {
  return (
    item.listedNum >= gates.popularityFloor &&
    item.sellPriceUsd >= gates.priceMin &&
    item.sellPriceUsd <= gates.priceMax &&
    relevanceMatch(keyword, item.nameEn, gates.relevance)
  );
}

function warehousePasses(row: WarehouseRow, cfg: TenantConfig, keyword: string): boolean {
  return (
    row.listed_num >= cfg.gates.popularityFloor &&
    row.price_usd >= cfg.gates.priceMin &&
    row.price_usd <= cfg.gates.priceMax &&
    row.stock >= cfg.floors.stockFloor &&
    relevanceMatch(keyword, row.title, cfg.gates.relevance)
  );
}

function firstImage(row: WarehouseRow): string {
  try {
    const detail = JSON.parse(row.detail) as { images?: string[] };
    return detail.images?.[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Storefront search backfill — WAREHOUSE FIRST (W1).
 *
 * 1. Match against the PS-local warehouse: zero CJ calls, gates re-applied at
 *    read time (config may have changed since admission), ranked by how many
 *    keyword tokens hit, then popularity.
 * 2. Only when the warehouse can't fill the grid, fall back to one live CJ
 *    search (30-day cached) — and the logged shortfall steers the nightly
 *    replenishment toward this keyword.
 */
export async function searchBackfill(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  query: string,
  storeHits: number,
  limit: number,
  opts: { liveFallback?: boolean; exclude?: string[]; llm?: LlmClient; fetchImpl?: typeof fetch; ctx?: { waitUntil(p: Promise<unknown>): void } } = {}
): Promise<GhostCard[]> {
  const kw = normalizeKeyword(query);
  if (!kw) return [];

  // Query expansion (skipped entirely in strict mode — expansion must never
  // loosen an explicitly strict gate). Two sources, unioned:
  //  - W3 classified-keyword synonyms (e.g. "puppy chew" → "dog toy");
  //  - the shared pet semantic term library (collection-agnostic), cache-only
  //    with a background lazy-fill on a miss when llm+ctx are supplied.
  // The pet floor (isPetProductStrict) still gates the live-CJ results below.
  const loose = cfg.gates.relevance !== 'strict';
  const meta = await getKeywordMeta(store, kw);
  const semExpansions = loose
    ? await getExpansions(store, cfg, kw, '', { llm: opts.llm, fetchImpl: opts.fetchImpl, ctx: opts.ctx })
    : [];
  const extra = [...(loose && meta?.synonyms.length ? meta.synonyms : []), ...semExpansions];
  const expanded = extra.length ? `${kw} ${extra.join(' ')}` : kw;
  const tokens = keywordTokens(expanded);

  const cards: GhostCard[] = [];
  // Seed `seen` with products already rendered on the page (passed by the
  // theme) so backfill never duplicates a card the visitor can already see.
  const seen = new Set<string>(opts.exclude ?? []);

  // --- 1) warehouse ---
  const rows = await store.searchWarehouse(tokens, limit * 3);
  const ranked = rows
    .filter((r) => warehousePasses(r, cfg, expanded))
    .map((r) => ({ r, hits: tokens.filter((t) => r.search_text.includes(t)).length }))
    .sort((a, b) => b.hits - a.hits || b.r.listed_num - a.r.listed_num);

  const whLinks = await store.getLinks(ranked.map((x) => x.r.cj_pid));
  for (const { r } of ranked) {
    if (cards.length >= limit) break;
    if (seen.has(r.cj_pid)) continue;
    const link = whLinks.get(r.cj_pid);
    const imported = link?.state === 'imported' && link.handle;
    cards.push({
      pid: r.cj_pid,
      title: r.title,
      image: firstImage(r),
      price: retailPriceGbp(r.price_usd, cfg.pricing),
      state: imported ? 'imported' : 'ghost',
      url: imported ? `/products/${link!.handle}` : null
    });
    seen.add(r.cj_pid);
  }

  // --- 2) live CJ fallback (cached per keyword for 30 days) ---
  if (cards.length < limit && (opts.liveFallback ?? true)) {
    let items: CjSearchItem[];
    // kw2: cache namespace — bumped from kw: when topCategory was added so the
    // category gate takes effect on already-cached hot keywords instead of
    // waiting up to CACHE_TTL_DAYS for stale (category-less) entries to expire.
    const cached = await store.getSearchCache(`kw2:${kw}`);
    if (cached) {
      items = JSON.parse(cached);
    } else {
      items = await cj.search(kw);
      await store.putSearchCache(`kw2:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
    }
    // Live-CJ PET FLOOR: CJ keyword search returns human/baby/car products too (a bare
    // "shampoo" surfaces human shampoo). Require an explicit pet signal on the raw CJ
    // title. Species queries ("dog shampoo") are already gated by liveCjPasses; the floor
    // earns its keep on bare terms like "shampoo"/"brush"/"nail clipper".
    const gated = items.filter((i) => !seen.has(i.pid) && liveCjPasses(i, cfg.gates, kw) && categoryAdmitsLiveCj(i.topCategory) && isPetProductStrict(i.nameEn));
    const links = await store.getLinks(gated.map((i) => i.pid));
    for (const item of gated) {
      if (cards.length >= limit) break;
      const link = links.get(item.pid);
      const imported = link?.state === 'imported' && link.handle;
      cards.push({
        pid: item.pid,
        title: item.nameEn,
        image: item.image,
        price: retailPriceGbp(item.sellPriceUsd, cfg.pricing),
        state: imported ? 'imported' : 'ghost', // archived/failed re-offer as ghost: demand revives
        url: imported ? `/products/${link!.handle}` : null
      });
      seen.add(item.pid);
    }
  }

  // Swap CJ's raw thumbnail for the vision-vetted hero when we have one cached
  // (populated when a product is previewed or imported). This is what makes a
  // "cat on a dog listing" card self-heal — the grid shows the congruent image.
  const heroes = await store.getHeroImages(cards.map((c) => c.pid));
  if (heroes.size) {
    for (const card of cards) {
      const hero = heroes.get(card.pid);
      if (hero) card.image = hero;
    }
  }

  await store.logSearch(kw, storeHits, cards.length);
  return cards;
}
