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
