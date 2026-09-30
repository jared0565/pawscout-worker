import type { CjClient, CjSearchItem } from '../cj';
import type { TenantStore, WarehouseRow } from '../tenant-store';
import type { Gates, TenantConfig } from '../types';
import { retailPriceGbp } from '../pricing';
import { getKeywordMeta, type LlmClient } from '../llm';
import { getExpansions } from '../semantic/library';
import { bestLocalQty, localWarehousesFor, inquiryWarehouses } from '../local-markets';
import { resolveLogistics, doorToDoorBand, formatBand } from '../logistics';
import { productNetAfterAds } from '../profitability';

export const CACHE_TTL_DAYS = 30; // PS retention promise: cached supplier data lives 30 days

export interface GhostCard {
  pid: string;
  title: string;
  image: string;
  price: number; // GBP retail under the tenant's pricing rule
  state: 'ghost' | 'imported';
  url: string | null; // real PDP when already imported
  /** Where it ships from, for the card's note: overseas cards carry the door-to-door band. */
  delivery: { overseas: boolean; days: string | null };
}

export function normalizeKeyword(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 80);
}

// Words that carry no product meaning - dropped before matching so
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
// mechanical gates when the LLM is down - and those don't check pet-relevance,
// which is how human/kitchen/garden tools slipped in once. This is the floor:
// a clear pet signal always admits; with no pet signal, a clear NON-pet signal
// rejects. Ambiguous (neither signal) admits - the LLM tightens it when up.
const PET_TOKENS = new Set([
  'pet', 'pets', 'dog', 'dogs', 'puppy', 'puppies', 'pup', 'pups', 'canine', 'doggy', 'doggie',
  'cat', 'cats', 'kitten', 'kittens', 'kitty', 'feline', 'paw', 'paws', 'kennel', 'leash', 'collar',
  'harness', 'litter', 'aquarium', 'fish', 'bird', 'rabbit', 'hamster', 'pup', 'kitties'
]);
// Distinctive non-pet markers (human grooming, kitchen, garden, power tools,
// and human jewelry/accessories). Each is matched as a substring of the lowercased
// text, so every entry MUST be a phrase that never legitimately appears in a pet
// product title - that's why jewelry words like 'necklace'/'pendant' are safe but
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
 * shampoo for a bare "shampoo" search) is the worst outcome - precision beats recall on a
 * supplemental feed. Safe because RAW CJ titles are keyword-stuffed (a real pet product
 * says "pet/dog/cat"; a human one does not) - note imported store titles are DE-stuffed by
 * curateProduct, so this gate is only sound on raw CJ results. PET_TOKENS is the recall
 * lever: if a legitimate pet product is dropped, EXPAND that set - don't drop the gate.
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
 * genuinely different products (glove vs spa vs shampoo brush) do NOT - so it
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
// where it sits - so it never overrides a reasonable (possibly LLM-made) call.
const CATEGORY_SIGNALS: Record<string, string[]> = {
  'pet-health': ['dental', 'teeth', 'tooth', 'toothbrush', 'oral', 'tartar', 'gum', 'dewormer', 'supplement', 'vitamin', 'multivitamin', 'glucosamine', 'chondroitin', 'probiotic', 'prebiotic', 'omega', 'wound', 'first aid'],
  'pet-toys': ['toy', 'toys', 'ball', 'chew', 'squeaky', 'squeak', 'teaser', 'catnip', 'scratcher', 'fetch', 'plush', 'kicker', 'wand'],
  'pet-cleaning': ['bath', 'shampoo', 'towel', 'bathrobe', 'wash', 'shower', 'paw clean', 'paw cleaner'],
  'pet-grooming': ['comb', 'nail clipper', 'nail grinder', 'grinder', 'scissor', 'deshed', 'shedding', 'grooming', 'trimmer', 'clipper', 'slicker', 'detangle', 'detangling', 'razor'],
  'pet-accessories': ['leash', 'harness', 'collar', 'bowl', 'feeder', 'water bottle', 'carrier', 'diaper', 'airtag', 'raincoat', 'apparel']
};

// "Chew" is a toy signal, but supplements ship in chewable form too
// ("Multivitamin Chews", "Glucosamine Joint Chewables", "Dental Chew Sticks").
// Those are health/dental products, not chew toys - so when pet-toys' ONLY claim
// is the chew family AND a health signal is also present, health wins. Without
// this the mixed signal reads as ambiguous and the daily re-audit
// (reconcileCategories) leaves the supplement mis-filed under pet-toys forever.
const CHEW_SIGNAL = 'chew';

/** The single collection a title clearly belongs to, or null if 0 or >1 match. */
export function signaledCategory(title: string): string | null {
  const t = (title || '').toLowerCase();
  const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
  const hits: Record<string, string[]> = {};
  for (const [cat, signals] of Object.entries(CATEGORY_SIGNALS)) {
    for (const sig of signals) {
      const hit = sig.includes(' ') ? t.includes(sig) : tokens.some((tok) => tok === sig || tok.startsWith(sig));
      if (hit) (hits[cat] ??= []).push(sig);
    }
  }
  const matched = new Set(Object.keys(hits));
  // Supplement-format chew: health beats toy when chew is the toy's sole claim.
  if (matched.has('pet-toys') && matched.has('pet-health')
      && (hits['pet-toys'] ?? []).every((s) => s === CHEW_SIGNAL)) {
    matched.delete('pet-toys');
  }
  return matched.size === 1 ? [...matched][0] : null;
}

// --- Live-CJ category gate (LLM-free, raw-feed only) ---
// CJ's own top-level category (oneCategoryName) is independent of the title.
// CJ MIS-FILES some real pet items into catch-all tops (Home/Garden, Sports),
// so a top category can be trusted to DROP but not to ADMIT. A match here is a
// hard drop EVEN WHEN the title carries a pet token (the jewelry / phone-case /
// human-shampoo false positives the title floor alone misses).
//
// ONLY tops PROVEN pet-free by the live probe belong here - jewelry / phones /
// human beauty held ZERO pet items across the sampled keywords. Apparel,
// electronics and automotive were deliberately NOT added: CJ files real pet SKUs
// under them (dog raincoats/sweaters, automatic feeders/GPS/cameras, dog
// car-seat covers/ramps), and this module ELSEWHERE treats apparel as pet-legit
// (CATEGORY_SIGNALS lists 'raincoat'/'apparel'; NONPET_MARKERS omits pet apparel
// on purpose). Hard-dropping those would nuke genuine pet items with a pet-token
// title. EXTEND this list only after the live feed confirms a top holds no
// pet-token SKUs (watch the search.categoryGate.dropped log below).
// Matched as case-insensitive substrings; 'jewel' covers jewelry/jewellery.
const HARD_DROP_TOP_CATEGORIES = ['jewel', 'phone', 'beauty'];

/**
 * Live-CJ category gate: reject only when CJ's TOP category is unambiguously
 * non-pet. Blank/absent or an ambiguous catch-all → admit (defer to the title
 * pet floor). Composes WITH isPetProductStrict - it never replaces it, so the
 * change is additive: an absent category behaves exactly as before.
 */
export function categoryAdmitsLiveCj(topCategory?: string): boolean {
  const t = (topCategory || '').toLowerCase();
  if (!t) return true; // no category signal → defer to the title floor
  return !HARD_DROP_TOP_CATEGORIES.some((m) => t.includes(m));
}

// Species vocabulary - the single most important relevance signal in a
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
  // Species gate FIRST - a cat product never matches a dog query, in any mode.
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
 * animal, the product must be that animal - which both reaches the grid target
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

// Words that name the animal, not the product. The species check handles them,
// so they never count as product words a search has to match.
const ANIMAL_WORDS = new Set([...DOG_WORDS, ...CAT_WORDS, 'pet', 'pets']);
// One product, several spellings: a shopper asks for a "trackable" collar and
// the supplier titles it "GPS Tracker" (Aloha, 2026-09-29). Each family reads
// as its first word. Words are already stemmed by keywordTokens.
const TERM_FAMILIES: readonly (readonly string[])[] = [
  ['track', 'trackable', 'tracking', 'tracked', 'tracker', 'gps', 'locator', 'airtag'],
];
const FAMILY_OF = new Map<string, string>(TERM_FAMILIES.flatMap((f) => f.map((w) => [w, f[0]] as [string, string])));
const foldTerm = (w: string): string => FAMILY_OF.get(w) ?? w;

/** Every spelling of each family a query names, for the warehouse text search. */
export function familyWords(keyword: string): string[] {
  const hit = new Set(keywordTokens(keyword).map(foldTerm));
  return TERM_FAMILIES.filter((f) => hit.has(f[0])).flat();
}

/** The product words of a query or title: stemmed, stopwords and animal words dropped, synonyms folded. */
export function productTerms(text: string): string[] {
  return [...new Set(keywordTokens(text).filter((t) => !ANIMAL_WORDS.has(t)).map(foldTerm))];
}

/**
 * Does this title answer the storefront query? The species first: a title for
 * the other animal never does, and a species query needs a title for that
 * animal or for pets in general ("Pet Tracker" answers "dog gps tracker"). Then
 * the PRODUCT words under the owner's relevance setting: strict needs every
 * one, title needs one, loose trusts the source. A bare species query ("dog")
 * has no product words and keeps the species-only behaviour.
 */
export function titleAnswersQuery(keyword: string, title: string, mode: Gates['relevance']): boolean {
  const qs = detectSpecies(keyword);
  const ts = detectSpecies(title);
  if (qs && qs !== 'both') {
    if (ts ? ts !== qs && ts !== 'both' : !/\bpets?\b/i.test(title)) return false;
  } else if (speciesConflict(keyword, title)) return false;
  if (mode === 'loose') return true;
  const want = productTerms(keyword);
  if (!want.length) return qs !== null || relevanceMatch(keyword, title, mode);
  const have = new Set(keywordTokens(title).map(foldTerm));
  return mode === 'strict' ? want.every((t) => have.has(t)) : want.some((t) => have.has(t));
}

/** How many of the query's product words (families folded) the title carries;
 *  ranks supplier results so the closest match comes first. */
export function queryTermHits(keyword: string, title: string): number {
  const have = new Set(keywordTokens(title).map(foldTerm));
  return productTerms(keyword).filter((t) => have.has(t)).length;
}

/**
 * Gate for the STOREFRONT live feed. Unlike liveCjPasses (kept for the nightly
 * jobs, which read listV2 and trust its ranking), the storefront reads the
 * warehouse-filtered /product/list, which matches loosely: trusting it let
 * "trackable dog collar" fill the grid with any dog product (Aloha,
 * 2026-09-29). So the product words are checked here too.
 */
export function storefrontLivePasses(item: CjSearchItem, gates: Gates, keyword: string): boolean {
  if (item.listedNum < gates.popularityFloor) return false;
  if (item.sellPriceUsd < gates.priceMin || item.sellPriceUsd > gates.priceMax) return false;
  return titleAnswersQuery(keyword, item.nameEn, gates.relevance);
}

/**
 * Read-time profitability gate for ghost cards (2026-07-31).
 *
 * A ghost card is a supplier product that is NOT in the catalog, so this gate
 * structurally cannot touch an inventory product - live catalog results in
 * storefront search come from Shopify itself. That matters: the owner's rule is
 * that once a product is in inventory the profitability agent leaves it alone.
 *
 * DETERMINISTIC AND NETWORK-FREE BY DESIGN. It runs on a live shopper request,
 * so it must not call eBay or an LLM; it reuses productNetAfterAds, the SAME
 * floor logic the import entry gate applies, so a card we would refuse to
 * import is never put in front of a customer.
 *
 * FAILS OPEN. A null result means no usable price, and absence of data is not a
 * profitability failure - the same stance import.ts takes.
 *
 * Freight is often unknown at search time, which makes this check slightly
 * optimistic; the FULL judgment still runs at import if the shopper clicks, so
 * the two can disagree at the margin. That is accepted (see the design spec's
 * residual risks) and is the price of a search that stays fast.
 */
export function ghostCardClearsFloor(
  item: { sellPriceUsd: number },
  cfg: TenantConfig,
  freightUsd?: number
): boolean {
  const profit = cfg.profit;
  if (!profit?.enabled) return true; // gate dormant - unchanged behaviour
  const net = productNetAfterAds([{ sellPriceUsd: item.sellPriceUsd }], cfg.pricing, freightUsd, profit);
  if (!net) return true;             // no usable price: fail open, do not hide
  return !net.belowFloor;
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
    titleAnswersQuery(keyword, row.title, cfg.gates.relevance)
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
 * Storefront search backfill - WAREHOUSE FIRST (W1).
 *
 * 1. Match against the PS-local warehouse: zero CJ calls, gates re-applied at
 *    read time (config may have changed since admission), ranked by how many
 *    keyword tokens hit, then popularity.
 * 2. Only when the warehouse can't fill the grid, fall back to one live CJ
 *    search (30-day cached) - and the logged shortfall steers the nightly
 *    replenishment toward this keyword.
 */
export async function searchBackfill(
  store: TenantStore,
  cj: CjClient,
  cfg: TenantConfig,
  query: string,
  storeHits: number,
  limit: number,
  opts: { liveFallback?: boolean; exclude?: string[]; llm?: LlmClient; fetchImpl?: typeof fetch; ctx?: { waitUntil(p: Promise<unknown>): void }; buyerCountry?: string; overseas?: boolean } = {}
): Promise<GhostCard[]> {
  const kw = normalizeKeyword(query);
  if (!kw) return [];

  // Local-for-local (2026-07-05): suggestions are drawn ONLY from warehouses
  // local to the buyer - a US shopper searching "dog food" is shown
  // US-warehoused dog food, a GB shopper GB stock. The theme passes the
  // storefront localization country; absent (older cached theme JS), the home
  // market's GB is assumed. A buyer with no local warehouse gets no supplier
  // suggestions at all - never a slow-boat ghost card.
  const locals = localWarehousesFor(opts.buyerCountry ?? 'GB');
  if (!locals.length) return [];

  // Query expansion (skipped entirely in strict mode - expansion must never
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
  // Origin evidence is required, not optional: a pool row without a proven
  // local warehouse for THIS buyer never becomes a suggestion (CN-era rows
  // carry no local origins and drop out here).
  // Every spelling of a folded family ("trackable" also finds "GPS" rows); the
  // query's own words go first because searchWarehouse keeps the first six.
  const rows = await store.searchWarehouse([...new Set([...tokens, ...familyWords(kw)])], limit * 3);
  const ranked = rows
    .filter((r) => warehousePasses(r, cfg, expanded))
    .filter((r) => {
      try { return bestLocalQty((JSON.parse(r.detail) as { origins?: Record<string, number> }).origins, locals) > 0; }
      catch { return false; }
    })
    .map((r) => ({ r, hits: tokens.filter((t) => r.search_text.includes(t)).length }))
    .sort((a, b) => b.hits - a.hits || b.r.listed_num - a.r.listed_num);

  const whLinks = await store.getLinks(ranked.map((x) => x.r.cj_pid));
  for (const { r } of ranked) {
    if (cards.length >= limit) break;
    if (seen.has(r.cj_pid)) continue;
    const link = whLinks.get(r.cj_pid);
    const imported = link?.state === 'imported' && link.handle;
    // Freight is baked into the sticker (pricing rule, 2026-07-03) - price the
    // ghost card with the stored freight so the preview matches the eventual PDP.
    let freightUsd = 0;
    try { freightUsd = (JSON.parse(r.detail) as { freightUsd?: number }).freightUsd ?? 0; } catch { /* legacy row */ }
    // Profitability gate on GHOST cards only (2026-07-31). An `imported` card is
    // a live catalog product and must NEVER be re-judged here - once a product
    // is in inventory the profitability agent leaves it alone, which is the
    // whole point of the repositioning. Only not-yet-imported suggestions are
    // gated, and only on the deterministic no-network check.
    if (!imported && !ghostCardClearsFloor({ sellPriceUsd: r.price_usd }, cfg, freightUsd)) continue;
    cards.push({
      pid: r.cj_pid,
      title: r.title,
      image: firstImage(r),
      price: retailPriceGbp(r.price_usd, cfg.pricing, freightUsd),
      state: imported ? 'imported' : 'ghost',
      url: imported ? `/products/${link!.handle}` : null,
      delivery: { overseas: false, days: null }
    });
    seen.add(r.cj_pid);
  }

  // --- 2) live CJ fallback (cached per keyword for 30 days) ---
  if (cards.length < limit && (opts.liveFallback ?? true)) {
    let items: CjSearchItem[];
    // kw3: cache namespace, keyed by the buyer's local warehouse - bumped from
    // kw2: (unfiltered global results) so the local-for-local filter takes
    // effect immediately instead of serving stale CN-era entries for up to
    // CACHE_TTL_DAYS. CJ does the warehouse filtering server-side.
    const home = locals[0];
    const cached = await store.getSearchCache(`kw3:${home}:${kw}`);
    if (cached) {
      items = JSON.parse(cached);
    } else {
      items = await cj.searchByWarehouse(kw, home);
      await store.putSearchCache(`kw3:${home}:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
    }
    // Live-CJ PET FLOOR: CJ keyword search returns human/baby/car products too (a bare
    // "shampoo" surfaces human shampoo). Require an explicit pet signal on the raw CJ
    // title. Species queries ("dog shampoo") are already gated by storefrontLivePasses; the
    // floor earns its keep on bare terms like "shampoo"/"brush"/"nail clipper".
    const gated = items.filter((i) => !seen.has(i.pid) && storefrontLivePasses(i, cfg.gates, kw) && categoryAdmitsLiveCj(i.topCategory) && isPetProductStrict(i.nameEn));
    // Observe the category gate's recall cost: items the title floor WOULD have
    // admitted (pet token present) but the top-category hard-drop removed. On a
    // precision-first feed these should be rare and genuinely non-pet - a pet-token
    // title surfacing here means a marker is too aggressive, so tune
    // HARD_DROP_TOP_CATEGORIES. Logged only when nonzero (silent on the common case).
    const categoryDropped = items.filter((i) =>
      !seen.has(i.pid) && storefrontLivePasses(i, cfg.gates, kw) && isPetProductStrict(i.nameEn) && !categoryAdmitsLiveCj(i.topCategory)
    );
    if (categoryDropped.length) {
      console.log(`search.categoryGate.dropped kw=${JSON.stringify(kw)} n=${categoryDropped.length} tops=${JSON.stringify([...new Set(categoryDropped.map((i) => i.topCategory))])}`);
    }
    const links = await store.getLinks(gated.map((i) => i.pid));
    for (const item of gated) {
      if (cards.length >= limit) break;
      const link = links.get(item.pid);
      const imported = link?.state === 'imported' && link.handle;
      // Ghost cards only - see the note on the warehouse loop above. A live
      // catalog product surfacing here is never re-judged. Freight is unknown on
      // the raw live feed, so this check is slightly optimistic; the full
      // judgment still runs at import if the shopper clicks.
      if (!imported && !ghostCardClearsFloor({ sellPriceUsd: item.sellPriceUsd }, cfg)) continue;
      cards.push({
        pid: item.pid,
        title: item.nameEn,
        image: item.image,
        price: retailPriceGbp(item.sellPriceUsd, cfg.pricing),
        state: imported ? 'imported' : 'ghost', // archived/failed re-offer as ghost: demand revives
        url: imported ? `/products/${link!.handle}` : null,
        delivery: { overseas: false, days: null }
      });
      seen.add(item.pid);
    }
  }

  // --- 3) overseas supplement (owner choice 2026-09-30) ---
  // Only when the theme asked (overseas=1, sent once it renders the "ships from
  // overseas" note), only for a lane that may use the China hub, and only with a
  // fresh China route to this buyer: the band is the product page's own formula.
  const buyer = (opts.buyerCountry ?? 'GB').toUpperCase();
  if (opts.overseas && cards.length < limit && (opts.liveFallback ?? true) && inquiryWarehouses(buyer).includes('CN')) {
    const l = resolveLogistics(cfg.fulfil);
    const days = formatBand(doorToDoorBand(await store.getLogisticsRoute('CN', buyer, l.stalenessHours), l));
    // Freight is most of a China item's landed cost. The store price is set on
    // the CN -> GB quote at import, so the card uses that row's freight to match
    // the preview and the product page (null row -> product cost only, as before).
    const freightUsd = (await store.getLogisticsRoute('CN', 'GB', l.stalenessHours))?.freight_cost_usd ?? undefined;
    if (days) {
      let items: CjSearchItem[];
      const cached = await store.getSearchCache(`kw3:CN:${kw}`);
      if (cached) {
        items = JSON.parse(cached);
      } else {
        items = await cj.searchByWarehouse(kw, 'CN');
        await store.putSearchCache(`kw3:CN:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
      }
      const gated = items.filter((i) => !seen.has(i.pid) && storefrontLivePasses(i, cfg.gates, kw) && categoryAdmitsLiveCj(i.topCategory) && isPetProductStrict(i.nameEn));
      const links = await store.getLinks(gated.map((i) => i.pid));
      for (const item of gated) {
        if (cards.length >= limit) break;
        const link = links.get(item.pid);
        const imported = link?.state === 'imported' && link.handle;
        if (!imported && !ghostCardClearsFloor({ sellPriceUsd: item.sellPriceUsd }, cfg, freightUsd)) continue;
        cards.push({
          pid: item.pid, title: item.nameEn, image: item.image,
          price: retailPriceGbp(item.sellPriceUsd, cfg.pricing, freightUsd),
          state: imported ? 'imported' : 'ghost',
          url: imported ? `/products/${link!.handle}` : null,
          delivery: { overseas: true, days },
        });
        seen.add(item.pid);
      }
    }
  }

  // Swap CJ's raw thumbnail for the vision-vetted hero when we have one cached
  // (populated when a product is previewed or imported). This is what makes a
  // "cat on a dog listing" card self-heal - the grid shows the congruent image.
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
