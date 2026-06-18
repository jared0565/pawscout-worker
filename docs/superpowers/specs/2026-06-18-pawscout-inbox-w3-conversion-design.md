# PawScout Inbox W-INBOX-3 — Conversion (Draft-Order Invoice) Design

**Status:** Approved design (brainstorming complete). Feeds the W-INBOX-3 implementation plan.
**Depends on:** W-INBOX-1 (capture/classify, live), W-INBOX-2 (AI replies + HITL/Auto toggle, live in HITL).
**Date:** 2026-06-18

## 1. Goal

Close the loop the original brief asked for: turn a qualified email enquiry into a **paid Shopify order**. For a thread with concrete buying intent, the system resolves what the customer wants into **real Shopify catalog variants at real Shopify prices**, creates a Shopify **draft order**, and emails the customer the **invoice (payment) link** as a threaded reply. When the customer pays, `orders/paid` attributes the payment back to the thread and marks it `converted`.

This is the "convert this to a paid order in our Shopify store" half of the original brief. W-INBOX-2 delivered the "reply intelligently and guide them through the buying process" half.

## 2. Core principle

**The LLM proposes what the customer wants; mechanical code disposes.** The LLM only emits *search intents* (free-text product queries + quantities extracted from the thread). Deterministic code resolves each query against the Shopify catalog to an **exact variant ID** and uses the **variant's own Shopify price** — the LLM never emits SKUs, variant IDs, prices, or discounts. This is the prompt-injection containment: an attacker-controlled email body can never inject a price, a discount, a SKU, or a recipient into an order.

**Draft orders only email a payment link — no charge.** Creating a draft order and sending its invoice does not move money; the customer must click the link and pay. So the worst case of a wrong invoice is a recoverable mis-sent email, not a fraudulent charge. This is what makes an Auto path tolerable.

## 3. Locked decisions (from brainstorming)

| Topic | Decision |
|---|---|
| **Autonomy** | **Auto-invoice** — extend the W-INBOX-2 Auto model to invoicing, behind a **hard mechanical floor**. Anything failing the floor falls back to the console queue for owner approval. |
| **Rollout** | **Ship HITL, flip Auto when validated.** `autoInvoice` defaults **false**: the AI proposes the invoice (resolved line items + total) into the console; the owner reviews/edits/approves/sends. Once the owner trusts the AI's product matching, they flip the `autoInvoice` toggle and floor-passing invoices send themselves. Same validate-then-flip workflow as `autosend`. |
| **Line-item resolution** | LLM emits product **search queries + quantities**; mechanical Shopify-catalog search resolves each to an **exact variant** (one confident match) at the **variant's Shopify price**. Any ambiguous/unresolved item → forces HITL. |
| **Attribution** | `customAttributes { pawscout_invoice_id }` on the draft order → propagates to the paid Order's `note_attributes` → `parseOrderWebhook` captures them → match invoice → mark `paid` + thread `converted`. **Email fallback** kept regardless. |
| **Invoice state** | New table `inbox_invoices` (lifecycle `proposed → sent → paid`, plus `discarded/expired/failed/superseded`). |
| **Scopes** | Add **`write_draft_orders`** (create draft orders + send invoices) **and `read_customers`** (resolve contact email → Shopify customer, link + attach to the draft order). Existing merchants must re-authenticate to grant the new scopes; the console surfaces a "Reconnect" prompt and the feature degrades gracefully until granted. `read_products` (catalog search) is already granted. |
| **Confidence** | A **separate `invoiceConfidenceThreshold`** (default 95), distinct from the reply `autoConfidenceThreshold` (80) — auto-creating orders deserves more trust than auto-replying. |
| **Pricing** | Prices come from the **Shopify variant**, never recomputed. We pass variant IDs and let Shopify price the draft order, so invoices never drift from the storefront (which applies the 2.7× retail path at import time). |

## 4. Architecture & phasing

Built around the rollout decision — the working conversion loop ships before the risky auto-resolution engine:

- **3a — HITL conversion loop (ships first, deployable on its own):**
  catalog search primitive → owner confirms/edits line items in the console → `draftOrderCreate` (with `customAttributes` + linked customer) → invoice email (threaded, from `support@activepaw.co.uk`) → `orders/paid` attribution → thread `converted`. Contact↔customer linking is part of 3a (it improves the owner-facing draft order). No LLM product-matching is bet on at launch.
- **3b — the Auto slice (validated in HITL, then flipped on):**
  LLM intent-extraction (`proposeInvoice`) + confidence-gated **exact-variant** resolution + the invoice floor (`invoiceSendDecision`) + the `autoInvoice` toggle. This is the only high-risk code and is exactly what the owner validates before enabling.

The catalog-search primitive (`searchShopifyProducts`) is shared: 3a uses it for the owner's product picker; 3b uses it for auto-resolution.

## 5. Components

### 5.1 `src/shopify-catalog.ts` (new)
- `searchShopifyProducts(admin, query, { first }): Promise<CatalogVariant[]>` — Admin GraphQL `products(query:, first:)` (or `search`), returns `{ variantId, productId, title, variantTitle, sku, priceGbp, available }[]`. Uses `read_products` (already granted).
- `resolveLineRequest(admin, query): Promise<{ status: 'resolved'|'ambiguous'|'none'; variant?: CatalogVariant; candidates?: CatalogVariant[] }>` — deterministic single-best-match logic for 3b auto-resolution (exact/normalized title or SKU match → resolved; multiple plausible → ambiguous; none → none). Ambiguous/none never auto-fire.
- `findCustomerByEmail(admin, email): Promise<{ customerId: string } | null>` — Admin GraphQL `customers(query:"email:…")`, requires `read_customers`.

### 5.2 Admin GraphQL additions (extend `src/shopify-admin.ts` usage; mutations colocated with the catalog module or a small `src/shopify-drafts.ts`)
- `createDraftOrder(admin, { email, customerId?, lineItems: [{ variantId, quantity }], customAttributes })` → `{ draftOrderId, invoiceUrl }` via `draftOrderCreate`. Line items reference **variant IDs only** (Shopify prices them). `customAttributes` carries `pawscout_invoice_id`. If `customerId` present (from linking), associate it.
- No `draftOrderInvoiceSend` — **we** send the invoice link via our own Resend path (consistent branding, threading, from `support@activepaw.co.uk`). The `invoiceUrl` from `draftOrderCreate` is what we embed.

### 5.3 Invoice send (reuse `src/inbox/send.ts` pattern)
A new `sendInvoice(env, store, cfg, thread, invoice, coverTextOverride?)` mirrors `sendReply`: builds an HTML email from escaped cover text + the `invoiceUrl` button, threads via `In-Reply-To`/`References` + our controlled `Message-ID`, inserts the outbound `inbox_messages` row, sets the invoice `sent` and the thread `awaiting_customer`.

### 5.4 Data model — migration `0011_inbox_invoices.sql`
```sql
CREATE TABLE inbox_invoices (
  shop                   TEXT NOT NULL,
  id                     TEXT NOT NULL,                 -- uuid; also the pawscout_invoice_id custom attribute
  thread_id              TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'proposed', -- proposed|sent|paid|discarded|expired|failed|superseded
  line_items_json        TEXT NOT NULL,                 -- [{variantId, sku, title, qty, priceGbp}]
  currency               TEXT NOT NULL DEFAULT 'GBP',
  total                  REAL NOT NULL,                 -- sum of Shopify variant prices * qty
  cover_text             TEXT,                          -- short message accompanying the link
  confidence             INTEGER,                       -- 0-100 (AI resolution confidence; null for owner-built)
  hold_reasons           TEXT,                          -- JSON array (floor holds)
  shopify_draft_order_id TEXT,
  invoice_url            TEXT,
  shopify_order_id       TEXT,                          -- set on orders/paid attribution
  created_at             TEXT NOT NULL,
  sent_at                TEXT,
  paid_at                TEXT,
  PRIMARY KEY (shop, id)
);
CREATE INDEX idx_inbox_invoices_thread ON inbox_invoices (shop, thread_id, status);
CREATE INDEX idx_inbox_invoices_order  ON inbox_invoices (shop, shopify_order_id);
```
`InvoiceRow` type + `LineItem` type in `src/inbox/types.ts`.

`TenantStore` additions: `insertInvoice`, `getInvoice`, `getOpenInvoiceForThread(threadId)`, `getInvoiceByOrderId`, `getInvoiceByPawscoutId`, `setInvoiceStatus(id, status, {sentAt?, paidAt?, shopifyOrderId?, draftOrderId?, invoiceUrl?})`, `recentInvoiceCount(contactEmail, sinceIso)`, `linkContactToShopifyCustomer(email, customerId)`, `getContactByEmail(email)`.

### 5.5 Config (`InboxConfig` in `src/inbox/types.ts`, validated in `src/validate.ts`)
```ts
autoInvoice: boolean;              // default false → ships HITL
invoiceConfidenceThreshold: number;// 0-100, default 95
invoiceValueCeiling: number;       // GBP; total above this → HITL. default 250
invoiceRateLimit: number;          // max invoices per contact per day. default 2
```
`validateInboxPayload` extends with the W-INBOX-2 pattern (booleans, 0-100 thresholds, positive numbers/integers). `DEFAULT_INBOX` gains the four fields.

### 5.6 Auto floor — `invoiceSendDecision(...)` (pure function, in `src/inbox/autosend.ts` or a sibling)
`{ create: boolean; holdReasons: string[] }`. ALL of these required to auto-create+send (else → HITL with reasons shown):
- `cfg.autoInvoice === true`
- thread is human + a buying-intent category (`lead`/`product-question`); **never** `spam`/`automated`/`complaint`/`wholesale-b2b`
- `confidence >= cfg.invoiceConfidenceThreshold`
- **every** requested line item resolved to exactly one variant (no `ambiguous`/`none`)
- `total <= cfg.invoiceValueCeiling`
- each quantity within the variant's order cap (reuse the PDP/cart cap priority: tracked inventory → `supplier.max_order_qty` → `available_qty` → conservative 20)
- `recentInvoiceCount(contact, last 24h) < cfg.invoiceRateLimit`
- no discount is ever auto-applied; prices are Shopify's

### 5.7 Sweep integration (`src/inbox/sweep.ts`, extended)
Add `proposeInvoiceOne(env, store, cfg, thread)` to the 15-min sweep, **mutually exclusive with `draftOne` per thread per sweep** (a thread gets at most one outbound action proposed per run). Gate order:
1. `proposeInvoice` LLM call returns `{ isInvoiceMoment: boolean; lineRequests: [{query, qty}]; coverText; confidence }`. If `isInvoiceMoment === false` → fall through to the normal reply drafter.
2. If an open `sent` invoice already exists for the thread → **skip** (idempotency; no second invoice).
3. Resolve each `lineRequest` via `resolveLineRequest`. Compute total from Shopify prices.
4. `invoiceSendDecision`. If `create` → `createDraftOrder` + `sendInvoice`, store invoice `sent`. Else → store invoice `proposed` with `hold_reasons`; surfaced in the console.

### 5.8 Attribution (`orders/paid`, extend `src/fulfil.ts` + `src/index.ts` handler)
- Extend `parseOrderWebhook` to capture `note_attributes` into `OrderRecord` **without disturbing** the existing fulfilment normalization.
- After the existing fulfilment side-effects in the `orders/paid` handler, add an inbox-attribution side-effect: look up `note_attributes['pawscout_invoice_id']` → `getInvoiceByPawscoutId`; if found, `setInvoiceStatus(paid, { shopifyOrderId, paidAt })` + thread → `converted`. **Fallback:** if no attribute match, match the paid order's customer email to an open `sent` invoice on a thread (`getContactByEmail` → most recent open invoice) and convert that. Attribution is best-effort and idempotent (re-delivery safe).

### 5.9 Contact ↔ Shopify-customer linking (3a, `read_customers`)
When a contact is first seen / at proposal time, if `read_customers` is granted, `findCustomerByEmail` → `linkContactToShopifyCustomer` populates `inbox_contacts.shopify_customer_id`. The draft order is created **against that customer** when present (so the order appears under the existing customer in Shopify admin), else with a bare email. Degrades silently if the scope isn't granted.

### 5.10 Scope & re-auth (graceful degradation)
- `wrangler.toml` `SHOPIFY_SCOPES` gains `write_draft_orders,read_customers`.
- Adding scopes does **not** auto-re-mint tokens for existing merchants. Before any draft-order/customer call, read the tenant's stored `scopes` (already persisted on `tenants.scopes`, currently never read): if `write_draft_orders` is missing, the invoice action returns `{ ok:false, error:'reconnect_required' }` and the console shows a **"Reconnect to enable invoicing"** banner linking to `/auth?shop=…`. If `read_customers` is missing, linking is skipped silently (bare-email draft orders still work).

### 5.11 Console (`src/console/page.ts`)
- **Settings panel:** add the `autoInvoice` toggle + `invoiceConfidenceThreshold` + `invoiceValueCeiling` + `invoiceRateLimit`, mirroring the `autosend` controls.
- **Thread view:** an **invoice-proposal card** — line items (title, variant, qty, Shopify price), total, confidence, and any `hold_reasons` — with a catalog search box to add/edit/remove items, and **Approve & Send / Edit / Discard** (mirrors the reply-draft editor). Shows the `invoice_url` and live status (`sent`/`paid`) once created. The "Reconnect" banner appears when the scope is missing. All server-rendered values escaped (W-INBOX-1 XSS lesson).

## 6. Error handling & edge cases
- **Scope missing** → `reconnect_required`, console banner, no partial action.
- **Ambiguous/unresolved line item** → never auto-fires; HITL card shows the candidates for the owner to pick.
- **`draftOrderCreate` failure / user errors** (e.g., variant unavailable) → invoice `failed` with the Shopify error surfaced in the console; thread stays `needs_reply`.
- **Attribution miss** (note_attributes didn't carry, or organic purchase) → email fallback; if still no match, the order simply isn't attributed (no thread flip) — logged, never throws.
- **Idempotency** → one open `sent` invoice per thread; `orders/paid` re-delivery safe (status already `paid` → no-op).
- **Multi-turn** → a re-threaded inbound on an `awaiting_customer` thread with an open invoice supersedes the open invoice (`superseded`) only if the customer's reply changes the order; otherwise the open invoice stands. `converted`/`closed`/`spam` threads are never re-proposed.

## 7. GDPR (explicit task — `src/webhooks.ts` + `TenantStore`)
`inbox_invoices` is PII-bearing (thread_id, line items, draft-order id, links to a contact email). It **must** be:
- purged in `redactShop` (shop/redact) and `redactContact` (customers/redact),
- included in the `customers/data-request` export (`inboxDataSummary`).
This was the exact final-review blocker in W-INBOX-1; it is a first-class task here, with a regression test.

## 8. Testing (vitest, `@cloudflare/vitest-pool-workers`)
- `shopify-catalog`: search parsing, `resolveLineRequest` resolved/ambiguous/none, `findCustomerByEmail` (mocked admin).
- `createDraftOrder`: correct GraphQL shape, variant-IDs-only line items, `customAttributes` set, customer associated when present (mocked admin).
- `invoiceSendDecision`: pure-function table (each floor condition holds; all-pass creates) — mirrors the `autoSendDecision` tests.
- Sweep: `proposeInvoiceOne` mutual exclusion with `draftOne`; idempotency (open invoice → skip); HITL vs Auto branch.
- Attribution: note_attributes match → paid + converted; email fallback; re-delivery no-op; no-match no-throw.
- Linking: email→customer populates `shopify_customer_id`; absent scope → skipped.
- Scope degradation: missing `write_draft_orders` → `reconnect_required`.
- GDPR: redactShop / redactContact purge `inbox_invoices`; data-request includes it.

## 9. Phasing
- **W-INBOX-3a (HITL loop):** migration + types + catalog search + customer linking + `createDraftOrder` + `sendInvoice` + console invoice card + `orders/paid` attribution + scope/degradation + GDPR. Ships HITL; the owner builds/approves invoices manually. Fully closes the conversion loop.
- **W-INBOX-3b (Auto):** `proposeInvoice` LLM + `resolveLineRequest` confidence gating + `invoiceSendDecision` floor + `autoInvoice` toggle + sweep integration. Flipped on after HITL validation.

## 10. Open items to confirm during implementation
- **Verify `note_attributes` propagation** from `draftOrderCreate.customAttributes` to the paid Order on our pinned Admin API version **before** it is treated as the primary attribution mechanism. If it does not carry, rely on the email fallback and/or query the order's source draft order by id. (Load-bearing: a silent failure means conversions never attribute.)
- Confirm the Admin API product-search query shape and `read_products` sufficiency for `searchShopifyProducts` on the pinned API version.
- Confirm draft-order line items accept bare `variantId` + `quantity` and that Shopify supplies the price (no price field sent by us).
- Decide the per-variant quantity-cap source reuse (PDP/cart cap helper vs a small shared helper) during the plan.
