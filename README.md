# PawScout Worker

PawScout is an embedded Shopify app that handles **supplier intelligence and inventory population** for pet stores. It connects a store to the [CJdropshipping](https://cjdropshipping.com) supplier API, applies per-store quality gates to candidate products, and maps supplier categories onto the store's collections.

This repository is the **backend half** of the Active Paw project:

| Repo | Role |
|---|---|
| [`active-paw-theme`](https://github.com/jared0565/active-paw-theme) | Shopify storefront theme (Liquid). Renders the collections and products. |
| `pawscout-worker` (**this repo**) | Cloudflare Worker: Shopify app install/auth, encrypted credential vault, merchant console, supplier configuration. |

The two halves meet at the **collection map**: the worker tags imported products (e.g. `cj-cat-pet-toys`) into the theme's collection handles (`pet-cleaning`, `pet-accessories`, `pet-health`, `pet-toys`, `more-to-love`), which the theme's sections render on the storefront.

Production URL: **https://pawscout.activepaw.co.uk** (Cloudflare custom domain route).

---

## Stack

- **Runtime:** [Cloudflare Workers](https://developers.cloudflare.com/workers/) (`nodejs_compat`)
- **Router:** [Hono](https://hono.dev)
- **Shopify:** [`@shopify/shopify-api`](https://github.com/Shopify/shopify-api-js) v11 with the `cf-worker` adapter, embedded app via App Bridge v4
- **Database:** [D1](https://developers.cloudflare.com/d1/) (SQLite), migrations in `migrations/`
- **Tests:** [Vitest](https://vitest.dev) with [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) — tests run inside workerd against an in-memory D1 with real migrations applied

## Project layout

```
src/
  index.ts              Hono app: route wiring only — logic lives in the modules below
  types.ts              Env bindings, tenant/config types, Active Paw defaults
  shopify.ts            shopifyApi() factory (embedded, offline tokens)
  vault.ts              Envelope encryption: KEK → per-tenant DEK → sealed secrets
  tenant-store.ts       The ONLY module allowed to touch D1 (enforced by a test)
  cj.ts                 CJdropshipping API-key validation
  webhooks.ts           app/uninstalled webhook registration (Admin GraphQL, idempotent)
  validate.ts           Request-body validation for the console API
  auth/
    install.ts          GET /auth — begin legacy OAuth
    callback.ts         GET /auth/callback — persist sealed token, seed config
    ensure-installed.ts Managed-install path: lazy offline-token mint via token exchange
    uninstall.ts        app/uninstalled webhook → status flip + secret purge
  console/
    page.ts             Embedded merchant console (single self-contained HTML page)
    session.ts          App Bridge session-token → shop resolution
    routes.ts           Console API handlers (status, connect-cj, gates, collections)
migrations/             D1 schema migrations
tests/                  Vitest suites (53 tests) incl. an architectural guard test
wrangler.toml           Worker config, D1 binding, public vars
```

## How it works

### Install paths (two, both supported)

1. **Managed installation** (Shopify's current default for embedded apps): Shopify installs the app *without* hitting our OAuth callback, then loads the console with a signed session token. On the first authenticated `/api/*` call, `ensureInstalled` mints an **offline access token via token exchange**, seals it, and persists it. Idempotent — a tenant that already holds a sealed token short-circuits, so it runs safely on every request.
2. **Legacy OAuth**: `GET /auth?shop=…` → Shopify consent → `GET /auth/callback` → the same `persistInstall` path seals and stores the token, then redirects into the embedded console.

Both paths converge on `persistInstall`, which also **seeds tenant config** on first install (never on reinstall, so merchant settings survive): the Active Paw store gets the pre-built collection map; any other shop starts with an empty map and default gates. `persistInstall` then **registers the `app/uninstalled` webhook** via the Admin GraphQL API (`src/webhooks.ts`) — idempotent (a duplicate subscription counts as success) and best-effort (a registration failure logs a warning but never fails the install).

### Security model

Merchant secrets (Shopify offline tokens, CJ API keys) are stored with **envelope encryption**:

```
PAWSCOUT_MASTER_KEY (KEK, Worker secret, base64 32 bytes)
        └── wraps a random per-tenant DEK  (tenants.dek_wrapped)
                └── seals each secret with AES-256-GCM, fresh IV per seal
                        ├── tenants.access_token_enc
                        └── supplier_credentials.api_key_enc
```

- Plaintext secrets never touch D1; the master key never touches the repo or `wrangler.toml`.
- **Uninstall = crypto-shredding**: the `app/uninstalled` webhook (HMAC-validated via `shopify.webhooks.validate`) empties `access_token_enc` *and* `dek_wrapped` and deletes all supplier credentials, making any residual ciphertext undecryptable.
- `/api/*` requests are authenticated with **App Bridge session tokens**: JWT signature verified by `shopify.session.decodeSessionToken`, then `console/session.ts` requires the `aud` claim to equal the app's client ID (a token *without* an `aud` claim is rejected) and the destination to be a `*.myshopify.com` host.
- Token-exchange failures are masked as a generic 401 so OAuth grant internals are never echoed to the browser.
- Console API bodies are **validated server-side** (`src/validate.ts`) before persisting: gate values must be finite numbers in sane ranges, `relevance` must be a known mode, and collection-map handles/tags must be lowercase slugs. Invalid payloads get a `400` with a specific message; unknown fields are stripped.
- **Tenant isolation is enforced architecturally**: every D1 access goes through `TenantStore`, which is constructed with a shop domain and binds it into every query. A guard test (`tests/guard.test.ts`) fails the build if any other module calls `prepare`/`exec`/`batch` directly.

### Data model (`migrations/0001_init.sql`)

| Table | Purpose |
|---|---|
| `tenants` | One row per shop: sealed offline token, wrapped DEK, granted scopes, `active`/`uninstalled` status |
| `supplier_credentials` | Sealed supplier API keys, keyed `(shop, supplier)` — currently `cj` only |
| `tenant_config` | Per-shop JSON config: `collection_map`, quality `gates`, `target` product count |

### Quality gates

Per-tenant filters applied to supplier candidates (defaults in `types.ts`):

| Gate | Default | Meaning |
|---|---|---|
| `popularityFloor` | `50` | Minimum CJ `listedNum` (how many stores list the product) |
| `priceMin` / `priceMax` | `5` / `80` | Source-price band (USD) |
| `relevance` | `title` | Keyword-match strictness: `loose` \| `title` \| `strict` |
| `target` | `16` | Products to populate per collection |

## HTTP API

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/auth` | — | Begin legacy OAuth (`?shop=x.myshopify.com`) |
| `GET` | `/auth/callback` | OAuth state | Complete OAuth, persist sealed token, redirect to `/app` |
| `GET` | `/app` | — | Embedded merchant console (App Bridge v4 page) |
| `POST` | `/api/status` | Session token | CJ connection state + current config |
| `POST` | `/api/connect-cj` | Session token | Validate a CJ API key against CJ's auth endpoint, then store it sealed |
| `POST` | `/api/gates` | Session token | Save quality gates (+ optional `target`); invalid bodies → `400` |
| `POST` | `/api/collections` | Session token | Replace the collection map; invalid bodies → `400` |
| `POST` | `/webhooks/uninstall` | Shopify HMAC | Mark tenant uninstalled, purge secrets |

The console page (`src/console/page.ts`) is deliberately a single dependency-free HTML response covering the full configuration surface: CJ connection, all four quality gates, the target count, and a collection-map editor. Notes that matter if you touch it: App Bridge is loaded **without SRI** (it's evergreen — a hash would break on Shopify's next ship); the palette is **dark-first** to match Shopify admin, with every CSS token mirrored in the light media query; and `alert()`/`confirm()` are silently blocked in the admin iframe, so all feedback must be inline DOM writes.

## Development

### Prerequisites

- Node 18+, a Cloudflare account with Wrangler access
- A Shopify Partner app (client ID is in `wrangler.toml`; the secret is not)

### Setup

```bash
npm install

# Local secrets — .dev.vars is gitignored
cat > .dev.vars <<'EOF'
SHOPIFY_API_SECRET=shpss_...
PAWSCOUT_MASTER_KEY=<base64 of 32 random bytes>   # e.g. openssl rand -base64 32
EOF

npm run migrate:local   # apply D1 migrations locally
npm run dev             # wrangler dev
```

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server (`wrangler dev`) |
| `npm test` | Run the Vitest suite inside workerd (53 tests) |
| `npm run typecheck` | `tsc --noEmit` (strict mode) |
| `npm run migrate:local` / `migrate:remote` | Apply D1 migrations |
| `npm run deploy` | Deploy to Cloudflare |

### Production secrets

Set once per environment — never in `wrangler.toml`:

```bash
wrangler secret put SHOPIFY_API_SECRET
wrangler secret put PAWSCOUT_MASTER_KEY
```

> ⚠️ `PAWSCOUT_MASTER_KEY` is the KEK for every tenant secret. Losing it orphans all sealed credentials (merchants must reinstall / reconnect); leaking it compromises them. Treat rotation as a re-encryption project, not a value swap.

### Testing notes

Tests run in real workerd via `@cloudflare/vitest-pool-workers`, with migrations from `migrations/` applied to an in-memory D1 before each suite (see `vitest.config.ts` — the base64 key there is a test-only KEK, not a secret). External boundaries (Shopify token exchange, CJ auth) are injected as function parameters, so handlers are unit-tested without network access.

## Roadmap

- Product sourcing/population itself (querying CJ, creating products, tagging into collections) is the next stage — this repo currently covers install, credential vaulting, and configuration.
