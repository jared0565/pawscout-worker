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

### 3. Verify Resend honors the custom `Message-ID`

After deploying, send a real test reply from `support@activepaw.co.uk` via the console "Approve" button. Then inspect the delivered email headers in the recipient's inbox:

- Look for the `Message-ID` header. PawScout sets it to `<inbox-{uuid}@activepaw.co.uk>`.
- If Resend **overrides** the value with its own ID (e.g. `<...@resend.dev>`), the re-threading logic that matches a customer reply back to the original thread will fail.
  - Mitigation: switch the re-threading lookup to use `X-PawScout-Id` (a custom header PawScout also sends and stores) rather than `Message-ID`. This is the fallback documented in the Task 5 notes and should be implemented before enabling Auto mode.
- If the `Message-ID` header is preserved as-is, no action is needed.

### 4. Rollout order

1. **Deploy with `autosend: false` (HITL).** Drafts sit in the console for manual review.
2. Review several drafts — check tone, accuracy, and that no draft quotes a price or order commitment.
3. Once you trust the draft quality, flip `autosend: true` in the console settings panel.
4. Monitor for a day; watch the `intent_score` and `confidence` columns in the thread list. Raise `autoConfidenceThreshold` if any marginal drafts slip through.
