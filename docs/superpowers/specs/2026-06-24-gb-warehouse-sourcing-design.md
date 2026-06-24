# GB-Warehouse Sourcing Pass - Design Spec

**Date:** 2026-06-24
**Status:** Approved design, ready for implementation plan (Phase 1)
**Author:** brainstormed with the owner (superpowers:brainstorming)

## Goal

Add CJ **GB-warehoused** pet products to the Active Paw catalog so the store has UK-near inventory that ships to UK customers in days, not weeks - the prerequisite supply that makes geo-aware merchandising worth building.

## Background: why this exists (the supply-first pivot)

This work originated from a geo-aware merchandising idea: detect a visitor's location and surface the products whose warehouse is nearest them (fastest/cheapest shipping), on both browse and search. Investigation showed that feature is **blocked on supply, not code**:

- **Live catalog origins** (remote D1 `warehouse_products.detail.origins`, status=available): **CN 126 products, US 8, EU/UK 0.** The primary market is the UK, so a silent geo re-rank would be invisible to UK visitors - there is no UK-near stock to surface.
- The geo-ranking feature was therefore paused mid-brainstorm (no spec written yet), pending this sourcing work that unblocks it.

**Verified at CJ source (2026-06-24, the standing "verify supplier capability at source" rule):**

- CJ DOES stock GB/DE warehouses. `/product/list?countryCode=<CC>` totals: GB **10,457**, DE **13,068**, US 59,228, CN 1.33M, FR/ES/PL negligible. Narrowed to pet terms: GB+`dog` ~356, GB+`pet` ~318, DE+`dog` ~50.
- **Why the catalog has none:** a plain keyword `listV2` sample (how the importer discovers stock) returned 23 CN / 1 US / 0 GB. GB stock is invisible to keyword search; it surfaces only via the `countryCode=GB` warehouse filter, which no current discovery path uses.
- **Delivery payoff:** a GB-warehoused product GB->GB quotes **2-8 days** (Royal Mail / Evri / Yodel, $0 freight); CN->GB returns 0 options for those SKUs. Versus the catalog's current CN->UK representative of ~6-21 days.
- **Sizing vs live gates** (`priceMin 0.5 / priceMax 80 USD`, `popularityFloor 0`, `stockFloor 10`, pricing x2.7 / fx 0.78+2% / £6 min-margin): 12 pet keywords x `countryCode=GB` -> 199 unique candidates -> 198 pass price -> 92 pass strict pet-token -> 92 fresh (0 dedup collisions) -> sampled 30, 26 had GB stock >= 10 (**87%**) -> **~80 mechanically importable**. Retail GBP min 12.99 / median 31.99 / max 62.99; gross margin ~£10-37/unit. **Caveat:** ~80 is mechanical-gate only; the probe did not run the LLM `curateProduct` gate and the strict token gate leaks non-pet items (an air purifier, a handheld vacuum, a car-boot liner slipped through). Realistic on-brand count after LLM curation ~40-60 - dozens across all five collections, enough for geo-ranking to matter.

Full evidence: memory `cj-eu-uk-warehouse-sourcing.md`.

## Locked decisions

1. **Shape:** both a one-off curated batch now AND an ongoing cron bias (owner chose "both").
2. **Control:** the one-off seed imports as **drafts for owner review**; the ongoing cron trickle **auto-publishes** (like `refillCollections` does today).
3. **Seed size:** everything that clears curation (~40-60), balanced across all five collections.
4. **Architecture:** worker-native (Approach 1). The Python path is rejected because it lacks the worker's `curateProduct` LLM gate - exactly what keeps the air-purifier-type junk out.
5. **Phasing (from reading the code):** Phase 1 (seed) is fully designed and built now; Phase 2 (cron bias) is designed here but **gated on explicit approval** because it changes the live, auto-publishing catalog.

## Governing constraints (project-wide; every task inherits these)

- **No-UK-fulfilment claim:** never say or imply Active Paw ships/dispatches from the UK as a blanket claim. GB stock unlocks a *real per-SKU* fast-UK-delivery story, allowed only for verified GB-warehoused SKUs, never blanket. Origin data is internal; delivery times may be given without naming origin. (memory `no-uk-fulfilment-claim`, affiliate ruleset E.11)
- **Customer-facing only real & defensible:** never fabricate; unknown -> safe hedge. (memory `customer-facing-only-real-defensible`)
- **No em/en-dash** anywhere, especially customer-facing. (memory `no-em-dash`)
- **Verify supplier capability at source** for any CJ claim. (memory `verify-supplier-capability-at-source`)
- **Production gating:** `wrangler deploy` and any live run need explicit owner go; `git push` is automatic after commits.
- **Code conventions:** TypeScript + Vitest (`@cloudflare/vitest-pool-workers`); CJ traffic via the egress relay; `page.ts` is a single template literal (avoid unless needed). Run tests per-file/batched (workerd loopback limit); `tsc --noEmit` clean.

---

## Phase 1: the GB seed (build now)

Adds GB-warehoused pet products to the catalog as owner-reviewed Shopify drafts, reusing the entire existing discovery -> curation -> import chain. The only new import behavior is a DRAFT disposition.

### Component 1 - GB warehouse-filtered discovery (`src/cj.ts`)

New method, purely additive (existing `cj.search`/`searchV2` untouched):

```
cj.searchByWarehouse(keyword: string, countryCode = 'GB', pageSize = 50): Promise<CjSearchItem[]>
  -> GET /product/list?productNameEn=<kw>&countryCode=<CC>&pageNum=1&pageSize=<n>
  -> mapCjSearchItems(data.list)  // same CjSearchItem shape cj.search returns
```

**Deliberate endpoint choice:** `/product/list` is CJ's legacy keyword endpoint - noisier than `listV2` (~50% non-pet in the probe), but acceptable because `curateProduct` is the real niche filter (Component 2). `listV2` warehouse-filtering was not verified to exist; we use the endpoint proven to honor `countryCode`. Recorded so a later reader does not "fix" it.

**Discovery driver:** a per-collection keyword map (adapted from `discover-cj-category-products.py` `CATEGORY_KEYWORDS`), keyed to the five collection handles: `pet-cleaning`, `pet-accessories`, `pet-health`, `pet-toys`, `pet-grooming` (plus `more-to-love`). For each collection's keywords, call `searchByWarehouse(kw, 'GB')`, union, dedupe by `pid`, skip already-linked pids. Each candidate carries its intended collection.

### Component 2 - curate -> DRAFT import (`src/proxy/import.ts`, new seed orchestrator)

**Seed orchestrator** `seedOriginAssortment(store, cj, admin, cfg, { countryCode='GB', perCollection, curate, pickHero })`:

- For each collection's GB keywords -> `cj.searchByWarehouse` -> dedupe pids, skip already-linked.
- For each candidate up to a **per-collection cap** (default ~12, so ~balanced across five collections ~= the sized ~40-60): `cj.detail(pid)` (`enable_inventory` -> `origins` including GB) -> upsert into `warehouse_products` (so the curated detail + GB origins are cached for downstream `chooseOrigin`, inventory sync, and Phase-2 geo-ranking) -> `confirmAndImport(..., { publish: false })`.
- Returns `{ discovered, curated_passed, drafted, rejected }`.

**DRAFT disposition (the one real change to the import path):** thread a `publish` flag (default `true`, so every existing caller is unchanged) through `confirmAndImport` -> `importProduct`. When `false`: set Shopify `status: 'DRAFT'` and skip the Online-Store publish block (`PUBLICATIONS`/`PUBLISH`). The entire gate chain is reused untouched: `curateProduct` (rejects below `cfg.llm.scoreThreshold`), the mechanical pet-relevance floor, image QA (`pickHero`), `chooseOrigin` (-> GB), freight, and the live `stockByPid` check.

**Link state:** seed drafts are recorded in `product_links` with state `draft` (NOT `imported`). `product_links.state` is free-text (`TEXT NOT NULL DEFAULT 'ghost'`, value list is a comment only) - **no migration needed**. Benefits: `countImportedByCategory` excludes drafts (keeps `refillCollections` deficit math honest), and a rejected/deleted draft never leaves a stale `imported` link. A lightweight reconcile flips `draft` -> `imported` once the owner publishes the product (detected as Shopify `status: ACTIVE` on the next inventory sync).

**Trigger:** secret-gated temporary route `POST /api/admin/seed-gb-origin`, gated by a throwaway `MAINT_TOKEN` secret (the pattern used for the prior logistics/inventory force-runs), returning the summary counts. Removed after the run (route + secret), like its predecessors.

### Component 3 - pricing/COGS, dedup, origin correctness

**Pricing/COGS - reused as-is.** `importProduct` prices via `retailPriceGbp(sellPriceUsd, pricing, freightUsd)` and writes COGS via `landedCostGbp(...)`. GB COGS basis = CJ variant `sellPriceUsd` (uniform across warehouses; the warehouse drives freight, not the sticker). **Freight nuance:** `confirmAndImport` runs `chooseOrigin` -> GB then `cj.freightEstimate(vid, 'GB')`, but GB->GB freight is $0 and `freightQuote` drops `priceUsd > 0` options -> returns null -> `freightUsd` undefined -> cost-only floor. Harmless (free freight, £10-37 margins verified). **Refinement:** capture the genuine $0 GB-domestic freight via `freightQuoteAging` (the T20 helper that keeps $0 options) so COGS/affiliate-eligibility read `0`, not unknown.

**Dedup - three rules.** (a) Skip already-linked pids (existing). (b) Add a `titleSignature` dedupe vs existing catalog titles so a GB near-duplicate of a CN listing is not double-listed (matches the sizing probe; cheap; 0 collisions observed). (c) An already-imported CN product that *also* has GB stock is NOT retro-tagged in Phase 1 (rare; deferred to a future reconcile).

**Origin-data correctness (linchpin for Phase 2).** `cj.detail`'s `enable_inventory` -> `collectOrigins` -> `detail.origins` includes GB; the seed caches it in `warehouse_products.detail`, so the worker's `chooseOrigin` and Phase-2 geo-ranking read real GB origins from D1. The Shopify `supplier.*` origin metafield is set for internal use but never surfaced as origin to customers (governance).

### Component 4 - testing

TDD per repo convention; harness `import { env, applyD1Migrations } from 'cloudflare:test'` + `new TenantStore(env.DB, SHOP)`; CJ and `AdminGraphql` injected as fakes. Run per-file/batched; `tsc --noEmit` clean.

1. `cj.searchByWarehouse` - injected fetch asserts `/product/list` with `countryCode` + `productNameEn`, maps to `CjSearchItem[]`, handles empty/error.
2. **DRAFT disposition (critical):** fake admin records ops - `publish:false` -> `productSet` input `status:'DRAFT'` AND publish mutation NOT called; `publish:true` (default) -> `status:'ACTIVE'` AND publish called (regression-guards every existing caller).
3. **Link state:** seed drafts get `draft`; `countImportedByCategory` excludes them; reconcile flips `draft`->`imported` when Shopify status is `ACTIVE`.
4. **`seedOriginAssortment`:** fake CJ returns GB candidates + GB-origin details - asserts per-collection discovery, pid dedup, skip-already-linked, `titleSignature` dedup, per-collection cap, draft-mode import, a non-pet candidate rejected by curation (not drafted), and the summary counts.
5. **Origin caching:** seed upserts `warehouse_products` with `detail.origins` containing GB; `chooseOrigin` returns `'GB'`.
6. **Freight $0:** a GB product with only $0 options yields `freightUsd:0` via `freightQuoteAging`; cost-only pricing; margin intact.
7. **Seed route:** `POST /api/admin/seed-gb-origin` 401s without `MAINT_TOKEN`, runs with it.

### Phase 1 cutover (gated on explicit owner go, in order)

1. `npx wrangler deploy` (ships `searchByWarehouse`, the seed orchestrator + route, the `publish` flag, the reconcile). No migration.
2. Run `POST /api/admin/seed-gb-origin` with the throwaway `MAINT_TOKEN`; read the `{discovered, curated_passed, drafted, rejected}` summary.
3. Owner reviews the ~40-60 GB **drafts** in Shopify admin, publishes the keepers (the existing publish path / `publish-products-online-store.py` flips them to ACTIVE/published; the reconcile flips their link `draft`->`imported`).
4. Remove the temp route + `MAINT_TOKEN` secret; redeploy.

---

## Phase 2: ongoing cron bias (designed; build on explicit approval)

**Why gated:** `refillCollections` only promotes when a collection is *below* floor (`if (deficit <= 0) continue`), and collections sit at the target of 12 - so it promotes nothing once full; and it ranks `warehouseByCategory` by `listed_num`, so a small-pool GB item loses to CN bestsellers even given a deficit. "Maintain GB presence" therefore requires an explicit mechanism that changes what the live, auto-publishing catalog shows. That deserves its own sign-off.

**Design sketch (decisions to settle at greenlight):**

- **Discovery:** add a `searchByWarehouse(kw, 'GB')` pass to `replenishWarehouse` each cycle (curate -> cache), so `warehouse_products` keeps fresh GB candidates. Bounded so the GB pass never dominates the run.
- **Promotion mechanism (the open choice):** maintain a per-collection GB target (e.g. ~3-4 of the 12 slots) by EITHER (a) reserving GB slots in `refillCollections`, OR (b) displacing the weakest non-GB member (lowest `listed_num` / performance) when below the GB target. Auto-publishes (status ACTIVE), like the existing refill. Quality gates still rule; GB is a strong bias, never a takeover, and never exceeds its reserved share.
- **Guardrail:** GB representation tops up toward the target then stops; the far larger, often-better CN selection is never crowded out.

This phase is intentionally left at sketch depth; it gets its own plan and explicit approval after the seed lands and the GB assortment is seen in practice.

---

## Out of scope / downstream

- **Geo-aware merchandising** (the original idea): resumes after GB stock lands. Soft re-rank, auto-detected country via `{{ localization.country.iso_code }}` passed to `/proxy/search` as a signed hint (App Proxy `request.cf` = Shopify server, not the visitor), silent MVP, 12-grid, search first then browse; visible "fastest to you" / destination-aware delivery estimate is its own later phase. (memory `cj-eu-uk-warehouse-sourcing`, `search-page-architecture`)
- **DE warehouse** sourcing: a smaller pool (~50 pet) exists; not in this pass, trivially added later by extending the `countryCode` list.
