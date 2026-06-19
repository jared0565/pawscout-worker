# W-INBOX-1 cutover runbook

## 1. Resend — verify activepaw.co.uk for sending
- Add the domain in Resend; it issues DKIM (CNAME/TXT) + a sending SPF include + a DMARC suggestion.
- Decide: a dedicated sending subdomain (e.g. `send.activepaw.co.uk`, isolates SPF/DKIM and leaves the
  root SPF untouched) OR send from the root and add Resend's include to the single root SPF TXT.
- Current root SPF (inbound only): `v=spf1 include:_spf.mx.cloudflare.net ~all`.
  If sending from the root, it becomes e.g.: `v=spf1 include:_spf.mx.cloudflare.net include:<resend-spf> ~all`.
- Add the DKIM records Resend gives you. Add/confirm a DMARC TXT (`_dmarc`), e.g. `v=DMARC1; p=none; rua=...`.
- Verify in Resend until all checks are green. Send a test owner alert before cutover.

## 2. Cloudflare Email Routing — point support@/contact@ at the Worker
- Email Routing is already enabled (MX = route*.mx.cloudflare.net).
- Add/confirm a verified destination for the owner's Gmail (needed for the safety-net forward).
- Change the `support@activepaw.co.uk` and `contact@activepaw.co.uk` rules from "forward to Gmail"
  to "send to Worker" → `pawscout-worker`. Add a catch-all → Worker (optional).
- W-INBOX-1 safety net: the handler also `message.forward()`s to the owner; keep that destination verified.
  Remove the forward in a later commit once capture is trusted.

## 3. Shopify — route contact-form notifications to support@
- Settings → Notifications (and Store details → Sender email): set the contact/sender address to
  `support@activepaw.co.uk` so form submissions land in the Worker pipe.

## 4. Deploy
- `npm run typecheck && npm test`
- `npm run migrate:remote` (applies 0009_inbox.sql to the production D1)
- `npm run deploy`
- Send a real test email to support@activepaw.co.uk → confirm a thread appears in the console within
  one cron cycle (≤15 min) and is classified.

## 5. INBOX_FORWARD_TO secret
- Set via `wrangler secret put INBOX_FORWARD_TO` — value is the owner's verified Gmail destination.
- The Worker forwards a copy of every inbound email to this address as a rollback net.
- Once capture is trusted (threads appearing correctly, classification running), unset it:
  `wrangler secret delete INBOX_FORWARD_TO` (or set to empty) to stop the duplicate forward.

---

## W-INBOX-2 cutover

### 1. Database migration + deploy

```sh
npm run migrate:remote    # applies 0010_inbox_drafts.sql to the production D1
npm run deploy
```

`0010_inbox_drafts.sql` adds the `inbox_drafts` table and its indexes only. (The `inbox_contacts.message_count` column was added by `0009_inbox.sql` in W-INBOX-1.) The migration uses bare `CREATE TABLE`/`CREATE INDEX` — re-running it against an already-migrated database will error; run it once on production.

### 2. Console settings panel

The HITL / Auto toggle and all W-INBOX-2 config live in the PawScout console **Inbox** tab (settings panel). Key fields:

| Field | Description |
|---|---|
| **HITL / Auto toggle** (`autosend`) | `false` = Human-In-The-Loop (owner reviews every draft before sending); `true` = Auto-send if the draft passes all gates. **Start here on HITL.** |
| **Reply guidance** (`replyGuidance`) | Owner's standing voice / instructions for every draft (e.g. "Always sign off with 'Warm regards, Sarah'"). |
| **Auto-send confidence threshold** (`autoConfidenceThreshold`) | 0–100. The drafter must self-report ≥ this to auto-send (default 80). |
| **Classify model** / **Reply model** | OpenRouter model slugs for the triage and draft passes respectively. |

### 3. Resend Message-ID / threading — verified, no action needed

**Finding (Task 14):** re-threading does **not** depend on Resend honoring our custom `Message-ID`. It is robust whether Resend preserves or overrides it.

Why it's safe (the actual correlation model):

- Our outbound reply sets `In-Reply-To`/`References` to the customer's **last inbound** `Message-ID` (`src/inbox/send.ts`). Resend transmits these caller-supplied headers as-is — this is Resend's own documented threading mechanism ([Reply to receiving emails](https://resend.com/docs/dashboard/receiving/reply-to-emails)).
- Per RFC 5322 §3.6.4, the customer's next reply carries `References` = our reply's `References` **+** our reply's `Message-ID` → i.e. `[<original-inbound-id>, <our-outbound-id>]`.
- `TenantStore.matchThread` matches a reply via `message_id IN (in_reply_to, ...references)`. The `<original-inbound-id>` is always stored (it's the customer's own earlier message) and always round-trips in the reply's `References` chain — so the lookup hits **regardless of what `Message-ID` Resend stamped** on our outbound. Subject+contact is the final fallback.
- The custom `Message-ID` we set (`<inbox-{uuid}@activepaw.co.uk>`) is therefore a redundant tertiary match path, not load-bearing. Even if Resend overrides it with `<...@resend.dev>`, threading still works.

Regression test locking this in: `tests/inbox-send.test.ts` — "re-threads via the round-tripped inbound id even if our outbound Message-ID was never stored".

**Do NOT implement an `X-PawScout-Id` re-threading fallback.** A custom `X-` header does not round-trip: the customer's reply is composed fresh by their client and never echoes our outbound headers, and inbound mail arrives via Cloudflare Email Routing (not a Resend webhook), so there is no return path for it. As a thread-correlation key it would be an inert no-op. (The earlier "Task 5 notes" mitigation rested on an incomplete threading model — superseded by this finding.)

Optional ops sanity check: send a real test reply via "Approve", reply to it from the recipient inbox, and confirm the customer reply lands back on the same thread in the console. It will, via the inbound-id anchor above.

### 4. Rollout order

1. **Deploy with `autosend: false` (HITL).** Drafts sit in the console for manual review.
2. Review several drafts — check tone, accuracy, and that no draft quotes a price or order commitment.
3. Once you trust the draft quality, flip `autosend: true` in the console settings panel.
4. Monitor for a day; watch the `intent_score` and `confidence` columns in the thread list. Raise `autoConfidenceThreshold` if any marginal drafts slip through.

---

## W-INBOX-3 cutover

### 1. Database migration

```sh
wrangler d1 migrations apply pawscout --remote
```

`0011_inbox_invoices.sql` adds the `inbox_invoices` and `inbox_invoice_lines` tables with their indexes. Run this once on production; re-running against an already-migrated database will error.

### 2. Re-authenticate for new scopes

W-INBOX-3 adds `write_draft_orders` and `read_customers` to `SHOPIFY_SCOPES`. Existing merchants must re-authenticate to grant these permissions:

- Visit `/auth?shop=<shop>.myshopify.com` to trigger the OAuth flow.
- Approve the new scopes in the Shopify Admin consent screen.
- Until granted, the console displays a "Reconnect to enable invoicing" banner and invoice actions return `reconnect_required`. **The rest of the inbox continues to work normally.**

### 3. Validate invoice proposals (HITL)

The `autoInvoice` toggle ships **OFF**. Invoices are proposed into the console for owner review:

- Check the **Drafts** panel (new in W-INBOX-3) to see proposed invoices before sending.
- Validate the AI's product matching: variantId, SKU, title, and quantity should match the customer's order.
- Review the invoice total (`priceGbp × qty` per line item) and ensure no spam/complaint/wholesale orders are included.
- Only flip `autoInvoice` to `true` **after** validating several proposals and confirming accuracy.

**Confidence floor:** even when Auto is enabled, the `invoiceConfidenceThreshold` (default 95), `invoiceValueCeiling` (default 250), `invoiceRateLimit` (default 2), exact-variant-match-only filter, and exclusion list (spam/complaint/wholesale) hold risky proposals in HITL.

### 4. Attribution verification (ops task)

The primary `paid order → invoice thread` attribution relies on Shopify propagating the draft order's `customAttributes.pawscout_invoice_id` to the paid Order's `note_attributes`:

- Create one real test draft order via the console and send an invoice.
- Once the customer places an order, open the Admin API (Shopify Settings → Develop → API Admin → GraphQL) and query the paid Order:
  ```graphql
  {
    order(id: "gid://shopify/Order/<ID>") {
      noteAttributes {
        key
        value
      }
    }
  }
  ```
- **Expected:** `note_attributes` includes a key `pawscout_invoice_id` with the invoice UUID.
- **If present:** attribution works end-to-end; no further action.
- **If absent:** the email-fallback attribution (match paid order's customer email → open 'sent' invoice) is the safety net. Conversions still attribute by email. Log this finding for Task 15 handoff.

### 5. Deploy

```sh
wrangler deploy
```

Monitor the deployment logs and verify no errors. The console should immediately show the new **Drafts** tab once the service is live.
