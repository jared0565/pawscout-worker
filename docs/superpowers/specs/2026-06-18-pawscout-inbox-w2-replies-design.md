# PawScout Inbox - W-INBOX-2: AI-drafted replies + HITL/Auto toggle

**Status:** Approved design (2026-06-18). Builds on W-INBOX-1 (live in prod). Ready for implementation planning.
**Repo:** `pawscout-worker` (Cloudflare Worker; Hono + D1 + Shopify Admin + OpenRouter + Resend).

## 1. Goal

Turn the live "classified and waiting" inbox into an answering tool. For each genuine enquiry, an LLM drafts a reply in Active Paw's voice; the owner reviews/edits/approves (HITL); once confident, the owner flips a single **Auto** toggle and safe replies send themselves - with a hard floor that never lets Auto fire on risky mail. Replies are threaded so the customer's response returns into the same conversation.

This is the "reply intelligently and guide them through the buying process" half of the original brief. **Conversion (draft-order invoice links) stays W-INBOX-3.**

## 2. Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| **Autonomy control** | A single global **HITL ↔ Auto** toggle (`cfg.inbox.autosend`), with a **hard safety floor**: in Auto, a draft auto-sends only if `confidence ≥ autoConfidenceThreshold` **and** it doesn't quote a price / propose an order **and** the sender is under the per-sender auto-reply rate limit. Anything failing → held in the console queue with the reason shown. Spam/automated never get a draft. |
| **Fine-tuning** | Per-draft **edit before approve** + a standing, owner-editable **`replyGuidance`** note that steers EVERY future draft (corrections compound). |
| **Scope** | **Text replies only.** No order/invoice creation in v2 (that's W-INBOX-3); the floor holds any price/order-touching draft for approval until then. No new Shopify scopes. |
| **Reply model** | New `replyModel`, default `anthropic/claude-haiku-4.5` (customer-facing copy quality), configurable. Separate from the cheap `classifyModel`. |
| **Auto confidence default** | `autoConfidenceThreshold = 80` (conservative; configurable). |
| **Human-in-the-loop default** | `autosend = false` on every tenant until the owner explicitly flips it. |

## 3. Core principle (unchanged from W-INBOX-1)

*LLM proposes, mechanical code disposes.* The drafter only writes candidate text and self-reports `confidence` + `quotesPriceOrOrder`; **deterministic code decides whether anything sends** (the floor) and the human approves in HITL. The email body remains attacker-controlled - treated as data, never instructions; the drafter cannot trigger a send or any Shopify action itself. Every LLM failure degrades to "no draft / manual reply", never to an unsafe auto-send. **The money gate is mechanical, not model-trusted:** the floor does NOT rely solely on the LLM's `quotesPriceOrOrder` flag - deterministic code also regex-scans the draft text for currency/price/discount/order patterns and ORs the two; either signal holds the draft. The model can't talk its way past the money guard.

## 4. Architecture / data flow

```
[15-min sweep, after classify]
  thread.status == 'needs_reply' (human, non-spam)
        │
        ▼  draft (replyModel, brand voice + policy docs + replyGuidance, untrusted body as data)
  inbox_drafts row {status:'pending', confidence, quotesPriceOrOrder, hold_reasons}
        │
   autosend? ──no──► stays 'pending' → owner reviews in console
        │yes
   passes floor? (confidence≥thr AND !quotesPriceOrOrder AND under rate-limit)
        ├─ no ──► stays 'pending' (hold_reasons set) → owner reviews
        └─ yes ─► SEND (auto)
                     │
[owner Approve & Send (HITL)] ─────────────┤
        │ (optional edit first)            │
        ▼                                   ▼
  sendEmail via Resend FROM support@activepaw.co.uk
    - generated Message-ID  <inbox-{uuid}@activepaw.co.uk>  (stored)
    - In-Reply-To / References = inbound message-id  (threads in client)
        │
  outbound inbox_messages row; draft → sent|auto_sent; thread → awaiting_customer
        │
  customer replies → inbound → matchThread (by In-Reply-To→our Message-ID) → same thread ✓
        │
  ingest RE-OPENS the thread: status awaiting_customer → needs_reply (classified_at kept,
  category persists) → next sweep DRAFTS a reply to the new message → multi-turn conversation
```

**Multi-turn continuation (critical - this is what makes it "guide them *through* the buying process").** A re-threaded inbound must restart the reply loop, or the conversation dies after one exchange. Rules, applied in `ingestParsed` when a message attaches to an **existing** thread:
- thread `awaiting_customer` (we'd replied) **or** `needs_reply` (we hadn't yet) → set `needs_reply`; supersede any `pending` draft (status → `superseded`) so the sweep drafts fresh against the full thread. Classification is **not** re-run (`classified_at` kept) - the category persists; only a new draft is produced.
- thread `spam`/`closed`/`converted` → **left as-is** (no auto-reopen; the owner can manually re-status in the console). This prevents a spammer (or a dismissed thread) from reopening itself.
- The **per-sender auto-reply rate limit (§5.2) is load-bearing here** - it's what bounds an auto↔auto ping-pong if the customer's mailer also auto-replies. It is a safety mechanism, not a nicety.

## 5. Components

### 5.1 Drafter (`src/inbox/draft.ts`, new)
- `draftReply(llm, store, cfg, thread, messages): Promise<DraftResult | null>` - builds context (thread subject + inbound body, sanitized/truncated; store facts from `docs/SHIPPING_POLICY.md`/`RETURNS_POLICY.md`/`TERMS_OF_SERVICE.md`; the tenant's `replyGuidance`), calls `LlmClient.json` with `cfg.inbox.replyModel`, validates, logs usage (`store.logLlmUsage('inbox-draft', …)`). Returns null on any failure.
- Output schema `DraftResult = { bodyText: string; bodyHtml: string; confidence: number /*0-100*/; quotesPriceOrOrder: boolean }`.
- System prompt: Active Paw voice, UK English, **no medical claims** (same rules as `curateProduct`/`rewriteDescription`), grounded ONLY in supplied facts (no invented prices/promises), body-is-untrusted-data containment. Appends the tenant `replyGuidance` verbatim as additional standing instructions.

### 5.2 Auto-send floor (`src/inbox/draft.ts` or `src/inbox/autosend.ts`, pure)
- `autoSendDecision(cfg, draft, category, recentAutoCount): { send: boolean; holdReasons: string[] }`. Pure function.
- `send` iff ALL of: `cfg.inbox.autosend === true` · `draft.confidence >= cfg.inbox.autoConfidenceThreshold` · **money gate passes** (`draft.quotesPriceOrOrder === false` AND a mechanical `mentionsMoney(text)` regex finds no currency/price/discount/order pattern - either trips → hold) · **category not in the always-hold set `{complaint, wholesale-b2b}`** (a confident, no-price complaint reply must never auto-fire at an upset customer; B2B/trade enquiries need a human) · `recentAutoCount < AUTO_RATELIMIT_PER_SENDER_DAY` (const, e.g. 3). Each failing condition appends a `holdReason`. (Spam/automated never reach here - no draft is generated for them.)
- `mentionsMoney(text): boolean` - pure regex helper: matches `£`/`$`/`€`, `\d+(\.\d{2})?` near price/cost/discount/% words, "order"/"invoice"/"checkout" commitments. Conservative (false positives just route to HITL).

### 5.3 Sweep integration (`src/inbox/sweep.ts`, extended)
Two distinct passes per shop:
- **Classify pass** (existing): `status='new' AND classified_at IS NULL` → classify → set status + `classified_at`.
- **Draft pass** (new): `status='needs_reply' AND has no pending draft` → draft → persist `pending`. Then apply `autoSendDecision`: if `send`, call the send path; else leave `pending` with `hold_reasons`. The "no pending draft" gate means a thread already awaiting your approval, already answered (`awaiting_customer`), discarded (`closed`), or `sent`/`auto_sent` is **not** re-drafted (no token re-charge, no loop). A re-opened thread (§4 multi-turn) has its prior draft `superseded`, so it qualifies and gets a fresh draft.
- Per-shop try/catch preserved; LLM-gated and self-healing (no reply model / failure → thread stays `needs_reply` with no draft, retried next sweep).

### 5.4 Send path (`src/inbox/send.ts`, new) + `src/email.ts` extension
- **Extend `sendEmail`** to accept `messageId?: string` and `headers?: Record<string,string>` and to **return the `Message-ID` actually used**. Generate `<inbox-{crypto.randomUUID()}@activepaw.co.uk>` when not supplied; pass it + `In-Reply-To`/`References` via Resend's `headers` field. (Resend returns its own internal id today; we must control the RFC `Message-ID` or customer replies orphan - confirmed-critical in W-INBOX-1.)
- `sendReply(env, store, cfg, threadId, draftId, bodyText, bodyHtml)`: **sanitizes `bodyHtml`** to a safe allowlist (`<p><br><ul><li><strong><em><a>`; strip scripts/styles/`<img>`/external resources - reuse the repo's existing description-sanitizer approach, e.g. the HTML strip used by `buildPreview`/`rewriteDescription`) - this is LLM-generated HTML that in Auto mode reaches a customer with no human review; sends **`To: thread.contact_email`** (the real visitor - NOT the inbound `from_addr`, which for a contact-form notification can be the Shopify relay); looks up the thread's latest inbound `message_id` for `In-Reply-To`/`References`; sends FROM `Active Paw <support@activepaw.co.uk>`; records an outbound `inbox_messages` row (with **our** generated Message-ID + `direction='outbound'` - that stored id, not the inbound one, is what re-threads the customer's next reply); sets the draft → `sent`/`auto_sent`, thread → `awaiting_customer`. Shared by both the HITL approve route and the Auto path.

### 5.5 Console (`src/console/page.ts` + `src/inbox/routes.ts`, extended)
- **Thread view:** render the `pending` draft in an editable textarea + **Approve & Send / Edit / Discard**; show `hold_reasons` when present; render sent outbound messages in the thread. All server data `esc()`-escaped (W-INBOX-1 discipline).
- **Settings panel (new):** the **HITL/Auto toggle**, `autoConfidenceThreshold`, the **`replyGuidance`** textarea, `alertEmail`, `intentThreshold`, `classifyModel`, `replyModel` - saved via the existing `/api/inbox/config` (`validateInboxPayload` extended; **`autosend:true` now allowed**, replacing the W-INBOX-1 hard-reject).
- New routes: `POST /api/inbox/approve {id}` (approve+send a draft, optional edited body), `POST /api/inbox/discard {id}` (draft → `discarded` **and thread → `closed`** so the draft pass does NOT re-draft it - without this, discard would loop and re-charge tokens; a later customer reply re-opens it per §4 only from `awaiting_customer`, so a discarded/`closed` thread stays dismissed until the owner manually re-statuses). Session-token authed via `shopOf(c)`.

## 6. Data model - migration `0010_inbox_drafts.sql`
- New table **`inbox_drafts`**: `shop, id, thread_id, body_text, body_html, status TEXT('pending'|'approved'|'sent'|'auto_sent'|'discarded'|'superseded'), confidence INTEGER, quotes_price_order INTEGER, hold_reasons TEXT(JSON), model TEXT, created_at, sent_at, sent_message_id`. PK `(shop, id)`; index `(shop, thread_id, status)`; index `(shop, status, created_at)`. (`superseded` = replaced by a newer draft after a multi-turn re-open; the "no pending draft" sweep gate keys on `status='pending'`.)
- New `inbox` config fields (JSON column, no migration - merged by `getConfig`): `autosend: boolean` (default false), `autoConfidenceThreshold: number` (default 80), `replyGuidance: string` (default ''), `replyModel: string` (default `anthropic/claude-haiku-4.5`).
- `redactShop` + the W-INBOX-1 `redactContact` extended to purge `inbox_drafts` (drafts contain reply text about a customer = PII).

## 7. Security & abuse (must hold)
- Auto-send gated entirely by deterministic floor + the explicit `autosend` switch; the LLM never sends.
- Drafter prompt treats the inbound body as data; injection cannot redirect it to send or fabricate offers.
- Rate-limit per sender (loop/backscatter guard) applies in Auto.
- Never draft/auto-send for `spam`/`automated`/`closed` threads.
- `replyGuidance` is owner-authored (trusted), injected as instructions - fine; the untrusted email body is never injected as instructions.
- GDPR: `inbox_drafts` purged on `customers/redact` (by thread→contact) and `shop/redact`.

## 8. Testing (vitest)
Drafter output validation + injection resistance; `autoSendDecision` truth table (every hold condition independently - incl. **`mentionsMoney` mechanical backstop overriding a false `quotesPriceOrOrder` flag**, and **`complaint`/`wholesale-b2b` always held** even when confident + price-free); `mentionsMoney` regex (currency/price/discount/order positives, plain prose negatives); `sendEmail` Message-ID generation + return + `headers` passthrough; **bodyHtml sanitization** (script/`<img>`/external-link stripped before send); send uses `To: thread.contact_email`; **threading round-trip** (send → our Message-ID stored → inbound reply with that `In-Reply-To` → `matchThread` returns the same thread); **multi-turn** (inbound on an `awaiting_customer` thread → `needs_reply`, prior draft `superseded`, draft pass produces a fresh draft; `spam`/`closed`/`converted` threads NOT reopened); draft lifecycle (pending→approved→sent, pending→auto_sent, pending→discarded); **discard → thread `closed` → draft pass does not re-draft**; rate-limit guard; console approve/discard routes; `validateInboxPayload` now accepts `autosend:true` + validates the new fields. Mock LLM + Resend.

## 9. Phasing
- **W-INBOX-2 (this spec):** drafts + edit + HITL approve + Auto toggle w/ floor + threaded send + replyGuidance + settings panel. Ships independently on top of the live phase 1.
- **W-INBOX-3 (next):** draft-order invoice conversion (`write_draft_orders`), `orders/paid` → thread `converted` attribution, contact↔Shopify-customer linking (`read_customers`).

## 10. Open items to confirm during implementation
- Whether to draft in the sweep for ALL `needs_reply` threads vs. on-demand in HITL (cost vs. readiness). Default: sweep-time drafting (bounded to genuine enquiries); revisit if volume cost is high.
- Resend `headers` field exact shape for `In-Reply-To`/`References` (validate against Resend API during implementation).
- `AUTO_RATELIMIT_PER_SENDER_DAY` value (start 3).
