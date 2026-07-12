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

## Catalog gates and pricing

| Key | Where it lives |
|---|---|
| `llm.enabled` | `tenant_config.llm` (enabled + scoreThreshold + models) |
| `gates` | `tenant_config.gates` (popularityFloor, priceMin/Max, relevance) |
| `pricing` | `tenant_config.pricing` (multiplier, floor, minMarginGbp, maxMarginGbp, fx) |
| `addons.enabled` | `tenant_config.addons` |
| `semantic.enabled` | `tenant_config.semantic` |
| `target` | `tenant_config.target` |

## Connections

| Key | Where it lives | Check |
|---|---|---|
| `conn.shopify` | `tenants` row + its `scopes` string (the granted record) | `SELECT shop, scopes, status FROM tenants` |
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
