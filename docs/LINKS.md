# Links & Identifiers - Active Paw / PawScout

Stop re-hunting. Canonical IDs and the dashboard/admin URLs we keep needing.
(`✓` = confirmed working; `?` = best-guess slug, verify and update.)

## Identifiers
- Store domain: `4qkudm-ez.myshopify.com` · storefront: `activepaw.co.uk`
- Worker domain: `pawscout.activepaw.co.uk` (Cloudflare worker `pawscout-worker`)
- **Live app Client ID:** `6bc07cd8a343a4aa2ab4b14a09859310` (= `SHOPIFY_API_KEY`)
- **Dev Dashboard (REAL app):** org `221233114`, app `378577780737`
- D1 database id: `85f80862-0b26-4515-82b6-3408124e3a59`
- Shopify account email: `getrealmarketing.net@gmail.com`
- ⚠️ DECOY: empty duplicate "PawScout" - Partner org `4969856`, client id
  `0416eeddced14b992a2c6f8faa4efdb8`, 0 installs, no config. **Never edit it.**

## App config - Shopify Dev Dashboard (org 221233114, app 378577780737)
Base: `https://dev.shopify.com/dashboard/221233114/apps/378577780737`
Left nav: Monitoring · Logs · Versions · Settings.
- Versions / release history (edit scopes, App URL, App Proxy, webhooks API
  version → here, via "Create version" → Release): `…/versions` ✓
  (Active version as of 2026-06-14: `V1_14062026` - added order scopes.)
- Settings (`…/settings`) ✓ - Client ID `6bc07cd8…` confirmed here, secret,
  API contact `contact@activepaw.co.uk`. NOTE: **no Protected-customer-data
  section on Settings** (neither real nor decoy app shows it here).
- Monitoring (`…/monitoring`) - API-health / deprecated-API warnings.
- **Protected customer data access:** location in the new Dev Dashboard is NOT
  under Settings and not yet found. The Step 1/Step 2 page reached earlier was
  via the *Partner* dashboard on the DECOY app - so it likely is NOT set on this
  real app. VERIFY FUNCTIONALLY: place a test order → if `orders.hold_reasons`
  contains `incomplete-address`, the shipping address is redacted (protected
  data not granted on this app); if it queues with an address, it's fine.

## Store admin (admin.shopify.com/store/4qkudm-ez)
- Apps: `/apps` · this app: `/apps` → PawScout
- Payments (checkout on/off): `/settings/payments` ✓
- Customer privacy (cookie banner + reCAPTCHA/bot protection): `/settings/customer_privacy` ✓
- Store details (shop phone): `/settings/general` ✓
- Policies (returns/shipping/terms/privacy/legal): `/settings/legal` ✓

## CJdropshipping (supplier)
- Dashboard: `https://app.cjdropshipping.com` (log in with the CJ account whose
  API key is linked to PawScout). Wallet top-up: account menu / My CJ → Balance
  → Recharge (PayPal/card). Exact deep link not verifiable (CJ SPA; not reachable
  by the agent's tools). Stage B `payBalance` draws from THIS wallet.
- API base (via the Fly relay, not direct): `https://developers.cjdropshipping.com/api2.0/v1`.

## Worker / recovery
- OAuth re-grant (use after adding scopes - re-mints token WITH new scopes +
  registers webhooks): `https://pawscout.activepaw.co.uk/auth?shop=4qkudm-ez.myshopify.com` ✓
- After re-grant, reload the app in admin to refresh the console.

## What PawScout (the agent) CAN self-verify vs what needs YOU
Self-verify (via D1 / Shopify Admin API / Cloudflare Workers MCP):
- Token present + granted scopes, tenant config, orders, product links, LLM spend → **D1**.
- Products, collections, policies, prices, store info → **Shopify Admin API**.
- Worker name/id → **Cloudflare Workers**.

Needs YOU (no tool access - these live in dashboards the agent can't reach):
- Dev Dashboard app config (scopes, App URL, App Proxy, protected-data status).
- PawScout's own webhook subscriptions (Admin API only shows the *querying*
  app's webhooks; confirm functionally via a real order landing in `orders`).
- Cloudflare dashboard worker variables/secrets (e.g. `SHOPIFY_API_KEY` value).
- Partner/Dev Dashboard monitoring (deprecated-API warnings).
