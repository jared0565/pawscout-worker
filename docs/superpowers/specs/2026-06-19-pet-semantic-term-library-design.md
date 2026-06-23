# Pet Semantic Term Library - Design

**Date:** 2026-06-19
**Repo:** `pawscout-worker` (new `src/semantic/` module, one D1 migration, hooks into search + sourcing + cron + config). No theme changes.

---

## 1. Goal

A shared, pet-scoped library mapping a **term → related terms**, scoped **per collection**, populated by **web autocomplete + an LLM-clean pass**, cached in **D1**, and read instantly by **two consumers**:

1. **On-site search** - expand a shopper's query to surface more relevant products (the "show more options / fewer lost sales" goal).
2. **CJ sourcing** - expand the keywords PawScout sends to CJ so it pulls **pet** products (e.g. `pet shampoo`, `dog bath`), never human/unrelated items.

The library is **one shared store** feeding both. `more-to-love` is excluded.

## 2. Current state (what we build on)

- **Keyword metadata seed:** `getKeywordMeta` / `classifyKeyword` / `keywordMetaKey` in `src/llm.ts` already LLM-classify a keyword and cache the result in `search_cache` (per-shop, TTL). The semantic library extends this idea with a dedicated store + web seeding.
- **Pet floor:** `isPetProductStrict` + `PET_TOKENS` in `src/proxy/search.ts` already drop non-pet products (human shampoo) from the live supplier feed. The library reuses this as a mechanical backstop on expansions.
- **CJ sourcing:** `replenishWarehouse` (`src/jobs.ts:259`) sources per-keyword, caching raw CJ results under `kw:<keyword>` in `search_cache`.
- **Cron:** the worker already runs scheduled jobs in `src/jobs.ts`; the seeding batch hooks here.
- **Collections:** `pet-cleaning`, `pet-accessories`, `pet-health`, `pet-toys`, `more-to-love` (the last excluded).
- **LLM access:** `LlmClient.json(...)` in `src/llm.ts`. **Config:** `TenantConfig` in `src/types.ts`. **Cache helpers:** `TenantStore.getSearchCache/putSearchCache`. **Migrations:** latest is `0011`; this adds `0012`.

## 3. Data model

New migration `migrations/0012_semantic_terms.sql`:

```sql
CREATE TABLE IF NOT EXISTS semantic_terms (
  shop          TEXT NOT NULL,
  collection    TEXT NOT NULL,   -- collection handle; '' for collection-agnostic terms
  term          TEXT NOT NULL,   -- normalized lowercase seed term
  expansions_json TEXT NOT NULL, -- JSON string[] of pet-clean related terms
  source        TEXT NOT NULL,   -- 'suggest' | 'lazy' | 'manual'
  updated_at    TEXT NOT NULL,   -- ISO8601
  PRIMARY KEY (shop, collection, term)
);
CREATE INDEX IF NOT EXISTS idx_semantic_terms_shop_coll ON semantic_terms (shop, collection);
```

Per-shop (multi-tenant, like every other table). Enumerable by `(shop, collection)` for batch refresh; `(shop, collection, term)` primary key gives O(1) lookup and natural upsert for lazy-fill dedup.

## 4. Module: `src/semantic/library.ts`

```ts
// Read pet-clean expansions for a term within a collection. Instant cache read.
// On a miss returns [] and (if ctx given) schedules a background lazy-fill.
getExpansions(store, term, collection, opts?: { llm; fetchImpl; ctx }): Promise<string[]>

// Fetch suggestions → LLM-clean → upsert into semantic_terms. Returns the stored expansions.
seedTerm(store, llm, fetchImpl, term, collection, source): Promise<string[]>

// Call the autocomplete endpoint(s) with pet-biased queries; parse + dedupe raw phrases.
fetchSuggest(term, collection, fetchImpl): Promise<string[]>

// LLM filters/normalizes raw phrases to pet-relevant related terms for the collection.
cleanToPetTerms(llm, raw, term, collection): Promise<string[]>
```

- **Normalization:** `term` is lowercased + trimmed before lookup/store; expansions are lowercased, deduped, capped at `semantic.maxExpansions`.
- **Staleness:** a row older than the TTL (config; default 30 days) is treated as a miss by `getExpansions` (triggers refresh) but its stale value is still returned in the meantime (never block on the network).
- **Excluded collections:** `getExpansions`/`seedTerm` early-return `[]` when `collection ∈ semantic.excludeCollections` (default `['more-to-love']`) or when `semantic.enabled === false`.

## 5. Web source + pet-biasing (the "can't just search shampoo" fix)

- **Endpoints (no API key):** Google `https://suggestqueries.google.com/complete/search?client=firefox&q=<q>` (returns `[query, [suggestions…]]`); DuckDuckGo `https://duckduckgo.com/ac/?q=<q>&type=list` as fallback.
- **Pet-bias the query before fetching:** `fetchSuggest` does not query the bare term. It queries pet-anchored variants - `"pet <term>"`, `"dog <term>"`, `"cat <term>"`, and `"<collectionNoun> <term>"` (collection noun derived from the handle, e.g. `pet-health → pet health`) - and unions the suggestions. This biases the raw set toward the pet domain so "shampoo" yields "dog shampoo / puppy shampoo / pet flea shampoo", not human shampoo.
- All network failures are swallowed → empty raw set → no expansion (never throws, never blocks).

## 6. Pet-safety - two layers

1. **LLM-clean (`cleanToPetTerms`):** prompt scoped to "related search terms for **pet** products in the `<collection>` collection; drop anything human, medical-claim, brand-specific, or unrelated; return ONLY a JSON array of short terms." Uses the collection as context.
2. **Mechanical backstop:** every cleaned term is re-checked with `isPetProductStrict` (reused from `src/proxy/search.ts`); a term that contains no pet token is dropped. This guarantees the human-shampoo class can never enter the library even if the LLM slips.

## 7. When it runs (hybrid)

- **Scheduled batch** (extends the cron in `src/jobs.ts`): for each active shop it seeds (a) a **collection-agnostic** set under `collection=''` - general pet vocabulary used by global on-site search - and (b) **per non-excluded collection** a **core term set** = the collection noun + the collection's existing `getKeywordMeta` keywords (and the collection-mapped tags), used by CJ sourcing. Refresh entries past TTL. Bounded per run (cap defined in the plan) to keep autocomplete+LLM cost predictable; logs what it skipped.
- **Lazy-fill:** when `getExpansions` misses on an on-site search, it schedules `seedTerm(..., 'lazy')` via `ctx.waitUntil` (background); the current request proceeds with no expansion, the next identical search benefits.

## 8. Consumers

- **On-site search** (`src/proxy/search.ts`, the Stage 1 suggested-cards token match + the live-CJ keyword path): before matching, expand the shopper's query token set with `getExpansions(store, query, '', {ctx})` - collection-agnostic, since a storefront search is global (pass the active collection handle instead only if the search is ever scoped to a collection page). Expanded tokens widen the relevance match; the existing pet floor still gates results.
- **CJ sourcing** (`replenishWarehouse`, `src/jobs.ts:259`): for each sourcing keyword, union `getExpansions(store, keyword, collection)` into the CJ search keywords so CJ returns pet-correct candidates. The existing `kw:` cache and pet floor are unchanged downstream.

## 9. Config (`TenantConfig.semantic`, new)

```ts
semantic: {
  enabled: boolean;            // default true
  maxExpansions: number;       // default 8
  ttlDays: number;             // default 30
  excludeCollections: string[];// default ['more-to-love']
}
```

`DEFAULT_SEMANTIC` in `src/types.ts`; `validateSemanticPayload` in `src/validate.ts` (shape/range checks, like the other validators); a console card to toggle/tune (optional follow-up - not required for the engine to work). Merged in `getConfig` like `addons`/`inbox`.

## 10. Error handling / resilience

- Autocomplete unreachable or malformed → empty raw → no expansion. Never throws.
- LLM unavailable/`enabled=false` → no expansion (search + sourcing behave exactly as today).
- Stale row → served immediately, refreshed in the background.
- `more-to-love` / disabled → hard early-return, no network, no LLM.

## 11. Testing

Worker unit tests (`tests/`):
1. `fetchSuggest` parses a **mocked** Google `[q,[...]]` and DDG `ac/` payload; unions + dedupes; pet-biases the query (assert the URLs requested contain `pet `/`dog `/the collection noun).
2. `cleanToPetTerms` with a mocked LLM keeps pet terms, and the **mechanical backstop drops a human term** the LLM mistakenly returned (e.g. injects "head and shoulders" → dropped by `isPetProductStrict`).
3. `getExpansions` cache hit returns stored expansions; miss returns `[]` and schedules a fill; excluded collection / `enabled=false` returns `[]` with no network.
4. `seedTerm` upserts (second call for the same term overwrites, no duplicate row).
5. `validateSemanticPayload` accepts defaults, rejects out-of-range `maxExpansions`/`ttlDays`.

## 12. Out of scope (YAGNI)

- Learning from on-site search logs / click-through (a future source; the schema's `source` column leaves room, but no log-mining now).
- A full console UI beyond a simple enable/tune card (the engine works headless on defaults).
- Cross-shop shared global library (kept per-shop, consistent with every other table).
- Paid search APIs (autocomplete is free and sufficient).
- Multi-language expansion (UK-English only, matching the store).
