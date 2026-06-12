# PawScout Warehouse Evolution — W1–W4 Implementation Plan

> **Purpose of this document**: a self-sufficient implementation plan. If work is
> interrupted or handed to another developer, reading this file plus the README
> is enough to continue. Keep it updated: tick checkboxes as tasks land, and
> append to the Decision Log when anything is decided differently.
>
> Last updated: 2026-06-12 · Working branch (both repos): `claude/stoic-pasteur-a2ol7z`

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
- [ ] Deploy the CJ egress relay (`relay/` on Fly.io) and set worker secrets
      `CJ_RELAY_URL` + `CJ_RELAY_TOKEN` — direct Worker→CJ calls 429
      (see known traps: "one ip limit 3 users").
- [ ] Verify end-to-end: `https://activepaw.co.uk/apps/pawscout/search?q=dog+toy`
      returns `{"ok":true,...}`.

**Production identifiers:**

| What | Value |
|---|---|
| Worker | `pawscout-worker` on Cloudflare, custom domain `pawscout.activepaw.co.uk` |
| D1 database | `pawscout`, id `85f80862-0b26-4515-82b6-3408124e3a59` |
| Shop | `4qkudm-ez.myshopify.com` (storefront `activepaw.co.uk`) |
| Worker secrets | `SHOPIFY_API_SECRET`, `PAWSCOUT_MASTER_KEY` (+ `OPENROUTER_API_KEY` from W3) |
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
| Retention | warehouse/cache rows 30 days unused; logs 90 days | PS storage promise |

---

## 4. Phase W1 — Warehouse core

**Goal:** searches and previews served entirely from PS-local data.

### W1.1 Migration `0003_warehouse.sql`
- [ ] New table:
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
- [ ] `tenant_config` gains `floors` JSON (or extend gates):
      `{ warehouseDepth: 20, storeFloor: 8, stockFloor: 10 }` + `DEFAULT_FLOORS` in `types.ts`.

### W1.2 `TenantStore` warehouse methods
- [ ] `putWarehouseProduct`, `getWarehouseProduct`, `searchWarehouse(tokens, limit)`
      (SQL `LIKE` over `search_text`, then relevance-rank in JS),
      `countWarehouseByCategory(status='available')`,
      `staleWarehouseRows(kind: 'stock'|'detail', cutoffIso)`,
      `purgeUnusedWarehouseRows(cutoffIso)` (module-level, unused = not store-linked
      and `fetched_at` older than 30d).

### W1.3 CJ stock reading (`src/cj.ts`)
- [ ] Extend `CjClient.detail()` normalization to capture per-variant stock
      (CJ exposes warehouse inventory on variant objects / stock endpoints —
      verify exact field against live response, normalize to
      `variants[].stockUsd?` no — `variants[].stock: number` + `detail.minStock`).
- [ ] Add `CjClient.stockByPid(pid)` if the detail payload proves insufficient.

### W1.4 Replenishment job (`src/jobs.ts`)
- [ ] `replenishWarehouse(store, cj, cfg, opts)`:
      1. demand keywords first: `underfilledKeywords(30d)` → CJ search → gated +
         `stock ≥ stockFloor` candidates → fetch details → admit to warehouse;
      2. then each category below `warehouseDepth`;
      3. paced 1.1s/call, per-run CJ call cap (~120), per-run admit cap (~40);
      4. admission = gates + stockFloor + dedupe vs existing warehouse/links.
- [ ] Freshness pass in the same nightly run:
      stock re-check — store-linked products daily, warehouse-only rows > 48h old;
      full detail re-fetch for rows > 7 days old; mark `low_stock`/`stale`.
- [ ] Wire into `runDailyMaintenance` (order: purge → freshness → cull → store
      refill (W2) → replenish). Respect Workers CPU/duration limits: process in
      bounded batches; carry over to next night rather than exceeding caps.

### W1.5 Serve from warehouse
- [ ] `searchBackfill`: query warehouse FIRST (status available, stock ≥ floor);
      only on insufficient fill, optional single live CJ search (flag
      `liveFallback: true` for now), and always log fill rate.
- [ ] `/proxy/product`: read detail from warehouse row (fallback: old
      `getCachedDetail` path); preview never waits on CJ.
- [ ] Import-on-click: before `importProduct`, one live CJ stock/price confirm
      (async, inside the existing background import); abort + mark row
      `low_stock` if below floor, prompting the "no longer available" path.

### W1.6 Tests + docs
- [ ] Tests: admission respects gates/stock/dedupe; demand-priority ordering;
      freshness state transitions; searchBackfill warehouse-first (CJ fake
      asserts zero calls on warm warehouse); import-time stock abort.
- [ ] README + this file updated; commit per task.

**Acceptance (W1):** with a warmed warehouse, a storefront search and a ghost
preview complete with **zero CJ calls**; nightly job maintains ≥20 available
per category or logs a shortfall; all tests green.

---

## 5. Phase W2 — Store floor + stock sync

**Goal:** store always sellable: ≥8/category listed, nothing unfulfillable.

### W2.1 Promote-from-warehouse refill
- [ ] Rework `refillCollections`: deficits against `storeFloor` (8) first across
      all categories, then top-up to `target` (12); candidates come FROM THE
      WAREHOUSE (no CJ search calls); raise per-run import cap to 30.
- [ ] Persistent shortfall (warehouse can't supply) → recorded for console.

### W2.2 Shopify tracked inventory
- [ ] On import: create variants with `inventoryItem.tracked = true`, policy
      `DENY`, initial quantity = min(CJ stock, 999) at the store's primary
      location (`location` looked up once via Admin API, cached in tenant row or config).
- [ ] Daily sync (`syncStoreInventory`): for every `state='imported'` link,
      CJ stock → `inventorySetQuantities`; below `stockFloor` → set 0
      (+ link flag `stock_paused=1`, new column, migration `0004`);
      recovered → restore quantity, clear flag.

### W2.3 Supplier metafields (theme already renders these)
- [ ] Same sync writes product metafields:
      `supplier.name="CJ"`, `supplier.status` (`available|low_stock|out_of_stock`),
      `supplier.available_qty`, `supplier.last_checked_at` (ISO).
      Use `metafieldsSet`; define metafield definitions once (idempotent setup
      step in the sync job).

### W2.4 Cull interaction
- [ ] `linksEligibleForArchive` excludes `stock_paused=1` rows (a product CJ ran
      dry on is not "non-performing"); add tests.

### W2.5 Tests + docs
- [ ] Floor-priority refill; inventory set/zero/restore transitions; metafield
      payload shape; cull exemption. README + this doc.

**Acceptance (W2):** zeroing CJ stock for a listed product pauses it in Shopify
within one cron cycle and its PDP shows supplier status; emptying a category
below 8 triggers same-night promotion from warehouse; no order can exceed last
known stock (DENY policy).

---

## 6. Phase W3 — LLM curation via OpenRouter

**Goal:** better products and better copy, at background time, model-swappable.

### W3.1 OpenRouter client (`src/llm.ts`)
- [ ] Secret `OPENROUTER_API_KEY` (wrangler secret + `.dev.vars`; add to `Env`).
- [ ] Thin client: `POST https://openrouter.ai/api/v1/chat/completions`,
      headers `Authorization: Bearer`, optional `HTTP-Referer`/`X-Title`
      attribution; injected `fetchImpl` for tests; strict JSON-mode prompts with
      schema validation on parse; **never throws into a job** — failures degrade
      to "no LLM" behavior.
- [ ] Config in `tenant_config.llm`:
      `{ enabled: bool, model: 'anthropic/claude-haiku-4.5', curationModel?, digestModel? }`
      (per-task override = the cost-vs-quality testing knob). Console card to
      edit + on/off switch. Validation in `validate.ts`.
- [ ] Cost visibility: log OpenRouter's returned usage/cost per call into a
      `llm_usage` table (migration `0005`): shop, task, model, tokens, cost_usd, created_at.
      Console shows 30-day spend.

### W3.2 Admission curation (in `replenishWarehouse`)
- [ ] For each candidate passing mechanical gates: one LLM call returns
      `{ relevanceScore: 0-100, category: <collection key|none>, title: <rewritten ≤70 chars>,
      description: <clean HTML ≤600 words>, seoTitle, seoDescription }`.
- [ ] Admit only `relevanceScore ≥ threshold` (default 60, config). Rewritten
      copy stored on the warehouse row and used at import (CJ original kept
      inside `detail` JSON for audit).
- [ ] Batch + cap per night (~40 calls); skip silently when `enabled=false` or
      key missing (mechanical gates remain the baseline).

### W3.3 Keyword classification (search path, cached)
- [ ] First time a keyword is seen: classify to category + synonyms
      (ONE call, stored in `search_cache` under `kw-meta:`), improving warehouse
      matching. Subsequent searches: zero LLM calls. Hot-path rule respected:
      classification runs via `waitUntil`; the current search uses token match,
      the *next* one benefits.

### W3.4 Tests + docs
- [ ] Client (fake fetch): success/JSON-parse-failure/HTTP-error degrade paths;
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
