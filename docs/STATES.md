# System states: where every switch lives

The single map of every switch/enforcement setting in PawScout and its
**authoritative store**. The live register (Settings -> System states, served by
`POST /api/system-states`, built in `src/system-states.ts`) reads these exact
stores at request time - it never stores a copy.

**Rule for assistants/operators:** before telling anyone "you still need to
flip X", check the state here (console register, or the D1 probe below).
A remembered to-do is not a state. `tests/system-states.test.ts` pins every
registry key to this document, so adding a state without documenting it fails CI.

Quick D1 probe prefix used below:

```
npx wrangler d1 execute pawscout --remote --json --command "<SQL>"
```

Most states live in the one `tenant_config` row (per-shop JSON columns). Dump
the relevant column once and read all its switches together:

```
SELECT inbox, fulfil, gates, pricing, llm, addons, target FROM tenant_config WHERE shop='4qkudm-ez.myshopify.com'
```

## Reply automation

| Key | Where it lives | Check |
|---|---|---|
| `inbox.enabled` | `tenant_config.inbox.enabled` | inbox column dump |
| `inbox.autosend` | `tenant_config.inbox.autosend` (reply-mode master) | inbox column dump |
| `inbox.agents.<label>.autosend` | `tenant_config.inbox.agents` - one per label: lead, product-question, order-status, shipping-returns, wholesale-b2b, affiliate, complaint, spam, automated, other | inbox column dump |
| `inbox.autoConfidenceThreshold` | `tenant_config.inbox.autoConfidenceThreshold` | inbox column dump |
| `inbox.intentThreshold` | `tenant_config.inbox.intentThreshold` | inbox column dump |
| `inbox.alertEmail` | `tenant_config.inbox.alertEmail`, falls back to `fulfil.alertEmail` | inbox + fulfil dumps |
| Answer memory (approved-answers grounding) | pairs + disabled: `npx wrangler d1 execute pawscout --remote --command "SELECT COUNT(*), SUM(disabled) FROM answer_memory"`; backfill flag: `SELECT cache_key FROM search_cache WHERE cache_key='job:answer-backfill'` | capture on every sent reply; recall into every draft; no config switch (inert until pairs exist) |

## Invoicing

| Key | Where it lives |
|---|---|
| `inbox.autoInvoice` | `tenant_config.inbox.autoInvoice` |
| `inbox.invoiceConfidenceThreshold` | `tenant_config.inbox.invoiceConfidenceThreshold` |
| `inbox.invoiceValueCeiling` | `tenant_config.inbox.invoiceValueCeiling` |
| `inbox.invoiceRateLimit` | `tenant_config.inbox.invoiceRateLimit` |

## Partnerships

| Key | Where it lives | Check |
|---|---|---|
| `inbox.affiliateMode` | `tenant_config.inbox.affiliateMode` | inbox column dump |
| `inbox.autoIssueVoucher` | `tenant_config.inbox.autoIssueVoucher` | inbox column dump |
| `partners.consenting` | `affiliate_partners` rows with `marketing_consent = 1` and status active or queued | `SELECT contact_email FROM affiliate_partners WHERE status IN ('active','queued') AND marketing_consent = 1` |

## Marketing email

| Key | Where it lives | Check |
|---|---|---|
| `inbox.postalAddress` | `tenant_config.inbox.postalAddress` (campaigns refuse to send without it) | inbox column dump |
| `email.tracking` | THREE signals, no stored flag: Resend domain open/click flags (live API probe, needs the worker's key), sealed webhook secret, and stored events | `SELECT (SELECT COUNT(*) FROM supplier_credentials WHERE supplier='resend-webhook') AS secret, (SELECT COUNT(*) FROM email_events) AS events, (SELECT MAX(occurred_at) FROM email_events) AS latest` - secret present + events flowing = ON end-to-end |
| `email.suppressed` | `email_unsubscribes` (unsubscribes + complaints + permanent bounces) | `SELECT COUNT(*) FROM email_unsubscribes` |
| `events.recurring` | `recurring_events` rows with `enabled = 1` (yearly rotation flags; occurrence DATES live only in the Shopify discounts + `src/event-catalogue.ts` arithmetic) | `SELECT key, enabled, pct_off, armed_for FROM recurring_events` |

## Fulfilment and shipping

| Key | Where it lives |
|---|---|
| `fulfil.mode` | `tenant_config.fulfil.mode` (manual / pawscout / cj) |
| `fulfil.createOnly` | `tenant_config.fulfil.createOnly` |
| `fulfil.gbFreeUkLive` | `tenant_config.fulfil.gbFreeUkLive` |
| `fulfil.logistics` | `tenant_config.fulfil.logistics` (processing/customs/slack/staleness; defaults from `DEFAULT_LOGISTICS`) |
| `fulfil.shipCost` | `tenant_config.fulfil.shipFx` / `shipHandlingGbp` |
| `fulfil.servedCountries` | `tenant_config.fulfil.servedCountries` |

## Order trail (phase 2, per order)

Not switches: this is a read-only record of what has happened to each order,
kept here because `docs/RUNBOOK-ORDERS.md` explains what to do about it and
this file is where an operator or agent checks the underlying data directly.
Not pinned by `tests/system-states.test.ts` (these are per-order facts, not
config the console's System states register reads); still documented here so
a D1 probe has one place to look. See `docs/RUNBOOK-ORDERS.md` for what each
value means and what to do about it.

| Key | Where it lives | Check |
|---|---|---|
| `orders.status` | `orders.status` column, one row per Shopify order per shop. Values: `received`, `queued`, `held`, `awaiting-payment`, `submitted`, `fulfilled`, `cancelled`, `error`. `received` is declared in the column's type and given a console label, but no code path writes it today: every order is inserted straight into `queued` or `held` | `SELECT shopify_order_id, order_name, status, hold_reasons, cj_order_id, tracking_number, updated_at FROM orders WHERE shop='<shop>' ORDER BY updated_at DESC LIMIT 20` |
| `orders.hold_reasons` | JSON array on the same `orders` row. Values: `unmapped-items`, `incomplete-address`, `high-risk`, `over-threshold`, `not-paid`, `medium-risk-value`, `on-hold`, `refunded`, `already-fulfilled`, `order-missing`, `mixed-origin`, `address-changed-after-supplier-order`, `shopify-cancelled`. Not a closed list: an `error` row carries free text instead (`fulfil: <message>` or `stockout: <message>`, cut at 200 characters, and that message can be the supplier's or Shopify's own text), and an `awaiting-payment` row carries the free-text reason it is waiting to be paid, naming the supplier order id. Only `held` and `cancelled` rows are limited to the list above | same probe as above, `hold_reasons` column |
| `order_events` | `order_events` table (migration 0041), plus an index on `(shop, kind, at)` (migration 0042, for the owner-alert retry sweep's own lookup query). One append-only row per step an order goes through, ordered by `seq` within an order. `detail` never holds a name, address, email or phone number, and never a supplier's or Shopify's raw error text. Kinds include `owner-alert-due`, `owner-alerted`, `owner-alert-failed` and `owner-alert-unconfigured` (see `docs/RUNBOOK-ORDERS.md`, "Reading an order's timeline") | `SELECT seq, at, kind, detail FROM order_events WHERE shop='<shop>' AND shopify_order_id='<id>' ORDER BY seq` |
| `job:order-webhooks` | `search_cache` key `job:order-webhooks`, the last webhook-subscription check: `ok`, `verified` (whether present/missing come from a successful read, not a failed one), `present`, `created`, `missing`, `errors`, `checkedAt`, and `consecutiveFailures` (how many nightly checks in a row have failed to even complete; a manual "Check order events" press does not increment this). Run daily (the first thing nightly maintenance does for each shop) and on demand from that console button | `SELECT cache_key, payload FROM search_cache WHERE cache_key='job:order-webhooks'` |

## Catalog gates and pricing

| Key | Where it lives |
|---|---|
| `llm.enabled` | `tenant_config.llm` (enabled + scoreThreshold + models) |
| `gates` | `tenant_config.gates` (popularityFloor, priceMin/Max, relevance) |
| `pricing` | `tenant_config.pricing` (multiplier, floor, minMarginGbp, maxMarginGbp, fx) |
| `addons.enabled` | `tenant_config.addons` |
| `semantic.enabled` | `tenant_config.semantic` |
| `target` | `tenant_config.target` |
| `catalog.funnel` | `product_links.fail_reason` (read-only roll-up, not a switch) - which admission gate is keeping products out, counted per reason. Probe: `SELECT COALESCE(fail_reason,'unrecorded') r, COUNT(*) FROM product_links WHERE state='failed' GROUP BY r`. Reasons are written in `src/proxy/import.ts`: `curation-score`, `not-pet-relevant`, `no-congruent-image`, `no-local-stock`, `stock-below-floor`, `below-profit-floor`, `exception`. `unrecorded` = rows predating migration 0037. **Read this before changing any gate above: a small catalog is only evidence of an over-strict gate once you know which one is binding, and `exception` is a bug rather than a policy outcome.** First reading, 2026-08-02: `below-profit-floor` 50, `curation-score` 45, no `exception`, nothing else firing. |
| `catalog.funnel.detail` | `product_links.fail_detail` (migration 0038) - **HOW FAR** each product missed, in the gate's own units, alongside the coarse reason. Probe: `SELECT fail_reason, fail_detail FROM product_links WHERE state='failed' AND fail_detail IS NOT NULL ORDER BY updated_at DESC LIMIT 50`, or `TenantStore.failureDetails()`. **This is the column that makes "loosen the gate or not" an evidenced decision:** `fail_reason` alone cannot distinguish 50 products missing a GBP 6 floor by 20p (loosen it) from 50 missing by GBP 5 (the floor is working), nor a curation score of 58-against-60 from 12-against-60. Null on rows predating 0038 and never backfilled - rows fill in as the nightly sweep re-screens them (~92 rows/night measured 2026-08-01). **Never parse it for control flow**; it is evidence for a human, deliberately kept out of `fail_reason` so free text cannot shatter that field's `GROUP BY`. |

## Connections

| Key | Where it lives | Check |
|---|---|---|
| `conn.shopify` | `tenants` row (connection only) | `SELECT shop, status FROM tenants` |
| `conn.shopify.scopes` | **Admin API** `currentAppInstallation.accessScopes` - probed live | console register only (the token is vault-sealed, so there is no D1 probe) |
| `conn.shopify.redirects` | same live probe, filtered to `read/write_online_store_navigation` | console register only |

> **`tenants.scopes` IS NOT THE AUTHORITY - do not quote it.** It records the
> last token *write*, not what the app holds. Measured 2026-07-31 against live
> D1, that column still read its 2026-07-03 value and was missing
> `write_content`, a scope the blog pipeline uses every night. Scopes added in
> the Dev Dashboard are granted by token exchange and never touch the column, so
> it drifts silently and always understates the grant. The two rows above ask
> Shopify instead. This is exactly the class of stale-state error the rule at the
> top of this document exists to prevent.

| `conn.cj` | `supplier_credentials` row `supplier='cj'` | `SELECT supplier, label, validated_at FROM supplier_credentials` |
| `conn.resend` | worker secret `RESEND_API_KEY` (presence only) | `npx wrangler secret list` |
| `conn.openrouter` | worker secret `OPENROUTER_API_KEY` (presence only) | `npx wrangler secret list` |

## Background jobs

| Key | Where it lives | Check |
|---|---|---|
| `job.daily` | `search_cache` key `job:daily-maintenance` | `SELECT cache_key, payload FROM search_cache WHERE cache_key LIKE 'job:%'` (note: rows expire after `expires_at`) |
| `job.pipeline` | `search_cache` key `job:order-pipeline` | same |
| `job.markets` | `search_cache` key `job:market-exclusions` | same |

## Blog distribution and syndication

| Key | Where it lives | Check |
|---|---|---|
| Syndication channel enabled | `tenant_config.syndicate` (enabled/auto toggles per channel) | `wrangler d1 execute pawscout --remote --json --command "SELECT syndicate FROM tenant_config"` |
| Syndication queue/results | `syndication_ledger` (queued/sent/published/failed, one per post per channel) | `wrangler d1 execute pawscout --remote --json --command "SELECT post_id, channel, status, error, attempts FROM syndication_ledger ORDER BY updated_at DESC LIMIT 20"` |
| Creative packs built | `syndication_packs` (article hero + gated LLM copy mirrored to Blotato) | `wrangler d1 execute pawscout --remote --json --command "SELECT post_id, article_handle, pin_image_url IS NOT NULL AS has_image FROM syndication_packs"` |
| Blotato rail connected | worker secret `BLOTATO_API_KEY` (presence only); console Distribution card | `npx wrangler secret list` shows BLOTATO_API_KEY; console Distribution card shows no red box |
| Syndication copy spend | `llm_usage` rows with `task='blog-syndication-copy'` (cost tracking) | `wrangler d1 execute pawscout --remote --json --command "SELECT COUNT(*), SUM(cost_usd) FROM llm_usage WHERE task='blog-syndication-copy'"` |
