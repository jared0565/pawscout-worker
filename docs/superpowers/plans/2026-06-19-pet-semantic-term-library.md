# Pet Semantic Term Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A shared, pet-scoped `term → related terms` library (per collection), web-seeded from autocomplete + LLM-cleaned, cached in D1, read by on-site search and CJ sourcing.

**Architecture:** New `src/semantic/library.ts` engine over a new `semantic_terms` D1 table (via `TenantStore` methods). Hybrid population: a cron batch precomputes collection cores + a collection-agnostic set; on-site search lazy-fills misses in the background. Two pet-safety layers: an LLM-clean prompt + the existing `isPetProductStrict` backstop. Gated by a new `TenantConfig.semantic` config; `more-to-love` excluded.

**Tech Stack:** Cloudflare Worker (Hono), TypeScript, D1 (new migration 0012 + `TenantStore`), OpenRouter via `LlmClient`, Google/DDG autocomplete endpoints, vitest + `@cloudflare/vitest-pool-workers`.

## Global Constraints

- **Source spec (authority):** `docs/superpowers/specs/2026-06-19-pet-semantic-term-library-design.md`.
- **Pet-safety is mandatory:** every stored expansion passes BOTH the LLM-clean prompt AND `isPetProductStrict` (`src/proxy/search.ts:81`). No term lacking a pet token is stored.
- **`more-to-love` excluded** (and any `semantic.excludeCollections`); `semantic.enabled=false` → hard no-op (no network, no LLM).
- **Never block a request:** `getExpansions` reads cache only; web-fetch + LLM happen in the background (`ctx.waitUntil`) or the cron batch. All network/LLM failures are swallowed → `[]`.
- **Per-shop** (every table is `shop`-scoped, like the rest of `TenantStore`).
- New migrations auto-apply in tests via `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`. Run focused vitest batches; `npx tsc --noEmit` stays clean.

---

## File Structure

- **Create** `migrations/0012_semantic_terms.sql` — the table.
- **Modify** `src/tenant-store.ts` — `getSemanticExpansions`, `upsertSemanticTerm`, `listSemanticTermsForCollection`.
- **Modify** `src/types.ts` — `SemanticConfig` + `DEFAULT_SEMANTIC` + add to `TenantConfig` + `getConfig` merge.
- **Modify** `src/validate.ts` — `validateSemanticPayload`.
- **Create** `src/semantic/library.ts` — `fetchSuggest`, `cleanToPetTerms`, `seedTerm`, `getExpansions`.
- **Modify** `src/jobs.ts` — cron seeding batch + wire expansions into `replenishWarehouse`.
- **Modify** `src/proxy/search.ts` — wire expansions into the on-site search path.
- **Tests:** `tests/semantic-store.test.ts`, `tests/semantic-library.test.ts`, `tests/validate-semantic.test.ts`.

---

## Task 1: Migration + TenantStore methods

**Files:** Create `migrations/0012_semantic_terms.sql`; Modify `src/tenant-store.ts`; Test `tests/semantic-store.test.ts`.

**Interfaces (produced):**
- `getSemanticExpansions(collection: string, term: string): Promise<{ expansions: string[]; updatedAt: string } | null>`
- `upsertSemanticTerm(collection: string, term: string, expansions: string[], source: string): Promise<void>`
- `listSemanticTermsForCollection(collection: string): Promise<{ term: string; updatedAt: string }[]>`

- [ ] **Step 1 — migration:**
```sql
CREATE TABLE IF NOT EXISTS semantic_terms (
  shop            TEXT NOT NULL,
  collection      TEXT NOT NULL,
  term            TEXT NOT NULL,
  expansions_json TEXT NOT NULL,
  source          TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (shop, collection, term)
);
CREATE INDEX IF NOT EXISTS idx_semantic_terms_shop_coll ON semantic_terms (shop, collection);
```

- [ ] **Step 2 — failing test** (`tests/semantic-store.test.ts`): upsert then read returns the expansions; second upsert overwrites (no dup row); read miss returns null; list returns terms for the collection. Use the existing harness (`applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` in `beforeEach`, `new TenantStore(env.DB, SHOP)`).

- [ ] **Step 3 — implement** (in `src/tenant-store.ts`, mirroring `getSearchCache`/`putSearchCache`):
```ts
async getSemanticExpansions(collection: string, term: string): Promise<{ expansions: string[]; updatedAt: string } | null> {
  const row = await this.db
    .prepare(`SELECT expansions_json, updated_at FROM semantic_terms WHERE shop = ?1 AND collection = ?2 AND term = ?3`)
    .bind(this.shop, collection, term).first<{ expansions_json: string; updated_at: string }>();
  if (!row) return null;
  try { return { expansions: JSON.parse(row.expansions_json), updatedAt: row.updated_at }; }
  catch { return { expansions: [], updatedAt: row.updated_at }; }
}
async upsertSemanticTerm(collection: string, term: string, expansions: string[], source: string): Promise<void> {
  await this.db.prepare(
    `INSERT INTO semantic_terms (shop, collection, term, expansions_json, source, updated_at) VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(shop, collection, term) DO UPDATE SET expansions_json = ?4, source = ?5, updated_at = ?6`
  ).bind(this.shop, collection, term, JSON.stringify(expansions), source, new Date().toISOString()).run();
}
async listSemanticTermsForCollection(collection: string): Promise<{ term: string; updatedAt: string }[]> {
  const r = await this.db.prepare(`SELECT term, updated_at FROM semantic_terms WHERE shop = ?1 AND collection = ?2`).bind(this.shop, collection).all<{ term: string; updated_at: string }>();
  return (r.results ?? []).map((x) => ({ term: x.term, updatedAt: x.updated_at }));
}
```
- [ ] **Step 4** — run `tests/semantic-store.test.ts` + `tsc`; **Step 5** — commit.

---

## Task 2: Config + validation

**Files:** Modify `src/types.ts`, `src/validate.ts`; Test `tests/validate-semantic.test.ts`.

**Interfaces (produced):** `SemanticConfig = { enabled: boolean; maxExpansions: number; ttlDays: number; excludeCollections: string[] }`; `DEFAULT_SEMANTIC`; `TenantConfig.semantic`; `validateSemanticPayload(body): Validation<SemanticConfig>`.

- [ ] **Step 1** — `src/types.ts`: add the interface, `DEFAULT_SEMANTIC = { enabled: true, maxExpansions: 8, ttlDays: 30, excludeCollections: ['more-to-love'] }`, add `semantic: SemanticConfig` to `TenantConfig`, and in `getConfig` add `semantic: { ...DEFAULT_SEMANTIC, ...JSON.parse(row.semantic || '{}') }` — **NOTE:** `semantic` is a NEW column; add it to the `SELECT` and rely on the `'{}'` default. Since `tenant_config` has no `semantic` column yet, add it in migration 0012: `ALTER TABLE tenant_config ADD COLUMN semantic TEXT NOT NULL DEFAULT '{}';`. (Confirm column-add against `getConfig`'s SELECT list — extend it.)
- [ ] **Step 2 — failing test** (`tests/validate-semantic.test.ts`): accepts defaults; rejects `maxExpansions` out of [1,50] and `ttlDays` out of [1,365]; coerces/validates `excludeCollections` to a string array.
- [ ] **Step 3 — implement** `validateSemanticPayload` in `src/validate.ts` (mirror `validateAddonsPayload`: type-check each field, clamp/reject ranges, default missing fields).
- [ ] **Step 4** run tests + tsc; **Step 5** commit.

---

## Task 3: `fetchSuggest` (pet-biased autocomplete)

**Files:** Create `src/semantic/library.ts`; Test `tests/semantic-library.test.ts`.

**Interfaces (produced):** `fetchSuggest(term: string, collection: string, fetchImpl?: typeof fetch): Promise<string[]>` — pet-biased, deduped raw phrases; never throws.

- [ ] **Step 1 — failing test:** a mocked `fetchImpl` returning Google shape `["q",["dog shampoo","puppy shampoo"]]` and DDG shape → `fetchSuggest` unions+dedupes; assert the requested URLs include pet-anchored queries (`pet `/`dog `/the collection noun); a throwing `fetchImpl` → `[]`.
- [ ] **Step 2 — implement:**
```ts
const SUGGEST_PREFIXES = ['pet', 'dog', 'cat'];
function collectionNoun(handle: string): string { return (handle || '').replace(/^pet-/, 'pet ').replace(/-/g, ' ').trim(); }
async function suggestOne(q: string, fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) && Array.isArray(data[1]) ? data[1].filter((s: unknown): s is string => typeof s === 'string') : [];
  } catch { return []; }
}
export async function fetchSuggest(term: string, collection: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const noun = collectionNoun(collection);
  const queries = [...SUGGEST_PREFIXES.map((p) => `${p} ${term}`), ...(noun ? [`${noun} ${term}`] : [])];
  const all = (await Promise.all(queries.map((q) => suggestOne(q, fetchImpl)))).flat();
  return [...new Set(all.map((s) => s.toLowerCase().trim()).filter(Boolean))];
}
```
- [ ] **Step 3** run test + tsc; **Step 4** commit.

---

## Task 4: `cleanToPetTerms` (LLM + pet backstop)

**Files:** Modify `src/semantic/library.ts`; Test `tests/semantic-library.test.ts`.

**Interfaces (produced):** `cleanToPetTerms(llm: LlmClient, cfg: TenantConfig, raw: string[], term: string, collection: string): Promise<string[]>`.

- [ ] **Step 1 — failing test:** mocked LLM returns `['dog shampoo','puppy bath','head and shoulders']`; `cleanToPetTerms` keeps the pet ones and the **backstop drops 'head and shoulders'** (no pet token via `isPetProductStrict`); result capped at `cfg.semantic.maxExpansions`, deduped, excludes the seed term itself.
- [ ] **Step 2 — implement:** call `llm.json` with a prompt scoped to "related SEARCH terms for PET products in the `<collection>` collection; drop anything human, medical-claim, brand-specific, or unrelated; return ONLY a JSON array of short lowercase terms". Then `.filter((t) => isPetProductStrict(t))`, dedupe, drop the seed, cap. On `!llm.available` or LLM failure → return the `isPetProductStrict`-filtered raw set (degrade, never throw). Import `isPetProductStrict` from `../proxy/search`.
- [ ] **Step 3** run test + tsc; **Step 4** commit.

---

## Task 5: `getExpansions` + `seedTerm` (cache + lazy-fill)

**Files:** Modify `src/semantic/library.ts`; Test `tests/semantic-library.test.ts`.

**Interfaces (produced):**
- `seedTerm(store, llm, cfg, term, collection, source, fetchImpl?): Promise<string[]>`
- `getExpansions(store, cfg, term, collection, opts?: { llm?; fetchImpl?; ctx?: { waitUntil(p: Promise<unknown>): void } }): Promise<string[]>`

- [ ] **Step 1 — failing test:** excluded collection (`more-to-love`) or `enabled=false` → `[]` with no store/LLM/fetch calls; cache hit returns stored expansions; cache miss returns `[]` and (when `ctx` given) calls `ctx.waitUntil` with a seed promise; `seedTerm` runs fetchSuggest→cleanToPetTerms→`upsertSemanticTerm` and returns the cleaned list.
- [ ] **Step 2 — implement:**
```ts
function excluded(cfg: TenantConfig, collection: string): boolean {
  return !cfg.semantic.enabled || cfg.semantic.excludeCollections.includes(collection);
}
export async function seedTerm(store, llm, cfg, term, collection, source, fetchImpl = fetch): Promise<string[]> {
  if (excluded(cfg, collection)) return [];
  const raw = await fetchSuggest(term, collection, fetchImpl);
  const clean = await cleanToPetTerms(llm, cfg, raw, term, collection);
  await store.upsertSemanticTerm(collection, term.toLowerCase().trim(), clean, source);
  return clean;
}
export async function getExpansions(store, cfg, term, collection, opts = {}): Promise<string[]> {
  if (excluded(cfg, collection)) return [];
  const key = term.toLowerCase().trim();
  const hit = await store.getSemanticExpansions(collection, key);
  if (hit) return hit.expansions; // (stale rows still served; cron refreshes)
  if (opts.ctx && opts.llm) opts.ctx.waitUntil(seedTerm(store, opts.llm, cfg, key, collection, 'lazy', opts.fetchImpl).catch(() => {}));
  return [];
}
```
- [ ] **Step 3** run test + tsc; **Step 4** commit. **(Core complete here — engine is fully testable and inert until Tasks 6-8 wire it.)**

---

## Task 6: Wire CJ sourcing (`replenishWarehouse`)

**Files:** Modify `src/jobs.ts`.
- [ ] In `replenishWarehouse`, where per-collection demand keywords are chosen, union `await getExpansions(store, cfg, keyword, collection)` into the keyword set (bounded by `maxCjCalls`), reusing the existing `search()` + `seenTitleSigs` dedupe so no extra CJ spend beyond the cap. Gated by `cfg.semantic.enabled`. Test: with a seeded library, sourcing a collection also searches the expansion terms (assert via a fake `cj.search` spy); with `enabled=false`, behaviour is unchanged.
- [ ] Run focused sourcing tests + tsc; commit.

## Task 7: Wire on-site search (`searchBackfill`)

**Files:** Modify `src/proxy/search.ts`.
- [ ] Before the keyword match in `searchBackfill`, expand the query with `getExpansions(store, cfg, kw, '', { llm, fetchImpl, ctx })` (collection-agnostic) and union the expansion tokens into the relevance match. The existing pet floor (`isPetProductStrict`) still gates results. Pass `ctx` through for lazy-fill. Test: a seeded expansion widens the matched set; `enabled=false` → identical to today.
- [ ] Run `tests/search.test.ts` + tsc; commit.

## Task 8: Cron seeding batch

**Files:** Modify `src/jobs.ts`.
- [ ] Add a bounded seeding pass to the scheduled job: for each active shop, seed (a) the collection-agnostic `''` set (general pet vocabulary) for on-site search, and (b) per non-excluded collection, the collection noun + its existing `getKeywordMeta` keywords. Refresh rows older than `ttlDays`. Cap terms/run; `log` what was skipped. Test: the batch upserts the expected terms and respects the per-run cap + exclusions.
- [ ] Run tests + tsc; commit.

---

## Self-Review (authoring)

- **Spec coverage:** §3 table → T1; §4 module → T3/T4/T5; §5 web source/bias → T3; §6 two-layer safety → T4; §7 timing (cron + lazy) → T5/T8; §8 consumers → T6/T7; §9 config → T2; §11 tests → each task.
- **Placeholders:** Tasks 6-8 wiring specifies the integration point + approach + test, with exact code finalized when that task reads the surrounding flow (the executor confirms the keyword-selection site in `replenishWarehouse` and the match site in `searchBackfill`).
- **Type consistency:** `getExpansions`/`seedTerm`/store methods share `collection`+`term` string params and `string[]` expansions throughout.
- **Risk:** Tasks 1-5 are inert (nothing calls the engine) → safe to ship/deploy alone. Tasks 6-8 change live search/sourcing → each behind `semantic.enabled` and individually tested before wiring.
