# Active Paw / PawScout - Handover Brief

A cold-start orientation for whoever picks this up next. Detailed checklist lives
in `TASKS.md`; rationale and design notes in `WAREHOUSE_PLAN.md`. This brief is the
map: what the system is, what's live, what's blocking launch, and what to touch first.

**Prepared:** 2026-06-17 · **Active branch (both repos):** `claude/stoic-pasteur-a2ol7z`

---

## 1. What this is

**Active Paw** (activepaw.co.uk) is a UK Shopify pet store dropshipped from
**CJdropshipping (CJ)**. It runs on two repos:

| Repo | Role | Runs on | Deploy |
|------|------|---------|--------|
| `jared0565/active-paw-theme` | Liquid storefront (search backfill, import-on-click, beacons) | **Shopify** | Manual - sync to Shopify theme |
| `jared0565/pawscout-worker` | **PawScout** - Cloudflare Worker backend (CJ proxy, catalogue pipeline, fulfilment, merchant console) | **Cloudflare Workers** (worker name `pawscout-worker`) | `npm run deploy` (wrangler) |

There is **no CI/CD** - both deploy manually. GitHub is version control only.

**PawScout** does: catalogue search/import from CJ, quality gates (vision image
vetting, pet-relevance, dedupe, category filing), pricing (locked **2.7×**),
inventory sync, and an order→CJ fulfilment pipeline. The merchant **console** (App
Bridge, session-token authed `/api/*`) is the operator cockpit.

## 2. Current deployment state

- **Worker:** `pawscout-worker` is live on Cloudflare. Latest backend work is on
  branch `claude/stoic-pasteur-a2ol7z` (HEAD `cb5f0d5`). **A redeploy is needed**
  to pick up the freight-quote tool + searchable country/quantity card (see §5).
- **Theme:** deployed to Shopify manually; latest README/search fixes are on the
  branch. Confirm live state in Shopify admin → Online Store → Themes.
- **Tests:** 264 passing; `npm run typecheck` clean.
- **Store status:** checkout is **not yet re-enabled** (pricing now locked, so this
  is unblocked - see §4).

### Deploy / operate commands (in `pawscout-worker/`)
```
npm run typecheck        # tsc --noEmit
npm test                 # vitest (264 tests)
npm run deploy           # wrangler deploy  (push code live)
npm run migrate:remote   # apply new D1 migrations to prod (only when migrations added)
```

## 3. Architecture & key facts

- **Stack:** Cloudflare Workers + Hono, D1 (SQLite), cron triggers; Shopify Admin
  API **2025-07** (`LATEST_API_VERSION`); CJ API.
- **Multi-tenant:** config + sealed supplier credentials live per-tenant in D1
  (`tenant_config`, sealed CJ key). The code is white-label-capable (Active Paw is
  tenant #1).
- **Fulfilment** (`src/fulfil.ts`, `src/fulfil-run.ts`): `orders/paid` webhook →
  guardrail validation → queue → `processDueOrders` creates a CJ order (one origin
  per order; `chooseOrigin` prefers a GB warehouse above the stock floor, else best-
  stocked, else CN) → `payBalance` → tracking written back to Shopify.
  **AP live config:** `{"mode":"pawscout","createOnly":true}` - PS creates the CJ
  order and stops at **`awaiting-payment`**; the owner pays it manually in CJ until
  the wallet is funded. Owner gets a one-time Resend email per awaiting-payment order.
- **Shipping:** checkout uses a **flat/zone rate** (does not scale per item).
  CJ charges **real freight** that scales with items + weight. Products have **no
  weight set** yet, so weight-based tiers / live carrier rates aren't possible until
  that's backfilled. The console **Shipping quote (CJ)** card surfaces CJ's real
  freight per destination + quantity (read-only).

### Secrets - handle with care
- **`PAWSCOUT_MASTER_KEY`** - the KEK for every tenant's sealed secrets. Losing it
  orphans all credentials; leaking it compromises them. Cloudflare Worker secret.
- **`RESEND_API_KEY`** - owner-alert email. Worker secret; never log or forward it
  anywhere except Resend's API.
- **CJ API key** - sealed in D1 per-tenant (not the CJ Shopify *app*). PS uses the
  API key, so uninstalling CJ's Shopify app does not break search/import/fulfilment.

## 4. Launch blockers (need YOU - human action / decision)

1. **Fund the CJ wallet** - hard blocker for paid fulfilment. Wire min ($2000) too
   high; Payoneer dropped. Path: **PayPal top-up via CJ support** (drafted request
   in `TASKS.md` §4b). Until funded, AP runs `createOnly` (create + pay manually).
2. **Re-enable checkout** - pricing is locked (2.7×). Steps: run *Sync now* to lock
   live prices → Settings → Payments → activate provider → remove store password.
3. **Protected customer data approval** (Shopify app config) - without it the order
   address is redacted and orders can't be fulfilled. Also add `read_orders` +
   `write_merchant_managed_fulfillment_orders` scopes, then re-mint the token.
4. **UK compliance** - cookie-consent banner (PECR/GDPR), reCAPTCHA on the contact
   form, set a shop phone number (else privacy policy renders a blank phone line).
5. **Uninstall the CJ Shopify app** so CJ stops auto-importing orders (PS becomes
   the sole bridge in `pawscout` mode). Safe - PS uses the API key, not the app.

## 5. Immediate PS next steps (agent can do)

- **Redeploy the worker** (`npm run deploy`) to make live: the **freight-quote**
  tool, the **searchable country combobox**, and the **quantity** field on the
  Shipping quote card (commits `e5afe9f` → `cb5f0d5`).
- **Run the "Fix default images" sweep** in the console after deploy - re-vets the
  69 live products under the v2 image rules (drops incongruent images, promotes the
  on-title hero). Then verify D1 `hero_sig` + spot-check.
- **Run "Rewrite legacy descriptions"** sweep (pairs with the above) and verify
  `llm_usage`.

## 6. Watch items / known gaps

- **Fulfilment freight estimate samples only line-item #1 at qty 1** to pick the
  shipping *method* (`freightEstimate(products[0].vid, origin)` in `fulfil-run.ts`).
  CJ still bills the full basket at order creation, but the *method choice* is based
  on one representative item. Candidate follow-up: quote the whole basket.
- **Single origin per order** - a multi-warehouse basket is forced to ship from one
  origin (`// last wins`); can be suboptimal or fail if stock isn't co-located.
- **Shipping margin** - flat checkout rate over-covers light single items, under-
  covers heavy/multi-item baskets. Fixed properly only once product **weight** is
  set at import + backfilled (then weight-based tiers, free on all Shopify plans).
- **API-version debt** - when `@shopify/shopify-api` bumps to 2026-04+, swap
  `ignoreCompareQuantity` for per-quantity `changeFromQuantity: null` in
  `src/proxy/inventory.ts` (do NOT change standalone on 2025-07). See `TASKS.md` §5b.
- **Inbound scam pitches** - the store email is on a cold-pitch/fraud list
  ("generate N sales", commission offers, BDT/Taka). Don't reply; filter to spam;
  reCAPTCHA on the contact form will reduce the inflow.

## 7. Where to look

- `TASKS.md` - prioritized, granular checklist (PS vs You ownership).
- `WAREHOUSE_PLAN.md` - design rationale + admin links (Shopify Dev Dashboard app
  config lives here).
- `SECURITY.md`, `LEGAL_NOTICE.md`, shop-policy docs - compliance.
- Console (Shopify admin → Apps → PawScout): the live operator surface - sync,
  fulfilment modes, maintenance sweeps, shipping quote, search diagnostics.
