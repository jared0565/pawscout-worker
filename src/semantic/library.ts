import type { LlmClient } from '../llm';
import type { TenantStore } from '../tenant-store';
import { DEFAULT_SEMANTIC, type SemanticConfig, type TenantConfig } from '../types';
import { resolveChain } from '../llm-resolve';
import { isPetProductStrict } from '../proxy/search';

// cfg.semantic is optional on the type (getConfig always populates it); read it
// through this guard so a hand-built config behaves as the enabled default.
function semOf(cfg: TenantConfig): SemanticConfig {
  return cfg.semantic ?? DEFAULT_SEMANTIC;
}

// Shared pet semantic term library. A term -> related-terms map, per collection,
// web-seeded from search autocomplete and LLM-cleaned to pet-relevant terms, with
// the existing pet floor as a mechanical backstop. Read by on-site search and CJ
// sourcing. NEVER blocks a request and never throws: misses return [] and (when a
// ctx is supplied) trigger a background lazy-fill.

type Ctx = { waitUntil(p: Promise<unknown>): void };

const SUGGEST_PREFIXES = ['pet', 'dog', 'cat'];

// pet-cleaning -> "pet cleaning", pet-health -> "pet health". '' (agnostic) -> ''.
function collectionNoun(handle: string): string {
  return (handle || '').replace(/^pet-/, 'pet ').replace(/-/g, ' ').trim();
}

function excluded(cfg: TenantConfig, collection: string): boolean {
  const sem = semOf(cfg);
  return !sem.enabled || sem.excludeCollections.includes(collection);
}

// One autocomplete call. Google returns [query, [suggestions...]]; DDG ac/ returns
// the same shape with type=list. Returns [] on any failure (never throws).
async function suggestOne(q: string, fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) && Array.isArray(data[1])
      ? (data[1] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}

// Pet-biased autocomplete: query "pet <term>", "dog <term>", "cat <term>", and
// "<collection noun> <term>" so the raw set skews pet-domain (so "shampoo" yields
// dog/puppy/pet shampoo, not human shampoo). Union + dedupe; never throws.
export async function fetchSuggest(term: string, collection: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const noun = collectionNoun(collection);
  const queries = [...SUGGEST_PREFIXES.map((p) => `${p} ${term}`), ...(noun ? [`${noun} ${term}`] : [])];
  const all = (await Promise.all(queries.map((q) => suggestOne(q, fetchImpl)))).flat();
  return [...new Set(all.map((s) => s.toLowerCase().trim()).filter(Boolean))];
}

// LLM-clean raw autocomplete phrases to pet-relevant related terms for the
// collection, then re-check each against the mechanical pet floor. The seed term
// is dropped, results deduped and capped. Degrades to the pet-floor-filtered raw
// set if the LLM is unavailable; never throws.
export async function cleanToPetTerms(llm: LlmClient, cfg: TenantConfig, raw: string[], term: string, collection: string): Promise<string[]> {
  const seed = term.toLowerCase().trim();
  const cap = semOf(cfg).maxExpansions;
  const petFloor = (terms: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([seed]);
    for (const t of terms) {
      const v = (t || '').toLowerCase().trim();
      if (!v || seen.has(v) || !isPetProductStrict(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= cap) break;
    }
    return out;
  };

  if (!raw.length) return [];
  if (!llm.available) return petFloor(raw);

  const nounCtx = collectionNoun(collection) || 'pet products';
  const chain = resolveChain(cfg, 'text');
  const result = await llm.jsonChain<string[]>({
    chain,
    maxTokens: 200,
    system:
      `You normalize search autocomplete phrases into related SEARCH TERMS for ${nounCtx}. ` +
      'Keep only terms a shopper would use to find a PET product in this category. ' +
      'DROP anything for humans, any medical/health claim, brand names, and anything unrelated to pets. ' +
      'Return ONLY a JSON array of short lowercase terms (no objects, no prose).',
    user: JSON.stringify({ seedTerm: seed, collection: collection || 'general', candidates: raw.slice(0, 40) }),
    validate: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)
  });

  if (!result.ok) return petFloor(raw);
  return petFloor(result.value);
}

// Fetch + clean + store one term. Returns the cleaned expansions. No-op ([]) for
// excluded/disabled collections.
export async function seedTerm(
  store: TenantStore,
  llm: LlmClient,
  cfg: TenantConfig,
  term: string,
  collection: string,
  source: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[]> {
  if (excluded(cfg, collection)) return [];
  const key = term.toLowerCase().trim();
  if (!key) return [];
  const raw = await fetchSuggest(key, collection, fetchImpl);
  const clean = await cleanToPetTerms(llm, cfg, raw, key, collection);
  await store.upsertSemanticTerm(collection, key, clean, source);
  return clean;
}

// Instant cache read for a term within a collection. On a miss returns [] and (if
// ctx + llm given) schedules a background lazy-fill for next time. Stale rows are
// still served immediately (the cron batch refreshes them). Never throws.
export async function getExpansions(
  store: TenantStore,
  cfg: TenantConfig,
  term: string,
  collection: string,
  opts: { llm?: LlmClient; fetchImpl?: typeof fetch; ctx?: Ctx } = {}
): Promise<string[]> {
  if (excluded(cfg, collection)) return [];
  const key = term.toLowerCase().trim();
  if (!key) return [];
  const hit = await store.getSemanticExpansions(collection, key);
  if (hit) return hit.expansions;
  if (opts.ctx && opts.llm) {
    const llm = opts.llm;
    opts.ctx.waitUntil(seedTerm(store, llm, cfg, key, collection, 'lazy', opts.fetchImpl).catch(() => {}));
  }
  return [];
}
