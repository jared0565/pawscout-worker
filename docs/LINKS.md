# Links & Identifiers — Active Paw / PawScout

Stop re-hunting. Canonical IDs and the dashboard/admin URLs we keep needing.
(`✓` = confirmed working; `?` = best-guess slug, verify and update.)

## Identifiers
- Store domain: `4qkudm-ez.myshopify.com` · storefront: `activepaw.co.uk`
- Worker domain: `pawscout.activepaw.co.uk` (Cloudflare worker `pawscout-worker`)
- **Live app Client ID:** `6bc07cd8a343a4aa2ab4b14a09859310` (= `SHOPIFY_API_KEY`)
- **Dev Dashboard (REAL app):** org `221233114`, app `378577780737`
- D1 database id: `85f80862-0b26-4515-82b6-3408124e3a59`
- Shopify account email: `getrealmarketing.net@gmail.com`
- ⚠️ DECOY: empty duplicate "PawScout" — Partner org `4969856`, client id
  `0416eeddced14b992a2c6f8faa4efdb8`, 0 installs, no config. **Never edit it.**

## App config — Shopify Dev Dashboard (org 221233114, app 378577780737)
Base: `https://dev.shopify.com/dashboard/221233114/apps/378577780737`
- Versions / release history (edit scopes, App URL, App Proxy, webhooks API
  version → here, via "Create version" → Release): `…/versions` ✓
- Protected customer data access (Step 1 fields + Step 2 questionnaire):
  from the app → **API access → Protected customer data access** (exact slug TBD;
  `/customer_data` is NOT it). _Paste the real URL here when found._

## Store admin (admin.shopify.com/store/4qkudm-ez)
- Apps: `/apps` · this app: `/apps` → PawScout
- Payments (checkout on/off): `/settings/payments` ✓
- Customer privacy (cookie banner + reCAPTCHA/bot protection): `/settings/customer_privacy` ✓
- Store details (shop phone): `/settings/general` ✓
- Policies (returns/shipping/terms/privacy/legal): `/settings/legal` ✓

## Worker / recovery
- OAuth re-grant (use after adding scopes — re-mints token WITH new scopes +
  registers webhooks): `https://pawscout.activepaw.co.uk/auth?shop=4qkudm-ez.myshopify.com` ✓
- After re-grant, reload the app in admin to refresh the console.

## What PawScout (the agent) CAN self-verify vs what needs YOU
Self-verify (via D1 / Shopify Admin API / Cloudflare Workers MCP):
- Token present + granted scopes, tenant config, orders, product links, LLM spend → **D1**.
- Products, collections, policies, prices, store info → **Shopify Admin API**.
- Worker name/id → **Cloudflare Workers**.

Needs YOU (no tool access — these live in dashboards the agent can't reach):
- Dev Dashboard app config (scopes, App URL, App Proxy, protected-data status).
- PawScout's own webhook subscriptions (Admin API only shows the *querying*
  app's webhooks; confirm functionally via a real order landing in `orders`).
- Cloudflare dashboard worker variables/secrets (e.g. `SHOPIFY_API_KEY` value).
- Partner/Dev Dashboard monitoring (deprecated-API warnings).
