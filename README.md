# PawScout Worker - Active Paw

## What is Active Paw?

**Active Paw** ([activepaw.co.uk](https://activepaw.co.uk)) is a UK-based online pet store that sells pet accessories, toys, grooming tools, and health products. It is entirely demand-driven: the catalog is never hand-curated - it grows and shrinks automatically based on what real visitors search for and click on.

**PawScout** is the engine behind it. It is an embedded Shopify app (Cloudflare Worker) that connects the storefront to the CJdropshipping supplier catalogue, populates the search grid with quality-vetted supplier products in real time, imports them on first genuine interest, prices them automatically in GBP, and automates fulfilment end-to-end once an order is placed.

This repository is the **backend half** of the project:

| Repo | Role |
|---|---|
| [`active-paw-theme`](https://github.com/jared0565/active-paw-theme) | Shopify storefront theme (Liquid). Renders the grid, ghost cards, preview modal, and performance beacons. |
| `pawscout-worker` (**this repo**) | Cloudflare Worker: app install/auth, encrypted credential vault, merchant console, search backfill, import-on-click, pricing, catalogue lifecycle, fulfilment pipeline. |

Production URL: **https://pawscout.activepaw.co.uk** (Cloudflare custom domain route).

---

## Why it was built

Running a dropshipping store traditionally requires constant manual effort: hunting for products on the supplier's site, deciding what to list, writing descriptions, setting prices, re-checking stock, and repeating whenever a product goes out of fashion. Done manually, this either stagnates the catalogue or keeps the owner buried in admin.

Active Paw was built to eliminate that work entirely. The founding idea: **let customer demand decide what gets listed**. If visitors are searching for something, stock it automatically. If nothing sells for 30 days, archive it automatically. The owner's job is strategy and fulfilment funding - not product management.

A secondary problem was quality. General-purpose dropshipping tools pull in whatever matches a keyword, resulting in kitchen tools appearing in pet stores (it happened) and low-quality products diluting search results. PawScout applies multi-layer quality gates - price, popularity, species-relevance, AI curation, and vision-based image validation - so the catalogue stays clean without manual review.

---

## What it does

### Catalogue (zero manual listing)

- **Search backfill**: when the Shopify store's own search returns fewer than 12 results, PawScout silently augments the grid with quality-gated supplier "ghost cards" priced in GBP. The visitor sees a complete grid; the products do not exist in Shopify yet.
- **Import on first click**: clicking a ghost card opens an instant preview (served from cache - no network wait). The background import runs simultaneously: Shopify product created, priced, tagged, published. The next visitor sees a real buyable product.
- **30-day cull**: imported products with zero qualifying views or add-to-carts in 30 days are automatically archived. URLs and order history are preserved; the listing disappears from search. Renewed demand revives it - no duplicate is created.
- **Nightly replenishment**: a daily cron re-fills collections that fall below target (12 products) from the local warehouse buffer, prioritising keywords that real visitors searched for and couldn't fully satisfy.

### Quality gates (no junk, no mismatches)

- **Price and popularity floors**: supplier cost must fall in the configured band (default £4-62 landed); a minimum `listedNum` of 50 prevents listing products that the supplier barely stocks.
- **Species gate**: a "dog toy" search never surfaces cat products, enforced at every relevance-matching step.
- **AI curation** (OpenRouter): a configurable LLM model reviews each product description for pet-relevance, quality, and claim safety before import. Can be toggled off; mechanical gates take over.
- **Vision-based image vetting**: before import, a vision model reviews the image set. Images that show the wrong animal, an unrelated product, or a duplicate are dropped. A listing with no congruent image is rejected outright. The search grid self-heals: once a product has been previewed, its vetted hero image replaces CJ's raw thumbnail on future search cards.
- **Dedupe at admission**: a title fingerprint (significant tokens, order-independent) blocks duplicate products from flooding the catalogue, including minor-variation reorderings.

### Pricing (automatic, per-tenant)

Supplier cost (USD) is converted to GBP retail via a configurable multiplier (Active Paw: **2.7×**), FX rate, buffer, and minimum margin floor. The rule produces a .99-rounded price that targets ~20% net margin on cost-bound items and higher blended across the range. One console change re-prices the entire catalogue on next sync.

### Fulfilment pipeline (W-FULFIL)

When a Shopify order is paid, the worker:
1. Receives the `orders/paid` webhook, validates the order (address complete, items mapped to supplier variant IDs, not high-risk, not over £100, fully paid), and queues it with a 60-minute grace window.
2. Creates the corresponding CJ order via API, linking each line item to its exact supplier variant.
3. Polls for the tracking number and writes it back to Shopify as a fulfilment with a direct tracking URL.
4. If the CJ wallet is unfunded, the order enters `awaiting-payment`: the owner receives an email with the CJ order ID and a payment link, and tracking polling continues once the payment clears.

### Merchant console (embedded in Shopify)

A full-featured admin UI, embedded via App Bridge. What started as connection status and config controls now spans the whole operation: Overview (catalogue stats, search keywords, fill rates), Inbox (customer email with AI drafts and the answer library), Content (blog pipeline and distribution), Profitability (market judge, per-row actions, recalibrate), Campaigns (email marketing and tracking), Traffic (acquisition channel board), Orders, and Settings (gates, pricing, AI config, AI-spend ledger, fulfilment mode). No config files to edit manually.

### Customer inbox (AI-drafted, human-approved)

All mail to the store address lands in the console Inbox as categorised threads (order status, product questions, shipping, wholesale, partnerships, spam). A per-category agent drafts a reply grounded in store facts and live order/catalogue data, runs it through a self-correcting quality loop, and holds it for owner approval (auto-send exists behind per-category gates). An **answer memory** captures every approved reply and grounds similar future questions with it, so facts, policy, and voice stay consistent over time - pairs are listed in an Answer library with per-pair disable, and GDPR redaction covers them. Outbound mail is sanitised deterministically: URLs linkified into real anchors, one canonical store domain, no unsupportable claims. Delivered/opened/clicked/bounced events show per thread in the context rail.

### Profitability engine (adjust-or-drop)

A recurring agent judges every imported product against the real market. eBay Browse supplies credible delivered prices for the same item (deterministic matching, near-zero LLM cost; listings sold by Temu are excluded), and the judge compares our achievable price to the **median** credible price. Policy: at least GBP 2 net per unit after fees - verdicts are pass, reprice (just under market), or drop (archive, never delete). Owner brakes: a Preview mode that reports without acting, durable per-product Keep/Release overrides, a "Wrong match" marker that forces cost-plus re-judging when the matched competitor is a different item, and a "Recalibrate & rescue" sweep that re-judges all archived drops after a policy change and un-archives whatever now passes. An AI-spend daily ledger in Settings shows what the LLM layer costs.

### Blog content system + distribution

The worker authors research-grounded buying guides as Shopify **draft** articles: briefs start from real web demand, facts are web-verified, every post carries a quick answer, a visible FAQ backed by FAQPage schema, a congruence-vetted hero image, and a "Shop this guide" product block. The owner publishes; status syncs back automatically. A distribution rail (Blotato: Pinterest, Facebook, Instagram) builds gated creative packs per post with a per-channel ledger and a double-post fence - dormant until a channel is toggled on.

### Email campaigns + engagement

Consented-buyer campaigns (compliance footer, one-click unsubscribe) send through Resend. A signed webhook stores delivery/open/click/bounce events, domain-level open/click tracking is enabled and re-verified through the console, and engagement is visible per campaign and per inbox thread.

### Traffic board

A console card tracks acquisition channels (Google Shopping feed, SEO, email, partner/affiliate trial, short-video) with status, rationale, and next action per channel - the demand-side operating plan, kept where the data lives.

---

## How it became helpful

The project started as a basic search backfill - pad the grid when the store runs short. The improvements that made it genuinely useful came from real problems observed in production:

1. **"Non-pet products slipping in"** - a kitchen knife sharpener appeared in search results during an LLM outage because mechanical gates had no pet-relevance check. Fixed with `isLikelyPetProduct`: explicit pet tokens always admit; clear non-pet markers (kitchen, pruning, hairdressing) always reject. The LLM tightens further when available.

2. **"Cat on a dog listing"** - a supplier's search thumbnail (`productImage`) and detail gallery (`productImageSet`) are independent fields, set separately by the supplier. The search card showed a cat; the product detail showed a dog. Fixed with vision-based image vetting: the model identifies incongruent images; they are removed from Shopify and the grid self-heals on next search after the first preview is cached.

3. **"Duplicate flooding"** - the same product listed under subtly different titles would pass the deduplication check and create near-identical listings. Fixed with `titleSignature`: a sorted, stopword-stripped token fingerprint that collapses reorderings ("Pet Teeth Cleaning Powder 100g" = "Teeth Cleaning Powder for Pets 100g") while keeping genuinely distinct items distinct.

4. **"Category drift"** - dental products filed under toys, tug balls filed under health. Fixed with `signaledCategory`: a keyword-signal map re-files a product only when its title unambiguously points to a different collection, so it never overrides a reasonable LLM placement.

5. **"54% of orders would have errored"** - during fulfilment testing, only 32 of 69 imported products had a local warehouse row, and the fulfilment resolver read the supplier variant ID from there. The rest would have silently failed. Fixed with a live `cj.detail()` fallback: when the warehouse row is missing, the resolver fetches the variant ID from the supplier API in real time.

The running test suite (all of it runs inside a real Cloudflare `workerd` runtime against in-memory D1) catches regressions from all of the above.

---

## Sample use case

**Scenario:** A visitor on activepaw.co.uk searches "dog rope toy".

1. Shopify's native search finds 7 matching products - not enough to fill the 12-product grid cap.
2. The theme calls `/apps/pawscout/search?q=dog+rope+toy&have=7&limit=5`.
3. PawScout checks its local warehouse buffer first (zero CJ calls). It finds 3 matching gated products and adds them as ghost cards (priced in GBP, no Shopify product yet).
4. Still 2 short - PawScout falls back to a cached CJ search (or fetches live and caches 30 days). It finds 15 results; quality gates reduce them to 4 valid items. The best 2 are added as ghost cards. Grid is full.
5. The visitor sees 12 products. 5 of them are ghost cards with prices and images but no buy button.
6. The visitor clicks a ghost card - "Braided Rope Chew Toy for Dogs, 3-pack". The preview modal opens instantly from cached supplier data.
7. PawScout fires a background import: creates the Shopify product, uploads the vetted images, sets the GBP price (e.g. £12.99 on a £4.80 supplier cost), publishes it, and tags it `cj-pet-toys`. The modal CTA flips from "View details" to "Add to cart" within seconds.
8. The next visitor searching "rope dog toy" sees the real product page.
9. At 4:17 AM the next day, the daily cron logs that "dog rope toy" was searched 11 times yesterday with 5 ghost impressions. It replenishes the `pet-toys` collection to 12 products from the top-scoring warehouse candidates.
10. When the visitor's order is paid, the worker receives the `orders/paid` webhook, waits 60 minutes (grace window), then creates a CJ order for £4.80. Once CJ ships, the tracking number is written back to Shopify and the buyer receives the standard Shopify shipping notification with a direct tracking link.

---

## The search flywheel

The goal: a visitor searching the store always sees up to **12 sellable products** (the grid display cap - never padded with weak matches), and the inventory self-optimizes over time.

```
Visitor searches ─→ store answers from its own catalog
                      │
                      ├─ ≥12 results → done
                      │
                      └─ <12 → theme calls /apps/pawscout/search (App Proxy)
                                 │
                                 PS: cached CJ search (30d) → quality gates →
                                 pricing rule → dedupe vs imported → ghost cards
                                 │
            visitor clicks ghost → instant PREVIEW from cached data
                                 │  (this view is the qualifying signal)
                                 └→ background import: Shopify product created,
                                    priced, tagged, published → CTA flips to
                                    the real PDP → normal checkout
```

Products that never reach a preview are **never imported** - no catalog pollution. Imported products live or die by performance:

- **Beacons**: the theme sends JS-only `view` / `atc` signals for imported products (JS-only filters most crawlers).
- **30-day cull** (daily cron): imported products with **zero qualifying events in 30 days** are **archived** (never deleted - order history and URLs stay intact), with a 30-day grace period from import. Fresh search demand can revive an archived product (it's re-activated, not duplicated).
- **Warehouse** (W1): a PS-local buffer of ≥20 gated, in-stock products per category (`floors.warehouseDepth`), replenished nightly - demand keywords first. Searches and previews serve from it with **zero CJ calls**; the only CJ call near the request path is a live stock confirmation before import (`floors.stockFloor`, default 10 units - never list what CJ can't fulfil).
- **Refill** (daily cron, capped per run): imports top gated CJ products for the most-searched **under-served keywords** (logged from real searches), then tops up mapped collections below `target`.
- **Retention**: cached CJ data and unrefreshed warehouse rows are purged after 30 days - the PS storage promise, enforced in code.

## Stack

- **Runtime:** [Cloudflare Workers](https://developers.cloudflare.com/workers/) (`nodejs_compat`) + cron triggers
- **Router:** [Hono](https://hono.dev)
- **Shopify:** [`@shopify/shopify-api`](https://github.com/Shopify/shopify-api-js) v11 (cf-worker adapter), App Bridge v4, Admin GraphQL, App Proxy
- **Database:** [D1](https://developers.cloudflare.com/d1/) (SQLite), migrations in `migrations/`
- **Tests:** [Vitest](https://vitest.dev) with [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) - the suites run inside workerd against an in-memory D1 with real migrations

## Project layout

```
src/
  index.ts              Hono app + scheduled handler: route wiring only
  types.ts              Env bindings, tenant/config types, defaults (gates, pricing, target)
  shopify.ts            shopifyApi() factory (embedded, offline tokens)
  shopify-admin.ts      Minimal Admin GraphQL caller (shop + offline token)
  vault.ts              Envelope encryption: KEK → per-tenant DEK → sealed secrets
  tenant-store.ts       The ONLY module allowed to touch D1 (enforced by a test)
  cj.ts                 CJ client: cached token manager + product search/detail
  pricing.ts            Landed USD cost → GBP retail (multiplier, floor, min margin, FX, .99)
  validate.ts           Request-body validation for the console API
  webhooks.ts           app/uninstalled webhook registration (idempotent)
  jobs.ts               Daily crons: retention purge, performance cull, demand refill
  market.ts             eBay Browse competitor pricing (zero-LLM credible-price matching)
  profitability.ts      Adjust-or-drop judge: median-market policy, reprice/drop verdicts
  profit-console.ts     Profit console actions incl. the recalibrate & rescue sweep
  campaigns.ts          Consented-buyer email campaigns
  resend-events.ts      Resend webhook -> email_events (delivered/opened/clicked/bounced)
  traffic.ts            Traffic board: acquisition channels, status, next actions
  debrand.ts            Maker-brand removal on all customer-facing text
  auth/                 OAuth begin/callback, managed-install token exchange, uninstall
  console/              Embedded merchant console (page, views, per-view browser JS)
  inbox/                Customer email: ingest, category agents, drafts, quality loop,
                        answer memory, gates, auto-send, invoices, partnerships
  blog/                 Guide authoring: research, brief, draft, ground, hero vetting,
                        combo merchandising, quality, publish-status sync
  syndicate/            Blog distribution rail (Blotato), creative packs, ledger, fences
  shipping/             Nearest-warehouse shipping formula, market catalogs/exclusion
  proxy/
    verify.ts           Shopify App Proxy HMAC verification (constant-time, replay window)
    search.ts           Search backfill: cache → gates → pricing → dedupe → ghost cards
    import.ts           Preview builder + import-on-click (productSet, publish, revive)
migrations/             D1 schema migrations
tests/                  Vitest suites incl. an architectural guard test
wrangler.toml           Worker config, D1 binding, cron trigger, public vars
```

## How it works

### Install paths (two, both supported)

1. **Managed installation**: Shopify installs without the OAuth callback; on the first authenticated `/api/*` call, `ensureInstalled` mints an offline token via **token exchange** and persists it. Idempotent.
2. **Legacy OAuth**: `GET /auth?shop=…` → consent → `GET /auth/callback`.

Both converge on `persistInstall`: seals the token, seeds tenant config on first install only (Active Paw gets the pre-built collection map), and registers the `app/uninstalled` webhook (idempotent, best-effort).

### Security model

Merchant secrets (Shopify offline tokens, CJ API keys, cached CJ access tokens) use **envelope encryption**:

```
PAWSCOUT_MASTER_KEY (KEK, Worker secret, base64 32 bytes)
        └── wraps a random per-tenant DEK  (tenants.dek_wrapped)
                └── seals each secret with AES-256-GCM, fresh IV per seal
```

- Plaintext secrets never touch D1; the master key never touches the repo.
- **Uninstall = crypto-shredding**: HMAC-validated webhook empties the sealed token *and* the wrapped DEK, and deletes supplier credentials + cached CJ tokens.
- **Console** (`/api/*`): App Bridge session tokens - signature verified, `aud` must equal the client ID (missing `aud` is rejected), `*.myshopify.com` destination enforced.
- **Storefront** (`/proxy/*`): Shopify **App Proxy** HMAC signatures verified with constant-time comparison and a replay window; the worker is never called cross-origin by the browser.
- All console bodies are validated server-side (`validate.ts`); invalid payloads get `400`, unknown fields are stripped. CJ description HTML is stripped before it can reach a storefront preview.
- **Tenant isolation enforced architecturally**: only `tenant-store.ts` may touch D1; a guard test fails the build otherwise.

### Pricing rule (`pricing.ts`)

Landed USD supplier cost → GBP retail: `cost × fx × (1 + buffer) × multiplier`, with a hard multiplier **floor**, an absolute **minimum margin**, and `.99` rounding (always up, never below the computed price).

Defaults target **~17% net margin** under the researched cost stack - ads ~33% of revenue (ROAS 3, the conservative case), payments ~2.5%, FX ~1.5%, refunds ~3%, fixed ~2%:

| Field | Default | |
|---|---|---|
| `multiplier` | `2.5` | ~60% gross → ~17% net at ROAS 3; ~30% net if ads hit the 20% goal |
| `floor` | `2.2` | below this you're working for the ad platform |
| `minMarginGbp` | `6` | protects low-ticket items from fixed fees + CPC |
| `fxUsdToGbp` | `0.78` | configured rate (console-editable) |
| `fxBufferPct` | `2` | safety on conversion |

Sales arriving through the on-site search flywheel carry near-zero acquisition cost and net far better than the model assumes. All values are per-tenant config, editable in the console.

### Quality gates

| Gate | Default | Meaning |
|---|---|---|
| `popularityFloor` | `50` | Minimum CJ `listedNum` |
| `priceMin` / `priceMax` | `5` / `80` | Source-cost band (USD) |
| `relevance` | `title` | `loose` \| `title` (any keyword token in title) \| `strict` (all tokens) |
| `target` | `12` | Products per collection AND the storefront grid display cap |

### Data model (`migrations/`)

| Table | Purpose |
|---|---|
| `tenants` | Sealed offline token, wrapped DEK, scopes, status |
| `supplier_credentials` | Sealed supplier API keys (`cj`) |
| `tenant_config` | Per-shop JSON: collection map, gates, pricing, target |
| `warehouse_products` | **W1**: PS-local buffer - ≥20 gated, in-stock, fully-detailed products per category; searches/previews serve from here with zero CJ calls |
| `search_cache` | CJ search/detail payloads per normalized keyword - 30-day TTL |
| `search_log` | Demand signal: keyword, store hits, ghost hits per search |
| `product_links` | CJ pid ↔ Shopify product: `ghost → importing → imported ⇄ archived / failed` |
| `product_events` | Qualifying events (`view`/`atc`/`order`) for the cull |
| `cj_tokens` | Sealed cached CJ access token (CJ allows ~1 auth refresh per 300s) |
| `llm_usage` | **W3**: per-call OpenRouter tokens + cost (curation/keyword tasks), 90-day retention |
| `orders` | Fulfilment queue: Shopify order → CJ order mapping, status, shipping address |

## HTTP API

### Merchant console (App Bridge session token)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/status` | CJ connection + full config |
| `POST` | `/api/insights` | Top search keywords + fill rates, last 30 days |
| `POST` | `/api/connect-cj` | Validate + store a sealed CJ key |
| `POST` | `/api/gates` | Save gates (+ optional `target`); invalid → `400` |
| `POST` | `/api/pricing` | Save the pricing rule; invalid → `400` |
| `POST` | `/api/llm` | Save the AI-curation config (OpenRouter model, threshold, on/off) |
| `POST` | `/api/collections` | Replace the collection map; invalid → `400` |
| `POST` | `/api/categories` | Re-file products to the collection their title signals (LLM-free) |
| `POST` | `/api/descriptions` | Sweep: rewrite raw-CJ descriptions with the LLM (claim-safe) |
| `POST` | `/api/images` | Sweep: delete incongruent images + promote hero (vision-vetted) |
| `POST` | `/api/orders` | Current order queue state + fulfilment config |
| `POST` | `/api/fulfil` | Set fulfilment mode / createOnly / alertEmail |
| `POST` | `/api/order-action` | Manual hold / release / cancel for a queued order |
| `POST` | `/api/fulfil-run` | On-demand fulfilment pipeline run (no cron wait) |
| `POST` | `/api/test-email` | Send a test alert email to the configured address |

The table above is the original core. The console API has since grown along with the console itself - inbox (threads, drafts, approve/send, answer library), blog content + syndication, profitability (judge, keep/release, wrong-match, recalibrate), campaigns + email-tracking setup, traffic board, and AI-spend routes all follow the same session-token pattern; `src/index.ts` is the single routing map.

### Storefront (Shopify App Proxy, HMAC-signed)

| Method | Path | Description |
|---|---|---|
| `GET` | `/proxy/search?q=&have=&limit=` | Gated, priced, deduped ghost cards for a keyword |
| `GET` | `/proxy/product?pid=` | Instant preview + qualifying view + background import |
| `GET` | `/proxy/import-status?pid=` | `{state, url}` - the theme polls this to flip the CTA |
| `POST` | `/proxy/event` | `{pid, event: view\|atc}` performance beacons |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/auth`, `/auth/callback` | Legacy OAuth |
| `GET` | `/app` | Embedded merchant console |
| `POST` | `/webhooks/uninstall` | HMAC-validated; marks uninstalled + purges secrets |
| `POST` | `/webhooks/orders-paid` | Order paid → validate → queue (60-min grace) |
| cron | `17 4 * * *` daily | Retention purge → cull → refill (capped, CJ-rate-paced) |
| cron | `*/15 * * * *` every 15 min | Fulfilment pipeline, inbox sweep (ingest + draft), profit agent, blog pipeline + distribution stages |

## Development

```bash
npm install
cat > .dev.vars <<'EOF'
SHOPIFY_API_SECRET=shpss_...
PAWSCOUT_MASTER_KEY=<base64 of 32 random bytes>   # openssl rand -base64 32
EOF
npm run migrate:local
npm run dev
```

| Command | What it does |
|---|---|
| `npm test` | 262 tests inside workerd |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run migrate:local` / `migrate:remote` | Apply D1 migrations |
| `npm run deploy` | Deploy to Cloudflare |

### Production secrets

```bash
wrangler secret put SHOPIFY_API_SECRET
wrangler secret put PAWSCOUT_MASTER_KEY
wrangler secret put RESEND_API_KEY        # optional - owner alert emails for awaiting-payment orders
```

> ⚠️ `PAWSCOUT_MASTER_KEY` is the KEK for every tenant secret. Losing it orphans all sealed credentials; leaking it compromises them.

### One-time Shopify setup (Partner Dashboard)

The storefront integration requires the **App Proxy** to be configured on the app:

- **Subpath prefix:** `apps` · **Subpath:** `pawscout`
- **Proxy URL:** `https://pawscout.activepaw.co.uk/proxy`

The theme then calls `/apps/pawscout/*` on the store's own domain and Shopify signs + forwards to the worker. Without this, ghost backfill, previews, and beacons no-op (the theme degrades gracefully).

### Deploying

1. `npm run migrate:remote` (runs all pending D1 migrations)
2. `npm run deploy` (deploys the worker + registers cron triggers)
3. Configure the App Proxy (above) if not already set
4. Ship the theme half (`active-paw-theme`: `pawscout.js`, search/product/layout wiring)

### Testing notes

Tests run in real workerd via `@cloudflare/vitest-pool-workers` with migrations applied to in-memory D1. External boundaries (Shopify Admin GraphQL, CJ API, token exchange) are injected as functions or fake `fetch` implementations - no network in tests. Cron logic is tested with backdated rows written directly by tests (production code still goes through `TenantStore` only, enforced by the guard test).

## Roadmap

**The active task list is [`docs/TASKS.md`](docs/TASKS.md)** (what's next, in priority order) and the full technical plan is [`docs/WAREHOUSE_PLAN.md`](docs/WAREHOUSE_PLAN.md).

Current status (July 2026):

- Store **live and taking orders**: catalogue, fulfilment, and pricing pipelines all in production; protected-customer-data scopes granted.
- Customer inbox live in human-approval mode, with answer-memory grounding on every draft.
- Profitability engine live full-auto: eBay median-market judging (Temu excluded) with owner brakes (Preview, Keep/Release, Wrong match, Recalibrate & rescue).
- Blog channel live (worker drafts, owner publishes); distribution rail built and dormant pending channel enables.
- Email campaigns live with verified open/click tracking and per-thread engagement.
- Google stack connected under one account (2026-07-12): Merchant Center feed syncing, Search Console verified + sitemap submitted, GA4 wired via the Shopify channel app.

Next up:

- Publish new imports to the Google channel automatically at import time (imports currently publish to Online Store only).
- Blog distribution phase 1 enablement (Blotato key + channel toggles), then phases 2-3 (composed creatives, digest/partner packs).
- **W6** - automated CJ damage/claims pipeline.
- **W4** - weekly intelligence digest.
- Per-category pricing multipliers; automated FX rate refresh.
