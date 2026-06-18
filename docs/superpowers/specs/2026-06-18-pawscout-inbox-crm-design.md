# PawScout Inbox — Email CRM & Conversion Agent (`W-INBOX`)

**Status:** Approved design (2026-06-18). Ready for implementation planning.
**Repo:** `pawscout-worker` (Cloudflare Worker; Hono + D1 + Shopify Admin + OpenRouter + Resend).

## 1. Problem & goal

Today, enquiries to Active Paw arrive two ways — the storefront contact form
(`snippets/contact-modal.liquid`, Shopify native `{% form 'contact' %}`) and the
footer `mailto:support@activepaw.co.uk` link — and both forward to the owner's
**personal Gmail**, which floods it.

Build an **automated, real-time CRM inside PawScout** that:
1. Receives every inbound email at `@activepaw.co.uk`.
2. Stores it in D1 as a tracked contact + conversation thread.
3. Classifies it: legitimate human with buying intent vs. spam vs. other, and
   tags it with category labels.
4. Drafts an intelligent reply that guides a buyer toward a paid Shopify order.
5. Surfaces everything in the PawScout console; the owner approves before any
   reply or order action goes out.
6. Stops the per-enquiry Gmail flood — Gmail receives only high-signal alerts.

## 2. Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| **Domain** | `activepaw.co.uk` for all inbound **and** outbound. Replies sent **from** `support@activepaw.co.uk`. No `resend.dev` sandbox, no `*.myshopify.com`. |
| **Scope** | First-party (Active Paw), but all new tables keyed off `shop` like the rest of the Worker — generalizes to a platform feature later with no schema rewrite. |
| **Autonomy** | **Human-in-the-loop.** LLM classifies + drafts; nothing sends and no order is created until the owner approves in the console. |
| **Inbound transport** | **Cloudflare Email Routing → Email Worker** (domain is already a CF zone; the Worker runs on `pawscout.activepaw.co.uk`). Replaces the Gmail forward. |
| **Gmail** | High-signal alerts only (hot lead awaiting approval). Reuse the existing `alertEmail` config field. Per-enquiry forward switched off. |
| **Labels** | Locked taxonomy: `lead`, `product-question`, `order-status`, `shipping-returns`, `wholesale-b2b`, `complaint`, `spam`, `automated`, `other`. Multi-label per thread; one primary category drives the pipeline. |
| **Rollout** | Phased (W-INBOX-1..3 + future), each phase ships independently. |

## 3. Core principle — *LLM proposes, mechanical code disposes*

Mirrors the repo's existing philosophy ("function on mechanical gates alone; the
LLM degrades gracefully"; see `src/llm.ts`). The email body is **attacker-controlled
input** flowing into an LLM, so:

- **Deterministic gates decide** spam/suppression and authorize all actions:
  SPF/DKIM/DMARC results, per-sender rate-limit, loop detection
  (`Auto-Submitted`, `Precedence: bulk`, self-sends, `List-*` headers),
  `Message-ID` dedup.
- **The LLM only scores and drafts.** It can output text and a *suggested* action
  (e.g. "propose a draft order for items X, Y"); it can **never** trigger a send
  or `draftOrderCreate` directly. The action layer lives outside model reach and
  is gated by an explicit human approval click.
- Every LLM failure degrades to "no draft / needs manual reply" — never to an
  unsafe send.

## 4. Architecture

```
Contact form ─┐
              ├─► support@ / contact@activepaw.co.uk
mailto: ──────┘            │
                  Cloudflare Email Routing (MX on the CF zone)
                           │
                  Worker  email(message, env, ctx)
                           │  (synchronous: minimal work)
              ┌────────────┴───────────────┐
              │  parse (postal-mime) +      │
              │  Shopify-form-notification  │
              │  parse → upsert contact,    │
              │  thread, message (dedup)    │
              └────────────┬───────────────┘
                           │ ctx.waitUntil(...)  (background)
              ┌────────────┴───────────────┐
              │ mechanical gates → spam?    │
              │ LLM classify → intent/labels│
              │ LLM draft reply (if human)  │
              │ → drafts row (status=pending)│
              │ → high-signal alert? (Gmail) │
              └────────────┬───────────────┘
                           │
        Console "Inbox" tab: thread list + thread view + editable draft
                           │  owner clicks Approve & Send
              ┌────────────┴───────────────┐
              │ (if requested) draftOrderCreate → invoiceUrl │
              │ insert checkout link into reply              │
              │ Resend send FROM support@ (In-Reply-To/Refs) │
              │ record outbound message; thread→awaiting     │
              └────────────┬───────────────┘
                           │ customer pays invoice
              Shopify orders/paid webhook (EXISTING, extended)
                           │ match order→thread by email/draft-order id
                           ▼ thread → converted (attribution)
```

### 4.1 Inbound capture
- Add an `email` handler to the Worker's exported object (alongside `fetch`,
  `scheduled`). Cloudflare Email Routing rules: `support@`, `contact@`, and a
  catch-all → this Worker.
- Set Shopify's store-notification / sender address to `support@activepaw.co.uk`
  so contact-form notifications enter the same pipe. **No theme changes.**
- Parse raw MIME with `postal-mime` (Workers-compatible). A dedicated parser
  extracts the *visitor's* real email + fields from Shopify's contact-form
  notification (sender is Shopify's system; the customer is in `Reply-To`/body).
- The synchronous handler does the minimum: parse + upsert contact/thread/message
  + dedup. Classification and drafting run in `ctx.waitUntil`.

### 4.2 D1 schema — new migration `0009_inbox.sql` (all `shop`-keyed)
- **`contacts`**: `id, shop, email, name, phone, shopify_customer_id?, first_seen_at, last_seen_at, message_count`. Unique `(shop, email)`.
- **`threads`**: `id, shop, contact_id, subject, status, primary_category, intent_score, last_message_at, created_at, updated_at`. `status ∈ {new, needs_reply, awaiting_customer, converted, closed, spam}`.
- **`messages`**: `id, shop, thread_id, direction {inbound|outbound}, message_id, in_reply_to?, references?, from_addr, to_addr, subject, body_text, body_html?, headers_json?, received_at`. Dedup unique `(shop, message_id)`.
- **`thread_labels`**: `(shop, thread_id, label)` — multi-label tagging.
- **`inbox_drafts`**: `id, shop, thread_id, body_html, body_text, status {pending|approved|sent|discarded}, confidence, suggested_actions_json, created_at, approved_at?, sent_message_id?`.
- Reuse existing `llm_usage` logging for classify/draft cost.

### 4.3 Classification
Mechanical gates (deterministic, first):
- Auth: parse `Authentication-Results` (SPF/DKIM/DMARC). Hard-fail → spam signal.
- Rate-limit per sender + loop/auto-responder detection (`Auto-Submitted: auto-*`,
  `Precedence: bulk/list`, self-sends, `List-Unsubscribe`) → store + label
  `automated`, never draft/alert.
- `Message-ID` dedup → ignore duplicates.

LLM classifier (`LlmClient.json`, strict JSON, validated):
- Input: subject + sanitized/truncated body + sender domain + auth summary.
- Output: `{ isHuman: bool, category: <one label>, intentScore: 0–100, summary: string, suggestedLabels: string[] }`.
- Deterministic mapping `category + intentScore + gates → { thread.status, generate_draft?, alert? }`. Body is treated as data; classifier prompt is injection-resistant.

### 4.4 Reply drafting
- Runs only for human, non-spam threads with a genuine question/intent.
- Brand voice + rules identical to existing `curateProduct`/`rewriteDescription`
  (UK English, factual, **no medical/disease claims**). Grounded in store facts
  from `docs/SHIPPING_POLICY.md`, `RETURNS_POLICY.md`, `TERMS_OF_SERVICE.md`.
- Output: `{ subject, bodyHtml, bodyText, wantsDraftOrder: bool, draftOrderItems?: [...], confidence }`.
- Writes an `inbox_drafts` row (`status=pending`). **Nothing sends.**

### 4.5 Approval surface — new **Inbox** tab in the console (`src/console/`)
- Thread list: status, primary label, intent score, contact, last message.
- Thread view: full conversation, the **editable** AI draft, any suggested
  draft-order, and actions: **Approve & Send / Edit / Discard / relabel /
  change status**.
- Near-real-time via polling (matches the console's current pattern). Push
  (Durable Objects / WebSocket) is a noted future upgrade, not v1.
- New session-token-authed `/api/inbox/*` routes following the existing
  `shopOf(c)` pattern.

### 4.6 Send + conversion
- **Approve & Send** (deterministic):
  1. If `wantsDraftOrder`: `draftOrderCreate` (Admin GraphQL) → `invoiceUrl`;
     insert the checkout link into the reply.
  2. `sendEmail` via Resend **from `support@activepaw.co.uk`**, with
     `In-Reply-To` + `References` headers (Resend `headers` field) so it threads
     and the customer's reply returns into the CRM.
  3. Record the outbound `messages` row; thread → `awaiting_customer`.
- **Loop closure:** extend the existing `/webhooks/orders-paid` handler to match
  a paid order back to a thread/contact (by email or draft-order id) and flip the
  thread to `converted` — conversion attribution, full circle.

### 4.7 Alerts (Gmail, high-signal only)
- Reuse `cfg.fulfil.alertEmail` (or a new `cfg.inbox.alertEmail`). On a hot lead
  (`intentScore ≥ threshold`) with a pending draft, send **one** short Resend
  email to Gmail: *"Hot lead from <name>: <summary> — review & approve: <console
  link>."* Spam / FAQ / automated never alert. Optional daily digest = future.

## 5. External changes / dependencies (flagged, no surprises)
- **Shopify scopes:** add `write_draft_orders` (+ likely `read_customers`) to
  `SHOPIFY_SCOPES` in `wrangler.toml` **and** the Shopify Dev Dashboard (token
  exchange grants the dashboard scopes).
- **Resend:** verify `activepaw.co.uk` for sending (SPF/DKIM/DMARC). Change
  `DEFAULT_FROM` in `src/email.ts` off `onboarding@resend.dev` to
  `Active Paw <support@activepaw.co.uk>`.
- **Cloudflare Email Routing:** enable on the zone; add `support@`/`contact@`/
  catch-all routes to the Worker; configure MX. (Validate exact Email Worker +
  reply mechanics against Cloudflare's email-service docs during implementation.)
- **New dep:** `postal-mime`.
- **Config:** new `inbox` block in `TenantConfig` (`enabled`, `alertEmail?`,
  `intentThreshold`, `labels`, `autosend: false`).

## 6. Testing (vitest, `@cloudflare/vitest-pool-workers`)
Mirror existing patterns (`tests/email.test.ts`, `tests/llm.test.ts`). Cover:
MIME parse; Shopify form-notification parse; mechanical gates (SPF/DKIM, loop,
dedup); classifier output validation; draft generation + injection resistance;
draft-order link insertion; threading headers; webhook→thread matching;
`inbox_drafts` lifecycle (pending→approved→sent). Mock LLM + Resend.

## 7. Security & abuse (must hold)
- LLM never sends or creates orders; human approval + deterministic gates only.
- Treat email body as untrusted data; injection-resistant prompts.
- No secret leakage in logs (matches existing `console.warn` discipline).
- Loop/backscatter protection; never auto-reply to `automated`/bulk/self.
- GDPR: contacts/threads are PII — extend the existing `customers-redact` /
  `shop-redact` GDPR handlers to purge inbox data too.

## 8. Phasing
1. **W-INBOX-1** — Email Routing capture + `0009_inbox.sql` + parse/store/dedup +
   mechanical gates + LLM classify + label + read-only console Inbox + replace
   Gmail forward with high-signal alert. *Useful immediately, zero send risk.*
2. **W-INBOX-2** — LLM draft replies + approval queue + Approve & Send via Resend
   (threading). Add `read_customers`/contact linking.
3. **W-INBOX-3** — draft-order invoice conversion (`write_draft_orders`) +
   `orders/paid` loop closure + conversion attribution + hot-lead alerts.
4. **Future** — graduated autonomy for safe categories, daily digest, real-time
   push (Durable Objects/WebSocket).

## 9. Open items to confirm during implementation
- Exact Cloudflare Email Worker handler signature + reply/forward mechanics
  (validate against Cloudflare email-service docs).
- Whether to also keep a forward-a-copy rule to Gmail during W-INBOX-1 as a
  safety net before trusting capture (cheap rollback).
- `intentThreshold` default value (start conservative, e.g. 70).
