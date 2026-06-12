# PawScout Worker

PawScout is an embedded Shopify app that handles **supplier intelligence and demand-driven inventory population** for pet stores. It connects a store to the [CJdropshipping](https://cjdropshipping.com) supplier API, backfills storefront searches with quality-gated supplier products, imports them on demand, and continuously optimizes the catalog around what visitors actually view and buy.

This repository is the **backend half** of the Active Paw project:

| Repo | Role |
|---|---|
| [`active-paw-theme`](https://github.com/jared0565/active-paw-theme) | Shopify storefront theme (Liquid). Renders the grid, ghost cards, preview modal, and beacons. |
| `pawscout-worker` (**this repo**) | Cloudflare Worker: app install/auth, encrypted credential vault, merchant console, search backfill, import-on-click, pricing, lifecycle crons. |

Production URL: **https://pawscout.activepaw.co.uk** (Cloudflare custom domain route).

---

## The search flywheel

The goal: a visitor searching the store always sees up to **12 sellable products** (the grid display cap — never padded with weak matches), and the inventory self-optimizes over time.

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

Products that never reach a preview are **never imported** — no catalog pollution. Imported products live or die by performance:

- **Beacons**: the theme sends JS-only `view` / `atc` signals for imported products (JS-only filters most crawlers).
- **30-day cull** (daily cron): imported products with **zero qualifying events in 30 days** are **archived** (never deleted — order history and URLs stay intact), with a 30-day grace period from import. Fresh search demand can revive an archived product (it's re-activated, not duplicated).
- **Warehouse** (W1): a PS-local buffer of ≥20 gated, in-stock products per category (`floors.warehouseDepth`), replenished nightly — demand keywords first. Searches and previews serve from it with **zero CJ calls**; the only CJ call near the request path is a live stock confirmation before import (`floors.stockFloor`, default 10 units — never list what CJ can't fulfil).
- **Refill** (daily cron, capped per run): imports top gated CJ products for the most-searched **under-served keywords** (logged from real searches), then tops up mapped collections below `target`.
- **Retention**: cached CJ data and unrefreshed warehouse rows are purged after 30 days — the PS storage promise, enforced in code.

## Stack

- **Runtime:** [Cloudflare Workers](https://developers.cloudflare.com/workers/) (`nodejs_compat`) + cron triggers
- **Router:** [Hono](https://hono.dev)
- **Shopify:** [`@shopify/shopify-api`](https://github.com/Shopify/shopify-api-js) v11 (cf-worker adapter), App Bridge v4, Admin GraphQL, App Proxy
- **Database:** [D1](https://developers.cloudflare.com/d1/) (SQLite), migrations in `migrations/`
- **Tests:** [Vitest](https://vitest.dev) with [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) — 95 tests run inside workerd against an in-memory D1 with real migrations

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
  auth/                 OAuth begin/callback, managed-install token exchange, uninstall
  console/              Embedded merchant console (page, session, API handlers)
  proxy/
    verify.ts           Shopify App Proxy HMAC verification (constant-time, replay window)
    search.ts           Search backfill: cache → gates → pricing → dedupe → ghost cards
    import.ts           Preview builder + import-on-click (productSet, publish, revive)
migrations/             D1 schema migrations
tests/                  Vitest suites (95 tests) incl. an architectural guard test
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
- **Console** (`/api/*`): App Bridge session tokens — signature verified, `aud` must equal the client ID (missing `aud` is rejected), `*.myshopify.com` destination enforced.
- **Storefront** (`/proxy/*`): Shopify **App Proxy** HMAC signatures verified with constant-time comparison and a replay window; the worker is never called cross-origin by the browser.
- All console bodies are validated server-side (`validate.ts`); invalid payloads get `400`, unknown fields are stripped. CJ description HTML is stripped before it can reach a storefront preview.
- **Tenant isolation enforced architecturally**: only `tenant-store.ts` may touch D1; a guard test fails the build otherwise.

### Pricing rule (`pricing.ts`)

Landed USD supplier cost → GBP retail: `cost × fx × (1 + buffer) × multiplier`, with a hard multiplier **floor**, an absolute **minimum margin**, and `.99` rounding (always up, never below the computed price).

Defaults target **~17% net margin** under the researched cost stack — ads ~33% of revenue (ROAS 3, the conservative case), payments ~2.5%, FX ~1.5%, refunds ~3%, fixed ~2%:

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
| `warehouse_products` | **W1**: PS-local buffer — ≥20 gated, in-stock, fully-detailed products per category; searches/previews serve from here with zero CJ calls |
| `search_cache` | CJ search/detail payloads per normalized keyword — 30-day TTL |
| `search_log` | Demand signal: keyword, store hits, ghost hits per search |
| `product_links` | CJ pid ↔ Shopify product: `ghost → importing → imported ⇄ archived / failed` |
| `product_events` | Qualifying events (`view`/`atc`/`order`) for the cull |
| `cj_tokens` | Sealed cached CJ access token (CJ allows ~1 auth refresh per 300s) |
| `llm_usage` | **W3**: per-call OpenRouter tokens + cost (curation/keyword tasks), 90-day retention |

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

### Storefront (Shopify App Proxy, HMAC-signed)

| Method | Path | Description |
|---|---|---|
| `GET` | `/proxy/search?q=&have=&limit=` | Gated, priced, deduped ghost cards for a keyword |
| `GET` | `/proxy/product?pid=` | Instant preview + records the qualifying view + starts background import |
| `GET` | `/proxy/import-status?pid=` | `{state, url}` — the theme polls this to flip the CTA |
| `POST` | `/proxy/event` | `{pid, event: view\|atc}` performance beacons |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/auth`, `/auth/callback` | Legacy OAuth |
| `GET` | `/app` | Embedded merchant console |
| `POST` | `/webhooks/uninstall` | HMAC-validated; marks uninstalled + purges secrets |
| cron | `17 4 * * *` daily | Retention purge → cull → refill (capped, CJ-rate-paced) |

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
| `npm test` | 95 tests inside workerd |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run migrate:local` / `migrate:remote` | Apply D1 migrations |
| `npm run deploy` | Deploy to Cloudflare |

### Production secrets

```bash
wrangler secret put SHOPIFY_API_SECRET
wrangler secret put PAWSCOUT_MASTER_KEY
```

> ⚠️ `PAWSCOUT_MASTER_KEY` is the KEK for every tenant secret. Losing it orphans all sealed credentials; leaking it compromises them.

### One-time Shopify setup (Partner Dashboard)

The storefront integration requires the **App Proxy** to be configured on the app:

- **Subpath prefix:** `apps` · **Subpath:** `pawscout`
- **Proxy URL:** `https://pawscout.activepaw.co.uk/proxy`

The theme then calls `/apps/pawscout/*` on the store's own domain and Shopify signs + forwards to the worker. Without this, ghost backfill, previews, and beacons no-op (the theme degrades gracefully).

### Deploying the flywheel

1. `npm run migrate:remote` (applies `0002_flywheel.sql`)
2. `npm run deploy` (registers the cron trigger)
3. Configure the App Proxy (above)
4. Ship the theme half (`active-paw-theme`: `pawscout.js`, search/product/layout wiring)

### Testing notes

Tests run in real workerd via `@cloudflare/vitest-pool-workers` with migrations applied to in-memory D1. External boundaries (Shopify Admin GraphQL, CJ API, token exchange) are injected as functions or fake `fetch` implementations — no network in tests. Cron logic is tested with backdated rows written directly by tests (production code still goes through `TenantStore` only, enforced by the guard test).

## Roadmap

**The active plan is [`docs/WAREHOUSE_PLAN.md`](docs/WAREHOUSE_PLAN.md)** — the W1–W4
warehouse evolution (PS-local product buffer, store floor + CJ→Shopify stock sync,
LLM curation via OpenRouter, weekly intelligence digest), written to be resumable
by any developer. Items below are post-W4:

- **Orders webhook** (`orders/create`) as a stronger qualifying signal than add-to-cart — needs Shopify protected-customer-data approval, so ATC beacons stand in for now.
- **Per-category pricing multipliers** (commodity vs problem-solver products).
- **Automated FX rate refresh** (currently a console-configured value).
