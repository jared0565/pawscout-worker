# PawScout Warehouse Evolution — W1–W4 Implementation Plan

> **Purpose of this document**: a self-sufficient implementation plan. If work is
> interrupted or handed to another developer, reading this file plus the README
> is enough to continue. Keep it updated: tick checkboxes as tasks land, and
> append to the Decision Log when anything is decided differently.
>
> Last updated: 2026-06-12 (W1+W2+W3 complete — deploy: migrate:remote applies 0005, deploy, and set OPENROUTER_API_KEY secret) · Working branch (both repos): `claude/stoic-pasteur-a2ol7z`

---

## 1. State snapshot (as of last update)

**Already built, tested, and deployed to production** (see README for details):

- Embedded Shopify app: dual install paths, envelope-encrypted vault (KEK→DEK),
  merchant console, uninstall crypto-shredding.
- Search flywheel v1: App Proxy (`/proxy/*`), search backfill with ghost cards,
  preview modal + import-on-click, view/ATC beacons, daily cron
  (cache purge / 30-day cull / capped refill), pricing engine
  (2.5× → ~17% net), CJ client with cached token.
- Theme half (`active-paw-theme`): `assets/pawscout.js`, search/product/layout wiring.
- Production: worker deployed, migrations 0001+0002 applied, tenant
  `4qkudm-ez.myshopify.com` active. App Proxy configured
  (`apps/pawscout` → `https://pawscout.activepaw.co.uk/proxy`).

**Open items predating W1:**

- [x] CJ key re-entered after the DEK-reuse fix (2026-06-11 23:15Z, validated;
      CJ token minted and cached, expires 2026-12-08).
- [x] CJ egress relay deployed (2026-06-12; see Production identifiers) and
      worker secrets `CJ_RELAY_URL` + `CJ_RELAY_TOKEN` set.
- [x] End-to-end verified 2026-06-12: search returns `{"ok":true,...}` through
      proxy → worker → vault → relay → CJ.
- [x] Live shop popularityFloor set to 1 (2026-06-12, via D1).
      Console Save-gates path VERIFIED working end-to-end 2026-06-13
      01:07Z (user saved relevance=strict via the console; confirmed in
      tenant_config).
- [x] **Flywheel verified end-to-end 2026-06-12**: 8 gated, priced ghost
      products returned from cache. Pre-W1 checklist CLOSED.
- [x] Theme MERGED to `shopify-deploy` 2026-06-12 (5e8952d → 9f47311) — ghost
      cards, preview modal, and beacons are live to visitors.

**Collection-tag rename (2026-06-14):** the `cj-cat-*` prefix was misleading
(reads as "cat" the animal, not "category"). Renamed to `cj-pet-*` across the
collection map (`cj-pet-cleaning`, `cj-pet-accessories`, `cj-pet-health`,
`cj-pet-toys`, `cj-pet-grooming`, `cj-pet-more-to-love`). The LLM species tag —
formerly `cj-pet-{class}` — moved to `cj-species-{class}` to keep the two
namespaces distinct. Production re-tag done in a safe order: add new tags to all
products → switch the 6 smart-collection rules → remove old tags → update
`tenant_config.collection_map`, so no product ever drops out of a collection
mid-migration. Older "cj-cat" mentions below are historical.

**Store state changes (2026-06-12, via Shopify MCP):**

- Checkout/payments DISABLED by the user until the pricing strategy is final —
  re-enable before any ad spend. Views/ATC signals unaffected.
- New smart collection **Pet Grooming** (`pet-grooming`, tag
  `cj-pet-grooming`), added to the PawScout collection map; 11 existing
  grooming products tagged into it; 5 grooming demand keywords seeded into
  search_log (sourced from wowgrooming.co.uk's range).
- One-time catalog retitle: 27 products with CJ keyword-soup titles (60-170
  chars) rewritten to <=55-char UK-English titles. Handles/URLs unchanged.
- RESOLVED: 36 of the 42 legacy products (those carrying cj-pid tags) were
  ADOPTED into product_links (state=imported, category from their cj-cat tag,
  2026-06-12) — they now count toward floors/targets, get stock+price synced
  nightly, and enter the cull lifecycle (30-day grace from adoption). The
  6 without cj-pid tags have no CJ identity and stay outside PawScout
  (manual pricing/stock; consider archiving or tagging them manually).
- Price sync added to the nightly job: retail = retailPriceGbp(CJ current
  cost) for every SKU-matched variant. Legacy prices (which predate the
  pricing engine — none end in .99) realign on the first post-deploy run.
- Contact form: Shopify-native {% form 'contact' %} → emails
  contact@activepaw.co.uk (mailbox confirmed set up by the user). Theme
  mailto links aligned from support@ → contact@ (live 2026-06-12).
  USER ACTION still open: enable captcha at Online Store → Preferences →
  "Enable reCAPTCHA on contact and comment forms". Optional later: Shopify
  Inbox app for an in-admin message inbox.
- Social share row shipped to the PDP (FB / X / Pinterest / WhatsApp / copy
  link; no third-party scripts) — live on shopify-deploy 2026-06-12.

**Production identifiers:**

| What | Value |
|---|---|
| Worker | `pawscout-worker` on Cloudflare, custom domain `pawscout.activepaw.co.uk` |
| D1 database | `pawscout`, id `85f80862-0b26-4515-82b6-3408124e3a59` |
| Shop | `4qkudm-ez.myshopify.com` (storefront `activepaw.co.uk`) |
| CJ egress relay | `pawscout-relay` on Fly.io (org `fb-mac`, region `lhr`), `https://pawscout-relay.fly.dev`, static egress IP `209.71.82.110` ($3.60/mo) |
| Worker secrets | `SHOPIFY_API_SECRET`, `PAWSCOUT_MASTER_KEY`, `CJ_RELAY_URL`, `CJ_RELAY_TOKEN` (+ `OPENROUTER_API_KEY` from W3) |
| Relay secret | `RELAY_TOKEN` (Fly secret; must equal the worker's `CJ_RELAY_TOKEN`) |
| Cron | `17 4 * * *` UTC daily |

## 2. Target architecture (what W1–W4 adds)

```
                       ┌────────────────────────────────────────────┐
 Storefront search ──→ │ PS WAREHOUSE (D1): ≥20 gated, in-stock,    │ ←─ nightly
 (app proxy)           │ fully-detailed products per category       │    replenish
                       │ — CJ is OUT of the request path —          │    from CJ
 ghost click ────────→ │ instant preview from warehouse row;        │    (paced)
                       │ ONE live CJ stock/price confirm at import  │
                       └────────────────────────────────────────────┘
                                   │ promote (floor 8/cat)
                                   ▼
                       Shopify store catalog (target 12/cat)
                       tracked inventory ("deny") + supplier.* metafields
                                   │ beacons: view / atc
                                   ▼
                       Demand signals (search_log, product_events)
                                   │
                       LLM layer (OpenRouter): admission scoring,
                       copy rewriting, keyword classification, digest
```

Key invariants (do not violate):

1. **Quality outranks quotas.** Floors (20 warehouse / 8 store) are goals the
   crons work toward; gates and `stockFloor` are never bypassed to hit a number.
   Shortfalls are surfaced in the console, not papered over.
2. **CJ stays out of the visitor request path** (single exception: the async
   import-time stock/price confirmation).
3. **Only `tenant-store.ts` touches D1** (guard test enforces).
4. **`/proxy/*` always answers HTTP 200 + `ok` flag** (Shopify masks non-2xx).
5. **Archive, never delete** Shopify products; revive instead of duplicate.
6. **LLM calls are background-only** (admission/cron time), never in the hot path.

## 3. Decision log

| Decision | Value | Rationale |
|---|---|---|
| Net margin target | 17% (multiplier 2.5×, floor 2.2×, min £6) | researched cost stack @ ROAS 3 |
| Grid display cap / store target | 12 per category | avoid overwhelming listings |
| Store floor (W2) | 8 per category | user decision 2026-06-12 |
| Warehouse depth (W1) | ≥20 per category | user decision 2026-06-12 |
| Stock floor | CJ stock ≥ 10 units | buffer for shared CJ inventory + 24h sync staleness |
| LLM provider (W3) | **OpenRouter** (`OPENROUTER_API_KEY` secret) | model flexibility, cost-vs-quality testing |
| Default LLM model | `anthropic/claude-haiku-4.5` via OpenRouter, per-task override in config | cheap default, swappable |
| CJ cadence | all CJ work in paced background jobs, 1.1s gap | free tier = 1 req/s; auth 1/300s |
| popularityFloor default | **1** (was 50) | measured CJ data 2026-06-12: listedNum is small-valued (max 5 in a 40-item sample); LLM curation (W3) is the real quality gate |
| Retention | warehouse/cache rows 30 days unused; logs 90 days | PS storage promise |

---

## 4. Phase W1 — Warehouse core

**Goal:** searches and previews served entirely from PS-local data.

### W1.1 Migration `0003_warehouse.sql`
- [x] New table:
```sql
CREATE TABLE warehouse_products (
  shop         TEXT NOT NULL,
  cj_pid       TEXT NOT NULL,
  category     TEXT,              -- collection key or NULL (keyword-driven)
  title        TEXT NOT NULL,     -- normalized (W3 may rewrite)
  detail       TEXT NOT NULL,     -- full normalized CjDetail JSON
  price_usd    REAL NOT NULL,     -- lowest variant landed cost
  listed_num   INTEGER NOT NULL,
  stock        INTEGER NOT NULL,  -- last known CJ stock (min across variants)
  search_text  TEXT NOT NULL,     -- lowercase title+category for matching
  status       TEXT NOT NULL DEFAULT 'available', -- available|low_stock|stale
  fetched_at   TEXT NOT NULL,     -- last full detail fetch
  stock_checked_at TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (shop, cj_pid)
);
CREATE INDEX idx_warehouse_lookup ON warehouse_products (shop, status, category);
```
- [x] `tenant_config` gains `floors` JSON (or extend gates):
      `{ warehouseDepth: 20, storeFloor: 8, stockFloor: 10 }` + `DEFAULT_FLOORS` in `types.ts`.

### W1.2 `TenantStore` warehouse methods
- [x] `putWarehouseProduct`, `getWarehouseProduct`, `searchWarehouse(tokens, limit)`
      (SQL `LIKE` over `search_text`, then relevance-rank in JS),
      `countWarehouseByCategory(status='available')`,
      `staleWarehouseRows(kind: 'stock'|'detail', cutoffIso)`,
      `purgeUnusedWarehouseRows(cutoffIso)` (module-level, unused = not store-linked
      and `fetched_at` older than 30d).

### W1.3 CJ stock reading (`src/cj.ts`)
- [x] Extend `CjClient.detail()` normalization to capture per-variant stock
      (CJ exposes warehouse inventory on variant objects / stock endpoints —
      verify exact field against live response, normalize to
      `variants[].stockUsd?` no — `variants[].stock: number` + `detail.minStock`).
- [x] Add `CjClient.stockByPid(pid)` if the detail payload proves insufficient.

### W1.4 Replenishment job (`src/jobs.ts`)
- [x] `replenishWarehouse(store, cj, cfg, opts)`:
      1. demand keywords first: `underfilledKeywords(30d)` → CJ search → gated +
         `stock ≥ stockFloor` candidates → fetch details → admit to warehouse;
      2. then each category below `warehouseDepth`;
      3. paced 1.1s/call, per-run CJ call cap (~120), per-run admit cap (~40);
      4. admission = gates + stockFloor + dedupe vs existing warehouse/links.
- [x] Freshness pass in the same nightly run:
      stock re-check — store-linked products daily, warehouse-only rows > 48h old;
      full detail re-fetch for rows > 7 days old; mark `low_stock`/`stale`.
- [x] Wire into `runDailyMaintenance` (order: purge → freshness → cull → store
      refill (W2) → replenish). Respect Workers CPU/duration limits: process in
      bounded batches; carry over to next night rather than exceeding caps.

### W1.5 Serve from warehouse
- [x] `searchBackfill`: query warehouse FIRST (status available, stock ≥ floor);
      only on insufficient fill, optional single live CJ search (flag
      `liveFallback: true` for now), and always log fill rate.
- [x] `/proxy/product`: read detail from warehouse row (fallback: old
      `getCachedDetail` path); preview never waits on CJ.
- [x] Import-on-click: before `importProduct`, one live CJ stock/price confirm
      (async, inside the existing background import); abort + mark row
      `low_stock` if below floor, prompting the "no longer available" path.

### W1.6 Tests + docs
- [x] Tests: admission respects gates/stock/dedupe; demand-priority ordering;
      freshness state transitions; searchBackfill warehouse-first (CJ fake
      asserts zero calls on warm warehouse); import-time stock abort.
- [x] README + this file updated; commit per task.

**Acceptance (W1):** with a warmed warehouse, a storefront search and a ghost
preview complete with **zero CJ calls**; nightly job maintains ≥20 available
per category or logs a shortfall; all tests green.

---

## 5. Phase W2 — Store floor + stock sync

**Goal:** store always sellable: ≥8/category listed, nothing unfulfillable.

### W2.1 Promote-from-warehouse refill
- [x] Rework `refillCollections`: deficits against `storeFloor` (8) first across
      all categories, then top-up to `target` (12); candidates come FROM THE
      WAREHOUSE (no CJ search calls); raise per-run import cap to 30.
- [x] Persistent shortfall (warehouse can't supply) → recorded for console.

### W2.2 Shopify tracked inventory
- [x] On import: create variants with `inventoryItem.tracked = true`, policy
      `DENY`, initial quantity = min(CJ stock, 999) at the store's primary
      location (`location` looked up once via Admin API, cached in tenant row or config).
- [x] Daily sync (`syncStoreInventory`): for every `state='imported'` link,
      CJ stock → `inventorySetQuantities`; below `stockFloor` → set 0
      (+ link flag `stock_paused=1`, new column, migration `0004`);
      recovered → restore quantity, clear flag.

### W2.3 Supplier metafields (theme already renders these)
- [x] Same sync writes product metafields:
      `supplier.name="CJ"`, `supplier.status` (`available|low_stock|out_of_stock`),
      `supplier.available_qty`, `supplier.last_checked_at` (ISO).
      Use `metafieldsSet`; define metafield definitions once (idempotent setup
      step in the sync job).

### W2.4 Cull interaction
- [x] `linksEligibleForArchive` excludes `stock_paused=1` rows (a product CJ ran
      dry on is not "non-performing"); add tests.

### W2.5 Tests + docs
- [x] Floor-priority refill; inventory set/zero/restore transitions; metafield
      payload shape; cull exemption. README + this doc.

**Acceptance (W2):** zeroing CJ stock for a listed product pauses it in Shopify
within one cron cycle and its PDP shows supplier status; emptying a category
below 8 triggers same-night promotion from warehouse; no order can exceed last
known stock (DENY policy).

---

## 6. Phase W3 — LLM curation via OpenRouter

**Goal:** better products and better copy, at background time, model-swappable.

### W3.1 OpenRouter client (`src/llm.ts`)
- [x] Secret `OPENROUTER_API_KEY` (wrangler secret + `.dev.vars`; add to `Env`).
- [x] Thin client: `POST https://openrouter.ai/api/v1/chat/completions`,
      headers `Authorization: Bearer`, optional `HTTP-Referer`/`X-Title`
      attribution; injected `fetchImpl` for tests; strict JSON-mode prompts with
      schema validation on parse; **never throws into a job** — failures degrade
      to "no LLM" behavior.
- [x] Config in `tenant_config.llm`:
      `{ enabled: bool, model: 'anthropic/claude-haiku-4.5', curationModel?, digestModel? }`
      (per-task override = the cost-vs-quality testing knob). Console card to
      edit + on/off switch. Validation in `validate.ts`.
- [x] Cost visibility: log OpenRouter's returned usage/cost per call into a
      `llm_usage` table (migration `0005`): shop, task, model, tokens, cost_usd, created_at.
      Console shows 30-day spend.

### W3.2 Admission curation (in `replenishWarehouse`)
- [x] For each candidate passing mechanical gates: one LLM call returns
      `{ relevanceScore: 0-100, category: <collection key|none>, title: <rewritten ≤70 chars>,
      description: <clean HTML ≤600 words>, seoTitle, seoDescription }`.
- [x] Admit only `relevanceScore ≥ threshold` (default 60, config). Rewritten
      copy stored on the warehouse row and used at import (CJ original kept
      inside `detail` JSON for audit).
- [x] Batch + cap per night (~40 calls); skip silently when `enabled=false` or
      key missing (mechanical gates remain the baseline).

### W3.3 Keyword classification (search path, cached)
- [x] First time a keyword is seen: classify to category + synonyms
      (ONE call, stored in `search_cache` under `kw-meta:`), improving warehouse
      matching. Subsequent searches: zero LLM calls. Hot-path rule respected:
      classification runs via `waitUntil`; the current search uses token match,
      the *next* one benefits.

### W3.4 Tests + docs
- [x] Client (fake fetch): success/JSON-parse-failure/HTTP-error degrade paths;
      admission threshold honored; copy fields applied at import; usage rows
      written; config validation. README + this doc.

**Acceptance (W3):** with LLM on, newly warehoused products carry rewritten
titles/descriptions and a stored score; turning it off (or key failure) reverts
to mechanical-gates behavior with zero errors; console shows model + 30-day cost.

---

## 7. Phase W4 — Intelligence digest (after ≥2 weeks of data)

- [ ] Weekly cron task: aggregate search_log, product_events, llm_usage,
      category fill, cull/refill history → one LLM call → store digest row.
- [ ] Console card: "This week: trending searches, gaps to stock, price-band
      observations, products to watch, suggested gate tweaks."
- [ ] Strictly advisory — no automated actions from the digest in W4.
- [ ] Future (post-W4, requires Shopify protected-data approval): orders
      ingestion for true ROAS; ad-creative generation fed by the digest.

---

## 7a. Backlog — findings from live operation (2026-06-12)

- [ ] **CJ category-browse replenishment.** Field-proven need: 5 keyword
      searches (~200 items) could not surface grooming scissors — CJ's text
      search OR-matches single tokens (returned car parts for "grooming
      scissors kit"). Teach replenish/search to browse CJ's category tree
      (`product/list` by categoryId, category ids cached) so the warehouse
      pulls from real categories; LLM curation still scores each candidate.
- [ ] **Freight-aware pricing + origin warehouse selection.** CJ stocks
      products in multiple "From" countries (CN main; US/UK/DE regional).
      Impacts: (a) shipping TIME — UK warehouse 2–4 days vs CN 8–15 days;
      (b) shipping COST — freight varies by origin+weight and is currently
      NOT in our landed cost (pricing uses product cost only; the £6 min
      margin partially shields cheap items). Fix: call CJ freightCalculate
      at admission/import (cheapest origin with stock ≥ floor, default CN),
      add freight to landed cost, store chosen origin on the link/warehouse
      row, and show "Ships from UK" badge when origin is UK (conversion win).
      Also note: stockByPid currently SUMS stock across all origins.
- [x] **Sync activates inventory tracking on untracked variants** (DONE
      2026-06-12): inventoryItemUpdate tracked:true + inventoryPolicy DENY
      before inventorySetQuantities. Also added: console **"Sync now"**
      button → `POST /api/sync` (session-token authed, batched: inventory
      phase 8 products/call with offset cursor, then refill phase 5
      promotions/call) — the nightly sync, runnable on demand.
- [x] Scissors hunt outcome: razor grooming comb imported via ghost-click
      pipeline (pid 2029158917514293249, £13.99, pet-grooming); nail shears
      pid 2007377705492574210 refused by the live stock floor (working as
      designed).
- [x] **Catalog-wide price realignment EXECUTED 2026-06-12 17:30 UTC** via
      the console Sync now button: all 37 CJ-linked products repriced to
      the 2.5× rule from current CJ costs (e.g. £63.40→£17.99 paw cleaner,
      £303.32→£232.99 grooming table, every price now .99). Verified in
      Shopify.
- [x] **RESOLVED + LIVE-VERIFIED 2026-06-12 19:19 UTC: CJ stock endpoint
      renamed.**
      `/product/stock/queryByPid` → "Interface not found"; the live
      endpoint is **`/product/stock/getInventoryByPid`** (per-warehouse
      rows: areaEn/countryCode/totalInventoryNum — parser handles both
      shapes). Better: `product/query` accepts
      **`features=enable_inventory`** → per-variant `inventories`
      (countryCode/totalInventory/cjInventory/factoryInventory) arrive
      WITH the detail — one CJ call instead of two in sync + replenish.
      Stock semantics fixed to **max single origin, never the sum**
      (closes the § 7a stockByPid-sums note). Source: CJ docs product.html
      (bot-blocked for agents; read via a GitHub docs mirror + user's
      browser). While it was broken: quantity sync safely left quantities
      alone; replenishment admissions were refused (recovers tonight).
      Live verification: 22/38 products fully synced (real quantities
      capped 999/variant, supplier.* metafields stamped, razor comb now
      tracked w/ 812 units); 16 still stock-unknown via BOTH routes this
      run (left safely untouched — likely CJ rate-limit flakiness or
      missing CJ inventory records; nightly sync retries, escalate to CJ
      dashboard if any stay unknown for days). No product zeroed.

## 7a-i-b. Ghost-click curation gate (shipped 2026-06-12 23:57)

Field incident: a storefront search for "pet food" backfilled CJ ghosts
(CJ OR-matches tokens → "food" matched a kitchen vacuum sealer); one
click imported it to the live store under more-to-love. Root cause:
ghost-click imports bypassed W3 curation (which only gated warehouse
admissions). Fix: `confirmAndImport` now takes a curate hook — score <
threshold ⇒ link `failed` before Shopify is touched; passing imports get
curated title/description/category; pre-curated details (llmScore set)
skip re-scoring. Wired into /proxy/product, nightly refill, manual sync
refill. The sealer itself was ARCHIVED (product 10863821160786, pid
2606120903381607900) and its link set archived. Cost: ≈$0.0003/clicked
ghost. LLM remains background-only (imports run in waitUntil).

## 7a-i-c. Inventory audit + sanitization (executed 2026-06-13 00:50)

- Catalog 43→37 active. ARCHIVED the 6 demo/proposal products (no CJ
  identity, unfulfillable; decision previously pending — user mandated).
  With the vacuum sealer that makes 7 archived. **Invariant achieved:
  every ACTIVE product is PawScout-managed (37 actives = 37 imported
  links, 1:1).**
- Relevance review of all 37 actives: clean — no further off-category
  items.
- warehouse_products: EMPTY in production (replenishment debuts with
  tonight's cron, behind the LLM gate) — nothing to sanitize.
- search_cache: all 12 kw:* rows purged (incl. "pet food" set carrying
  the vacuum-sealer ghost and the polluted scissors sets); regenerate on
  demand.
- [x] LEVER PULLED 2026-06-13 01:07Z: gates.relevance = **strict** (user,
  via console) — all search tokens must appear in ghost titles; fewer
  multi-word backfill results accepted as the trade.

## 7a-i-d. Inventory qty sync confirmed + description sanitize (2026-06-13)

- QTY SYNC VERIFIED: the 04:18Z cron synced all previously-stale (never-
  synced, qty 1-2) products with real CJ stock via the fixed
  getInventoryByPid + enable_inventory path — e.g. grooming table 1->31,
  sofa brush 1->999 (CJ 13,480), nail set 1->999 (CJ 30,000). NO products
  remain < 2 qty. Display caps 999; true qty in supplier.available_qty.
- Sofa Hair Removal Brush had a THIN description (Colour/Material only) ->
  rewrote with a proper customer-facing body (2026-06-13, via MCP).
- FINDING: legacy-adopted products carried INTERNAL dev notes in their
  customer-facing descriptions ("demo-store dropshipping testing",
  "traffic-testing workflows", "Demo category:"). BUILT a catalog-wide
  sanitize: jobs.stripInternalNotes + sanitizeDescriptions (batched,
  idempotent), /api/sanitize route, console "Clean up descriptions"
  button. Current imports never add such notes (legacy-only). DEPLOY: code
  only; then click the button. NOT yet run against production (awaiting
  user deploy + click).

## 7a-i-e. Search quality fixes (2026-06-13, from a live "cat toys" review)

Symptoms on /search?q=cat+toys: 8 results incl. 4 DOG toys (cross-category
noise), and stuck at 8 (target 12 unmet).
Root causes + fixes:
- BUG: relevanceMatch strict did exact includes(), so a plural query token
  ("toys") never matched a singular title ("Toy") — strict rejected almost
  everything, so backfill returned 0 ghosts. FIXED: keywordTokens() stems
  plurals (es>4 / s>3) + drops stopwords; shared by relevance gate AND
  warehouse LIKE search. ("cat toys" now matches cat toys, rejects dog.)
- Native Shopify search results were rendered UNFILTERED (PawScout gating
  only governed ghosts). FIXED: main-search.liquid filters results to the
  query (same stemming) with an empty->show-all fallback; "X products"
  count + backfill data-have use the filtered count.
- Dedupe: theme passes shown cj-pids (data-shown-pids) -> /proxy/search
  ?exclude= -> searchBackfill seeds `seen`, so ghosts filling to 12 never
  duplicate a card already on the page.
- DEPLOY: worker code only (no migration) + theme already merged to
  shopify-deploy. 178 tests.

## 7a-i-f. Search quality round 2 (2026-06-13, "catapult" + CJ supply)

From a live "cat toys" review (still showed a dog toy; CJ website gives a
rich list the API didn't):
- BUG: substring match — "cat" matched "catapult" → "Pet Food Catapult
  Feeder ... Dog Toy" wrongly passed. FIXED: relevanceMatch + the theme's
  native filter now do WHOLE-WORD matching (stemmed word set / space-padded
  Liquid), so a token only matches a real title word.
- CJ supply: switched cj.search to /product/listV2 (CJ's elasticsearch —
  what their website uses; the old /product/list keyword endpoint returned
  advent calendars for "cat toys"). Safe: falls back to /product/list on
  error or empty. Defensive multi-shape parser (list / content[].productList).
- Species awareness: curation prompt now scores a product <20 if it targets
  a different animal than the query context, and outputs petClass
  (cat/dog/both/small-pet/other). Stored on the warehouse detail; imports get
  a cj-pet-<class> tag. (Search-time species FILTER using the tag/class is a
  future step once products are classified — new admissions get it now.)
- popularityFloor 1->0 (live, via D1) — listedNum is mostly 0 and was
  over-rejecting valid items; relevance + LLM curation are the real gates.
- DEPLOY: worker code only + theme merged. AFTER deploy: purge kw:* search
  cache so listV2 repopulates (old cache holds junk from /product/list).
  178->179 tests.

## 7a-i-g. Search: dog-toy review (2026-06-13 ~22:00) — PARTIAL, OPEN

Live "dog toy": main grid correct (4 dog toys, catapult now valid), BUT:
- [x] FIXED + LIVE: the "Add more play value" bundle/offer section pulled
  from the category collection UNFILTERED → leaked "Electric Jumping Shrimp
  CAT Toy" into a dog search. Added a species guard (exclude opposite-species
  offer products; q_species from query tokens). shopify-deploy updated.
- [x] Purged kw:* search cache (13 rows) so listV2 repopulates fresh (old
  rows were junk from /product/list); tonight's cron stocks the warehouse
  from listV2.
- [ ] OPEN — REACHING 12: backfill returned only 2 ghosts. Root causes:
  (a) warehouse still near-empty (6 rows) — replenish was crippled by the
  earlier bugs; tonight's cron (listV2 + word-boundary + floor 0 + fresh
  cache) should finally stock it — VERIFY tomorrow.
  (b) Strict 2-word relevance is too tight for filling: "dog toy" requires
  BOTH "dog" AND "toy" as title words, so valid dog products without the
  literal word "toy" (e.g. "Herding Ball for Dogs") are rejected. PROPOSED
  FIX (next): SPECIES-AWARE relevance — when the query names a species,
  REQUIRE that species (or species-neutral) and treat category words (toy)
  as soft/optional; leverage petClass (now on new admissions) once the
  catalog is classified. This reaches 12 AND keeps cats out of dog searches.
- [ ] CONSTRAINT: sandbox network egress is blocked — CANNOT run a headless
  browser against the live store from here (activepaw.co.uk 403s; App Proxy
  needs Shopify HMAC). Live verification = user's browser. Verify via
  deployed-bundle greps + D1 + vitest instead.
- NOT "done" per user's bar (reach 12 + verify). Resume: implement
  species-aware relevance in src/proxy/search.ts (relevanceMatch/passesGates
  + a query-species helper), re-test, and confirm warehouse fill after the
  04:17Z cron.

## 7a-i-h. Species-aware relevance (2026-06-13 22:20) — code done, live-verify PENDING

Implements the resume item from 7a-i-g.
- relevanceMatch: hard SPECIES gate first (cat product never matches a dog
  query in ANY mode incl. loose), then word-boundary token matching.
- NEW liveCjPasses(item, gates, keyword): for CJ listV2 results (which already
  did category relevance) enforce price + popularityFloor + SPECIES-REQUIRED
  (if the query names an animal, the product title must name that animal or
  both). This (a) reaches the 12 target — any genuine dog product fills a
  "dog toy" search, not only ones with the literal word "toy"; (b) blocks
  species-less junk (advent calendars) and the wrong species. Used by BOTH
  storefront backfill (src/proxy/search.ts CJ fallback) AND warehouse
  replenishment (src/jobs.ts) so the warehouse stocks what searches surface.
- Non-species queries (e.g. "slicker brush") keep category-token matching.
- 184 vitest cases (incl. Herding-Ball-fills, cat-blocked, calendar-blocked,
  price/popularity). DEPLOY: worker code only.

HEADLESS-BROWSER VERIFY — BLOCKED FROM SANDBOX (documented attempt):
- curl https://activepaw.co.uk/search?q=dog+toy -> HTTP 403 (Cloudflare
  managed challenge; egress works, the request reaches the server).
- Playwright chromium binary will NOT download (browser CDN off the egress
  allowlist, same as pawscout-relay.fly.dev). No system chromium present.
- => cannot run a headless browser here. Logic verified by unit tests; the
  LIVE check is the user's browser, OR a CI runner with open network +
  ability to solve/whitelist Cloudflare. "Reaches 12" also depends on CJ
  listV2 supply for the term + warehouse stock (cron) — not artificially
  capped anymore, but supply-dependent.

## 7a-i-i. listV2 was never actually working (2026-06-14 02:40)

User pushed back: "maybe OUR method is junk, not CJ's." Correct. Root cause
of the junk "dog toy"/"cat toys" results:
- listV2 returns the product id in `id` (NOT `pid`/`productId`); our mapper
  read pid -> empty -> every listV2 row dropped -> searchV2 returned [] ->
  cj.search SILENTLY FELL BACK to /product/list (the OR-matching keyword
  endpoint that returns advent calendars, kids toys, an adult toy, dog
  bowls/leashes/beds for "dog toy"). So we were never using listV2.
- Also: listV2 takes `page`/`size` (not pageNum/pageSize) + orderBy:0
  (best match). Fixed all three. Defensive mapper now reads both shapes.
- CJ docs (acdc-digital/elvato CJ API Docs 015 mirror) confirm: listV2
  data path = data.content[].productList; fields id/nameEn/bigImage/
  sellPrice/listedNum/threeCategoryName; orderBy 0=best match default;
  also has startSellPrice/endSellPrice + categoryId/lv2categoryList (future:
  source-side price + category-browse).
- Still NOT deployed by user as of this commit (deployed bundle had listV2
  markers but NOT liveCjPasses/speciesConflict — i.e. the species round +
  this id-fix both await one `git pull && npx wrangler deploy`).
- VERIFY LOOP (works via our worker, no sandbox CJ access needed): after
  deploy, purge kw:* cache, user searches "dog toy", then READ the new
  kw:dog toy cache from D1 and compare titles to the old junk. If clean ->
  listV2 fixed. 186 tests.

## 7a-i-j. listV2 FIX VERIFIED + price floor 0.50 (2026-06-14 03:08)

Firecrawl search diagnostic (console "Search source diagnostic" -> /api/
search-diag, stores diag:ours / diag:web to D1) PROVED the listV2 id-field
fix: diag:ours:dog toy returned 25 CLEAN dog toys (Cotton String Dog Toy,
Aggressive Chew Dog Toy, Dog Rope Toy, Dog Teething Toy, ...) — zero junk.
User's hypothesis (our method, not CJ's, was junk) confirmed. (Firecrawl
diag:web returned 0 — CJ site render/scrape hiccup; moot since our own
listV2 is now clean. Firecrawl client kept for future supply/category use;
the scrape may need URL-format/waitFor tuning if used later.)

NEW finding from the same data: the clean dog toys cost $0.50–$5 to source,
but priceMin was $5 -> filtered ~22 of 25. The £6 min-margin rule floors
ALL retail at £6.99 regardless of cost, so the $5 source floor wasn't
protecting price — it was hiding most of CJ's (cheap) pet catalog.
DECISION (user 2026-06-14): main gate priceMin 5 -> **0.50** (live via D1;
{"popularityFloor":0,"priceMin":0.5,"priceMax":80,"relevance":"strict"}).
kw:* cache purged so storefront repopulates with fixed listV2 + new floor.
Quality now gated by listV2 relevance + species + LLM curation, not price.

SIDE EFFECT: the add-on lane (addons.priceMin 0.5–5) now fully overlaps the
main band -> mostly redundant (main admits $0.50+ as visible products).
Revisit whether to keep/repurpose the hidden add-on lane.

## 7a-ii. STRATEGY DECISION — shipping display, origin choice, returns
## (user-raised 2026-06-12; recommendation delivered same day; user
##  decision pending — do not implement until the user confirms)

Question as raised: show product price only in the shop with shipping
transparency on the PDP vs baking freight into the retail price; let buyers
choose the CJ "From" origin (speed vs price); and review returns-policy
economics for net-profit impact.

**Recommendation delivered (summary):**

1. **Pricing model: hybrid (option c), which the store already runs.**
   Live Shopify rates: UK Standard £4.99 flat, FREE over £50, Express
   £6.99; EU £14.99; Int'l £23.99. Keep sticker = 2.5× product cost
   (freight NOT in sticker — baking it in would double-dip with the £4.99
   fee, overcharge multi-item carts, and make prices uncompetitive).
   BUT make the MARGIN FLOOR freight-aware: enforce minMargin/floor
   against (product cost + cheapest viable freight quote), so heavy/bulky
   items can never go out underwater. This refines the § 7a backlog item:
   freight informs the floor, it does not inflate the sticker.
2. **PDP transparency block (theme):** delivery cost + estimated window on
   every PDP ("FREE UK delivery over £50 · Standard £4.99 (8–12 working
   days) · Ships from UK, 2–4 days" when origin is UK). Kills checkout
   surprise — the top abandonment cause.
3. **Origin: PS chooses, buyers don't.** Buyer-facing origin choice needs
   per-origin variants/SKUs + split inventory + CJ mapping mess, and
   Shopify Basic can't price origin-dependent rates without per-product
   delivery profiles (mixed carts then SUM profile rates — confusing).
   Instead PS auto-prefers the UK warehouse when stock ≥ floor and margin
   holds; the buyer's speed lever is the Express rate. CAVEAT: Express
   £6.99 is currently offered on EVERYTHING including CN-origin items that
   cannot be expressed — remove Express until a UK-stock delivery profile
   exists (Phase 2: custom profile for UK-origin products carrying
   Express; default profile Standard-only).
4. **Free-over-£50 threshold: keep.** At 2.5× a £50 order carries ~£17–20
   COGS; absorbing £4–8 freight still clears margin, and the threshold
   lifts AOV. Revisit with real order data.
5. **Returns policy (UK law + dropship economics):**
   - CCR 2013: 14-day change-of-mind on distance sales; we must refund
     outbound shipping at basic rate; customer pays return postage ONLY if
     the policy says so → policy MUST say so.
   - CRA 2015: faulty/not-as-described = full refund incl. return costs,
     30 days.
   - Change-of-mind under ~£25 retail: refund-without-return ("keep it")
     is cheaper than processing a return (product cost ~£7–10 vs postage +
     admin). Case-by-case, never advertised, capped per customer.
   - Higher value: contact-first, buyer pays return postage; never publish
     the CN warehouse address; UK-origin items can return to CJ UK.
   - Damaged/lost: photo evidence → CJ dispute (refunds product + freight
     when valid; file within CJ's ~30-day post-delivery window) → refund
     customer fully; net cost ≈ £0.
   - Hidden drains: Shopify Payments keeps processing fees on refunds
     (~2.9% lost per refunded order); outbound-shipping refunds on full
     cancellations. Keep the 3% refunds allowance; track actuals.
   - Mitigations: LLM size charts for harnesses/apparel (top return
     drivers); curated accurate descriptions (already live).
   - **Refund-exposure math (user-raised 2026-06-12 follow-up — complete
     refund obligation, full vs partial):**
     - FULL return (whole order, change of mind): refund = all products +
       original outbound delivery at basic rate (Express upgrade delta not
       owed). Revenue nets to ZERO; sunk costs stay. £50 free-ship order:
       ~£20 COGS + ~£6 freight + ~£1.45 Shopify fee (not returned on
       refunds) ≈ **£27 loss ≈ full landed cost + fees**. Returned goods
       have no salvage (no warehouse) except UK-origin restock to CJ UK or
       faulty items recovered via CJ dispute (loss shrinks to ≈ the fee).
     - PARTIAL return: refund the returned line item only — outbound-
       shipping refund duty applies to full cancellation, not partial.
       Apply the policy clawback: if the return drops the order below £50,
       deduct the £4.99 delivery charge from the refund (must be stated in
       the policy). Loss ≈ that item's product cost + proportional fee;
       parcel freight already shared. Shopify supports per-line partial
       refunds natively.
     - Allowance sizing: a fully refunded order costs ~53–55% of its
       revenue, so the model's 3%-of-revenue refunds line absorbs full-
       loss refunds on ~5–6% of orders; pet-niche return rates run 2–5%
       (apparel/harnesses are the risk subset). Adequate — track actuals
       split full-vs-partial once orders flow.

**Implementation queue — EXECUTED 2026-06-12 evening:**
(i) [x] PDP delivery-info block live (snippets/delivery-info.liquid;
    replaced stale "over £150 ship free" copy; Ships-from-UK badge reads
    supplier.origin; rates mirrored from Shopify settings — update the
    snippet assigns if rates change).
(ii) [x] Freight-aware margin floor + origin preference shipped
    (pricing.retailPriceGbp freight param; CjClient.freightEstimate via
    POST logistic/freightCalculate; chooseOrigin prefers GB ≥ stockFloor;
    captured at admission + ghost import, reused by sync; supplier.origin
    metafield). VERIFY freightCalculate response parse against live API
    on first replenishment (params from docs mirror, not exercised live).
(iii) [x] Express rate DELETED from the UK zone via deliveryProfileUpdate
    (was £6.99 on everything incl. CN-origin items). Reintroduce only
    with a UK-stock delivery profile.
(iv) [x] Returns & Refunds policy text written — docs/RETURNS_POLICY.md;
    USER ACTION: paste into Settings → Policies → Return and refund
    policy (app token lacks write_legal_policies). The PDP delivery block
    links /policies/refund-policy.

## 7a-iii. Returns evidence gating (user-approved direction 2026-06-12)

Principle: **our buyer-evidence intake must mirror CJ's dispute bar** —
never refund a faulty/damaged/wrong-item claim on less evidence than CJ
requires, so every refund is already a CJ-recoverable claim (the −£0.85
vs −£15.85 spread in the § 7a-ii refund math).

CJ evidence expectations per claim type (VERIFY against CJ's live dispute
policy before hard-coding; re-verify whenever a dispute is declined):
- Damaged in transit: outer packaging all sides + shipping label with
  barcode legible + the damage itself (separate clear shots).
- Wrong item / missing parts: received item incl. SKU sticker/bag label,
  next to packaging.
- Not working: VIDEO demonstrating the defect (unboxing-style preferred).
- Not delivered: tracking only; just file inside the window.
- TIMING GATE: dispute window ≈ 30 days from delivered status. Perfect
  evidence on day 31 = £0. Track the deadline per fulfilment.

Phase 1 (manual, at launch):
- [ ] Returns policy + support reply template state the exact required
      shots per claim type BEFORE a refund is processed; policy says
      "keep all packaging until your claim is resolved" (binned packaging
      is the #1 evidence killer). Asking reasonable proof of fault before
      refunding is lawful UK practice; don't stall once evidence is in.
- [ ] Runbook: file the CJ dispute the SAME DAY the customer is refunded;
      pin CJ's current dispute requirements into this doc when first seen
      in the dashboard.

**Return-window rules (settled 2026-06-12 — policy page must follow):**
- Change of mind: 14 days from delivery to cancel + 14 to return = the
  CCR statutory minimum; lawful as-is. No CJ recovery exists for these
  anyway, so the CJ 30-day window is irrelevant here.
- Faulty/damaged/wrong item: CANNOT be capped at 14 days. CRA 2015 gives
  a 30-day right to reject, 6-month fault presumption, multi-year claims.
  A shorter cap is void AND stating it is a misleading-practice offence.
- CJ-buffer fix instead: policy ASKS (never bars) prompt reporting —
  "if your item arrives damaged or incorrect, please contact us within
  7 days of delivery with photos — this lets us resolve fastest." Framed
  as the fast path only; include "nothing in this policy affects your
  statutory rights." Transit damage surfaces at unboxing, so this pulls
  reports into days 1–3 ≈ 3 weeks of CJ-dispute buffer.
- Accepted residual: valid fault reported near/after CJ's day-30 window
  is refunded with no CJ recovery; rare, lives inside the 3% allowance.

Phase 2 (W6 — automated claims pipeline; CONFIRMED feasible 2026-06-12):
CJ API 2.0 has a disputes module — `POST /api2.0/v1/disputes/create` takes
{orderId, businessDisputeId, disputeReasonId, expectType, refundType,
messageText, imageUrl[], productInfoList[{lineItemId, quantity}]} plus
companion list/confirm/cancel/getDisputeProducts endpoints (docs:
developers.cjdropshipping.com/en/api/api2/api/dispute.html — site blocks
bots; verify disputeReasonId enum + image constraints via the relay with
our token at build time). imageUrl[] means R2-hosted evidence URLs can be
passed straight through — full automation is possible end-to-end.

Target pipeline: buyer initiates → PS gates evidence → auto-file to CJ:
- [ ] `/proxy/return` page (App Proxy HMAC, 200+ok rule): order number +
      email verified against Shopify; buyer picks line item + claim type.
- [ ] Evidence intake: uploads → R2 bucket (new binding); LLM vision gate
      via OpenRouter (label legible? packaging shown? product matches our
      catalog image for that SKU — doubles as fraud screen); instant
      "retake showing X" feedback; claim blocked until checklist green.
- [ ] D1 claims tables + state machine: draft → evidence_complete →
      filed → cj_accepted/cj_declined → refunded/closed; dispute deadline
      computed from delivery date, surfaced in console.
- [ ] Auto-file: disputes/create via relay (stored CJ orderId, reasonId,
      refund expectType, R2 image URLs, line items); poll dispute list
      for verdict; console claims card with days-remaining.
- [ ] HUMAN GATE (initial): customer refund is one-click APPROVAL in the
      console, not autonomous — relax to a config flag after ~a dozen
      claims observed. Evidence gating + CJ filing fully automatic.

PREREQUISITES (W6 depends on the order-fulfilment phase):
- [ ] Order pipeline first: Shopify orders/create webhook → CJ
      createOrder → store shopifyOrderId↔cjOrderId mapping in D1.
      Does not exist yet (checkout disabled). Disputes reference cjOrderId.
- [ ] Shopify protected-customer-data approval (read_orders) — same
      application the W4 orders/ROAS work needs; one approval covers both.

## 7a-iv. Phase W-FULFIL — order→CJ fulfilment automation (designed
## 2026-06-12; runs BEFORE W6 claims, which consumes its order mapping)

Money-leg corrections vs the naive design (decided with user):
- Customer payment = Shopify Payments → bank payout (PayPal optional as a
  buyer-facing wallet only). Receipt = Shopify's automatic order
  confirmation email — nothing to build.
- Paying CJ: NOT per-order PayPal automation. Use the CJ WALLET: user
  tops up balance (weekly, via PayPal/card), PS pays each order from
  balance via API (`pay/payBalance`). PS alerts (console + email) when
  balance < ~1 week of expected COGS.

Pipeline:
- [ ] F1. `orders/paid` webhook → PS (HMAC verify, same infra as
      uninstall webhook). Needs protected-customer-data approval.
- [ ] F2. Pre-spend verification: all line items map to CJ pids in
      product_links; Shopify fraud risk not HIGH; address complete and
      CJ-formattable; CJ stock ≥ floor at chosen origin; margin sanity —
      amount paid still clears floor vs CURRENT CJ price. Any failure →
      console hold queue, never a silent CJ order.
- [ ] F3. Grace window: wait ~60 min after payment before CJ submission
      (buyer edits/cancellations are cheap pre-CJ, expensive after).
      Surface "edit or cancel within an hour" in the confirmation flow.
- [ ] F4. createOrderV2 at preferred origin (UK warehouse when stocked) +
      payBalance; store shopifyOrderId↔cjOrderId in D1 (new tables/
      migration). CJ order confirmation recorded as receipt.
- [ ] F5. Status poll (cron, more frequent than nightly): when tracking
      number appears → Shopify fulfilmentCreate WITH tracking → Shopify
      auto-sends shipping email + live order-status page (native).
- [ ] F6. Delivery watch: CJ tracking milestones; DELIVERED starts the
      returns/dispute clock; delivered+5d → review-request email (W5
      Resend pipeline).
- [ ] F7. Trust layer: proactive delay alert — no tracking movement for
      N days → PS emails the buyer an honest status update BEFORE they
      ask (biggest dropship trust differentiator). Confirm CJ neutral/
      no-logo packaging per order.
- [ ] F8. Mistype protection (decided 2026-06-12): NO pre-payment
      confirmation modal — checkout UI is Plus-only AND interstitials at
      Pay Now are conversion poison (reflexive box-ticking catches no
      typos). Instead: (a) Shopify checkout's native address autocomplete/
      validation catches errors at entry; (b) customize the order-
      confirmation EMAIL template (all plans) with a prominent "double-
      check your delivery address — reply within 60 minutes to correct"
      block, pairing with the F3 grace window; (c) F2 validation holds
      CJ-unformattable addresses for proactive buyer contact.
- [ ] HUMAN GATES (initial): first ~20 orders one-click approved in
      console before CJ submission; permanent manual review for fraud-
      flagged orders and orders > £100. Relax via config flag later.

Prereqs: pricing finalized → checkout re-enabled; protected-data approval
(one application covers W-FULFIL + W6 + W4 ROAS); initial CJ wallet
top-up (user). Verify at build time: createOrderV2/payBalance exact
params via relay; CJ no-logo packing flag.

## 7a-v. Cart abandonment strategy (decided 2026-06-12)

Baseline: ~70% abandonment is universal; target the recoverable 5–15%.

Layer 1 — prevention (mostly already decided elsewhere): PDP delivery
block + free-over-£50 bar kill surprise-cost abandonment; guest checkout
ON (confirm at re-enable); honest delivery estimates up front; Shopify
Payments wallets (Apple/Google Pay) + ADD PAYPAL as buyer option (UK
trust signal for new stores); policies + contact email visible in footer.

Layer 2 — at checkout re-enable (user action, free, no app):
- [ ] Turn on Shopify's native abandoned-checkout email automation
      (all plans, Marketing → Automations). Set delay to 1–4 HOURS (not
      the 10h default — recovery decays fast); customize template (brand
      voice, product image prominent, restore-cart link). This is the
      majority of recovered revenue industry-wide.

Layer 3 — W5 extension (Resend/sequence):
- [ ] One follow-up at ~24h, max sequence = 2 emails total.
- [ ] Carts at £40–49: "you're £X away from free delivery" nudge —
      margin-positive incentive, no discount devaluation.
- [ ] PECR: abandoners ride soft opt-in (email collected in negotiations
      for a sale, similar goods, opt-out offered) — unsubscribe link
      always.

Deliberate NOs (decided): no discount codes in recovery emails (trains
abandonment-for-coupons); no exit-intent popups (mobile-hostile, off-
brand); no SMS recovery. Revisit discounts only as email #2, small,
rotated, if data demands.

**Discount guardrail (decided 2026-06-12):** net margin is 17%, so the
break-even discount is ~17–18% — a 20% discount LOSES ~£1/order (£50
order: full price nets +£8.50; 10% off nets +£3.80, i.e. 55% of profit
gone; 20% off nets −£0.90; volume can't fix a per-order loss; 10% off
needs 2.2× volume just to tread water). CEILING: 10%, single-use,
first-order or slow-mover only — never blanket. Preferred levers in
order: free-over-£50 threshold (self-funding), bundles/multi-buy (shared
freight + second-item margin), first-order welcome code accounted as
acquisition cost vs ad CPA. Sale events need room built into a genuine
regular price first (UK rules ban fictitious was-prices).

**Compare-at wipe (executed 2026-06-12):** all legacy products (42 of
43, ~440 variants — every batch except the flywheel-imported razor comb)
carried fake compareAtPrice values ×1.28–1.35 above price, rendering
permanent "save 20–26%" badges = fictitious was-prices (CPR risk + trust
damage). Cleared to null via productVariantsBulkUpdate, zero errors;
selling prices untouched. Import pipeline and nightly sync never set
compareAtPrice, so the catalog stays clean; future sale badges must come
from genuine promotions only.

Measurement: abandonment + recovery rate → W4 digest; Shopify's native
automation self-reports recovered sales from day one.

## 7a-iv-b. Phase W-ADDON — hidden basket-fillers (BUILT 2026-06-13 01:50)

User decision: cheap-but-quality products ($1–5 cost) may enter inventory
but must NEVER appear in browsing/search — they surface only as add-ons.

- Config: `addons` JSON col (migration 0006) — defaults {enabled:true,
  priceMinUsd:0.5, priceMaxUsd:5, poolSize:12}. CONSOLE CARD 6 added
  2026-06-13 (/api/addons + validateAddonsPayload): cost min/max, pool,
  enabled. Floor lowered to $0.50 (user 2026-06-13) so the cheapest CJ
  fillers land. NOTE: retail still obeys the pricing rule — the £6 min-
  margin floor dominates sub-~$4 cost, so a $0.50 item still retails
  ~£6.99 (huge margin %, not a sub-£6 sticker). True low-price fillers
  would need an addon-specific minMargin — NOT built (user chose to keep
  £6 min / £6.99 add-ons 2026-06-13).
- VISIBILITY TOGGLE (built 2026-06-13): `addons.suppressFromBrowse`
  (default true). Hidden = no collection tag + seo.hidden=1 (add-on slots
  only). Visible = resolved collection tag + seo.hidden=0 (also in
  browsing & search). Console card 6 dropdown. `reconcileAddonVisibility`
  re-aligns EXISTING add-ons when flipped (nightly + best-effort on save).
  product_links.category stays 'addons' either way → widgets always find
  them and they never count toward category floors/targets. DEPLOY: code
  only, no migration (field lives in the existing addons JSON column).
- Worker: replenish addon lane (reuses category keyword caches → zero
  extra CJ searches; same LLM curation; admits under category 'addons');
  refill tops the pool to poolSize; import tags `cj-addon`, sets
  `seo.hidden=1`, NO collection tag → buyable, invisible to search/
  collections/sitemap; GET /proxy/addons returns random filler handles.
- Theme: PDP "Complete the kit" row + cart-drawer free-delivery nudge
  ("£X away from FREE UK delivery", server-rendered amount) — pawscout.js
  fetches handles → /products/{handle}.js → one-tap add via Section
  Rendering API re-render.
- Lifecycle: addons excluded from category floors/targets; normal stock
  sync, pricing rule (min-margin floor dominates) and 30-day cull apply.
- [x] DEPLOYED 2026-06-13 ~02:10Z: migration 0006 applied (addons col
      present, reads '{}' → defaults) and worker bundle live (verified:
      /proxy/addons, listAddonHandles, cj-addon, pawscoutHide, seo).
      Theme widgets live on shopify-deploy.
- First fills: the 04:17Z cron stocks the addon pool; widgets stay
  hidden until then (graceful empty state).

## 7b. Phase W5 — Email marketing via Resend (designed, not yet scheduled)

The user has a Resend account. Newsletter signups currently post through the
contact form (arrive as plain emails — no list). Target design:

- [ ] W5.1 Worker: `POST /proxy/subscribe` (App Proxy HMAC, 200+ok rule).
      Validates the email, then (a) creates/updates the Shopify customer with
      email-marketing consent via Admin GraphQL (consent state SUBSCRIBED,
      single opt-in initially), and (b) adds the contact to a Resend Audience
      via the Resend API. New secret: `RESEND_API_KEY`; config: audience id in
      tenant_config (new `email` JSON column, migration). Idempotent on
      repeat signups. Rate-limit/bot-guard: honeypot field + per-IP throttle.
- [ ] W5.2 Theme: footer newsletter form posts to the proxy (AJAX, inline
      success message) instead of /contact. Graceful no-JS fallback keeps the
      current /contact behavior.
- [ ] W5.3 Sending: campaigns/broadcasts authored in Resend's dashboard
      against the Audience (no PawScout code needed initially). Domain setup
      (user): verify activepaw.co.uk in Resend (SPF/DKIM records) so sends
      come from @activepaw.co.uk.
- [ ] W5.4 (ties into W4): weekly "new arrivals" broadcast — the W4 digest
      pipeline drafts a product-picks email (top curated imports + demand
      keywords) via Resend's send API; user approves/sends from Resend.
      Strictly opt-in list, unsubscribe handled by Resend.
- [ ] Compliance notes: UK PECR/GDPR — marketing only to subscribers from
      this flow; consent recorded both in Shopify (source of truth) and
      Resend; consider double opt-in before first real campaign.

## 8. Conventions & runbook (for any developer picking this up)

**Conventions**
- TypeScript strict; tests in workerd (`npm test`), 1 commit per task,
  `npx tsc --noEmit` + full suite green before every commit.
- All D1 access via `TenantStore` (guard test fails otherwise). External calls
  (CJ/Shopify/OpenRouter) take injected `fetch`/function params for testability.
- Secrets only via wrangler secrets / `.dev.vars`. Never in `wrangler.toml` or code.
- `/proxy/*` responses: HTTP 200 + `ok` flag, always.
- Branch: `claude/stoic-pasteur-a2ol7z` until told otherwise; do not push to
  theme repo's `shopify-deploy` (it auto-syncs to the live store).

**Deploy runbook**
```bash
cd pawscout-worker
git pull origin claude/stoic-pasteur-a2ol7z
npm install
npm test && npm run typecheck
npm run migrate:remote     # only when a new migrations/000X file landed
npm run deploy
# new secrets (W3): wrangler secret put OPENROUTER_API_KEY
```
Verify: `https://activepaw.co.uk/apps/pawscout/search?q=dog+toy` → `{"ok":true,...}`.

**Known traps (already hit once — don't rediscover them)**
| Symptom | Cause / fix |
|---|---|
| Storefront shows "error in the third-party application" | App Proxy masks non-2xx; `/proxy/*` must return 200+`ok:false` (already enforced) |
| `Decryption failed … AES-GCM` | Secret sealed under a rotated DEK. Reinstalls must reuse DEK (fixed); if it recurs, the credential is unrecoverable — delete row, re-enter key |
| CJ auth failures right after connecting the key | CJ allows 1 auth per 300s and connect-validation consumes one; wait 5 min |
| Worker 404 on `/proxy/*` | Old build deployed — `git pull && npm run deploy` |
| `CJ HTTP 429 — code 1600200 "one ip limit 3 users"` | CJ caps **3 API accounts per source IP**; Workers egress IPs are shared and saturated. NOT a velocity problem — direct Worker→CJ calls can never be reliable. Fix: the `relay/` app on Fly.io with a static egress IP (`fly ips allocate-egress`, $3.60/mo); worker secrets `CJ_RELAY_URL` + `CJ_RELAY_TOKEN` route all CJ traffic through it (`relayedFetch` in `src/cj.ts`). See `relay/README.md` |
| `Illegal invocation … incorrect this` in prod only | Raw global `fetch` stored as a default param; guard test now forbids it — always use `defaultFetch` from `src/safe-fetch.ts` |
| Sync reports "0 products synced" / imports land untracked | Missing API scopes: the location query needs `read_locations`, quantity/tracking writes need `read_inventory,write_inventory`. The token-exchange token gets the scopes from the **Dev Dashboard config** (wrangler.toml's SHOPIFY_SCOPES only feeds legacy OAuth). Fix: add scopes in BOTH places, then clear `tenants.access_token_enc` in D1 (keep dek_wrapped! CJ key survives) — next console load re-mints the token with the new scopes |
