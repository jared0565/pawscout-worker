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
- [x] Live shop popularityFloor set to 1 (2026-06-12, via D1 — verify the
      console's Save-gates path works while building W1's console changes).
- [x] **Flywheel verified end-to-end 2026-06-12**: 8 gated, priced ghost
      products returned from cache. Pre-W1 checklist CLOSED.
- [x] Theme MERGED to `shopify-deploy` 2026-06-12 (5e8952d → 9f47311) — ghost
      cards, preview modal, and beacons are live to visitors.

**Store state changes (2026-06-12, via Shopify MCP):**

- Checkout/payments DISABLED by the user until the pricing strategy is final —
  re-enable before any ad spend. Views/ATC signals unaffected.
- New smart collection **Pet Grooming** (`pet-grooming`, tag
  `cj-cat-pet-grooming`), added to the PawScout collection map; 11 existing
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
- [ ] **Sync should activate inventory tracking on untracked variants**
      (inventoryItemUpdate tracked:true before inventorySetQuantities) —
      ghost-click imports whose CJ detail lacked stock import untracked and
      the sync currently skips them with an error log.
- [x] Scissors hunt outcome: razor grooming comb imported via ghost-click
      pipeline (pid 2029158917514293249, £13.99, pet-grooming); nail shears
      pid 2007377705492574210 refused by the live stock floor (working as
      designed).

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

**Implementation queue once the user confirms:** (i) PDP delivery block in
theme; (ii) freight-aware margin floor + origin preference + "Ships from
UK" badge (supersedes the § 7a freight item's price-in wording);
(iii) remove Express rate (Shopify admin or GraphQL, needs user OK);
(iv) write the Returns & Refunds policy page.

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

Phase 2 (W6 candidate — PawScout returns portal):
- [ ] `/proxy/return` page (App Proxy HMAC, 200+ok rule): buyer picks
      claim type, uploads against a per-type checklist.
- [ ] LLM vision gate via OpenRouter (existing LlmClient + key): label
      legible? packaging shown? photographed product matches our catalog
      image for that SKU (doubles as fraud screen)? Instant "retake
      showing X" instead of support round-trips.
- [ ] Storage: R2 bucket for evidence bundles; deadline computed from
      delivery date; console card lists open claims + days remaining.
- [ ] Output: CJ-ready evidence bundle so filing is copy-paste.

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
