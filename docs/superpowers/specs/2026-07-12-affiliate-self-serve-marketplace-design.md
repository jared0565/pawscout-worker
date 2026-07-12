# Affiliate self-serve marketplace - design (v2, post-adversarial-review)

**Date:** 2026-07-12
**Status:** Draft for owner approval (v2 incorporates a 3-lens adversarial review)
**Replaces:** UpPromote Affiliate (uninstalled 2026-07-12; $29.99/mo + usage saved)

## Goal

A public, fully-automated affiliate front door: strangers discover the program,
apply on a signup page, get strictly gated by machines, and (if they pass)
receive a low-risk starter voucher with no human involved. Approved partners get
a login dashboard showing their own results. The existing email funnel stays as
the human escape hatch for everyone the automated lane cannot pass.

Everything downstream already exists and is reused: voucher minting with deferred
start behind storewide promos (`issueVoucher`), commission attribution every 15
minutes with refund clawback (`attributeAffiliateOrders`), the payout ledger,
revoke, and the Partners console view.

## The trust model (the load-bearing decision)

A cold stranger's entire application - form answers AND the fetched channel page -
is **attacker-authored**. Therefore no step can *verify* a stranger is
trustworthy; verification can only prove a channel *exists and is topical*. The
program's safety comes not from "we vetted them" but from **bounding what a bad
actor can extract**:

1. Gates raise the **cost** of farming a code (Turnstile, a working non-disposable
   mailbox round-trip, a real pet-topical channel page, global + per-identity
   caps).
2. The auto-issued starter code has a **low blast radius** so the payoff is
   pennies: usage limit 15 (not 100), 2% commission, deferred start, self-referral
   guarded.
3. The **lucrative tier-up stays human**: the existing tier review after 25
   tracked orders is the checkpoint before a code becomes worth gaming. A
   fraudster never reaches it without generating 25 real paid orders first.

**Owner decision (2026-07-12): auto-mint with bounded blast radius.** A passing
applicant gets a code in minutes, no human in the loop, accepting a small bounded
fraud cost as the price of instant self-serve.

Consequently, **LLM output is never authoritative for raising trust.** The channel
judge and fact extractor can only *deflect* (downgrade), never *approve*. Approval
is gated on deterministic checks plus a score whose inputs are treated as
untrusted; the money exposure of a wrongly-approved code is the actual control.

## Owner decisions (all confirmed 2026-07-12)

1. **Auto-mint, bounded blast radius** (above).
2. **Approve bar: score >= 8** on the existing 0-12 scorer AND zero hard abuse
   gates. LLM stages downgrade-only.
3. **Deflect, never dead-end:** below-bar / unverifiable / over-cap applicants get
   a polite email inviting a reply with more evidence, landing in the existing
   HITL partnership funnel where the owner decides.
4. **Self-referral guard: zero commission + flag** (email AND shipping-address
   match); no auto-pause.
5. Starter tier: 5% off / 2% commission / **usage limit 15** / 30-day window /
   deferred start behind any live storewide promo. Tier review after 25 orders
   stays an owner action.

## The gate stack (in execution order)

### Stage 0 - form and bot gates (synchronous, deterministic, in the POST handler)

- **Cloudflare Turnstile** (free, native): server-side verify via `siteverify`,
  new secret `TURNSTILE_SECRET`. **Mandatory once `selfServe.enabled`:** if the
  feature is on and the secret is missing, the POST hard-fails (500 + owner
  alert), it does NOT silently skip. (The feature still ships dark via
  `selfServe.enabled=false`.)
- **Honeypot field + min time-to-submit** (signed form timestamp; < 3s = bot).
- **Field validation:** all fields required, length-capped.
- **Email gates:** syntactic validity; curated disposable-domain blocklist (~50
  domains, in code); MX existence via DoH (`cloudflare-dns.com`), fail-open on DoH
  outage with a `doh_failopen` flag on the row.
- **Channel URL gates:** http(s) and parseable; host not on the coupon/deal/
  cashback blocklist; not an activepaw domain; not already registered to another
  live partner.
- **Former-partner gate:** `partnerPoolState(email) === 'former'` (revoked/ended)
  -> route to owner queue, NEVER auto-approve (prevents `upsertAffiliatePartner`
  silently resurrecting a revoked-for-abuse partner to active).
- **Dedupe -> uniform response:** live partner, mid-application, and new applicant
  all return the **same** generic "check your email" message; the differentiated
  action (login link vs resend magic link vs new application) happens in the
  emailed content, not the HTTP response, so the endpoint is not an
  account-enumeration oracle.
- **Rate limits:** per-IP/day and per-email-domain/day counters (D1), with
  mainstream providers (gmail/outlook/etc.) on a **much higher** domain bucket so
  the limit cannot DoS legitimate users; over limit -> the same generic response.

### Stage 1 - email ownership (deterministic)

Magic link via Resend (existing sender): 256-bit random token, stored **hashed**
(SHA-256), 48h TTL, **single-use enforced by atomic CAS** (`UPDATE ... WHERE
used_at IS NULL`). No judging spend happens until the link is clicked - the
mailbox round-trip is the primary cost anchor against spam. Token carried so it
does not leak: `Referrer-Policy: no-referrer` on the verify response, no external
subresources, token consumed then the page renders a clean tokenless URL.

### Stage 2 - channel existence + topicality (async lane; Firecrawl + LLM, DOWNGRADE-only)

- Fetch via **Firecrawl `/scrape` only** (key already live in prod; SSRF is
  Firecrawl's egress, not ours - the raw-fetch fallback is dropped entirely to
  remove that attack surface). New generic `firecrawlScrape(url)` helper (the
  existing `firecrawlCjSearch` is CJ-hardcoded).
- LLM judge (`jsonChain` + strict validator, the `curateProduct` pattern) on the
  fetched text, framed as UNTRUSTED DATA: does the page exist, is it not
  parked/for-sale, is it genuinely pet-topical. **Output can only PASS or
  DEFLECT**, never raise a score.
- Unfetchable / blocked / parked / off-topic -> deflect.

### Stage 3 - scoring gate (async lane; LLM + deterministic, DOWNGRADE-only)

- `extractScreenFacts` over the form answers, extended via a new optional
  `{channelEvidence?, usageLabel?}` param so channel evidence is a **separate**
  JSON field with its own char budget (never truncating the answers), both framed
  UNTRUSTED. Vocabulary/enums unchanged. Usage logged as `affiliate-screen`.
- `scoreScreen` as today. In this lane it **gates** (unlike the email lane, where
  voucher mode never declines on score): any hard abuse gate (G2/G4/G5) ->
  permanent decline; score >= 8 -> approve; else -> deflect.
- LLM unavailable / invalid output -> deflect (never guess).

### Stage 4 - bounded issuance (async lane)

- `upsertAffiliatePartner({..., channelUrl})` FIRST (to persist channel_url,
  which `issueVoucher`'s internal upsert does not carry), THEN `issueVoucher`
  (starter tier: 5% / usage limit 15 / deferred start).
- **`approved_pending_issue` state:** the approval + code email is sent only
  AFTER the voucher exists. On `issueVoucher` ok:false, retry next tick; on a
  persistent error (no-end-date promo, or N consecutive failures) surface the
  application in the Applications card for owner action - never leave an approved
  applicant silently code-less.
- **Global daily auto-issue cap** (default 5): over the cap, approve-worthy
  applications route to the **owner queue** (not hard-deflected away), and cap
  exhaustion fires an owner alert as a probable-abuse signal.
- **Global daily affiliate-screen spend/attempt budget** (hard stop + alert):
  bounds the Firecrawl + 2-LLM-call cost per verified application against a
  cost-amplification DoS. Per-tick cap of 5 applications in the lane.
- Marketing-consent checkbox -> `marketing_consent` (explicit opt-in only).

### Self-referral guard (independent of signup; applies to ALL partners)

Attribution's `ORDERS_QUERY` gains `email` and `shippingAddress` (protected
customer data - **pre-flight the field-level dashboard access before shipping**;
treat a null email as "no determination", flagged, never a false zero). Ledger
rows gain `buyer_email` (stored as a keyed hash, since the only use is equality
matching) and `self_referral`. Commission is zeroed when the normalized buyer
email OR shipping address matches the partner. Accepted as a speed bump: the low
usage limit + tier review + revoke are the real controls against code-as-personal-
coupon abuse. Flag surfaces on the Partners order rows.

## Partner portal (dashboard) - on the WORKER domain, not the App Proxy

The App Proxy strips `Cookie`/`Set-Cookie` and replaces non-2xx responses, so a
proxied cookie session is impossible. The portal therefore lives on
**`pawscout.activepaw.co.uk`** (the worker's own custom domain, where real
cookies and redirects work). The public apply form stays on the store domain via
the App Proxy (trust/SEO). Split surfaces:

| Surface | Host | Notes |
|---|---|---|
| Apply form + submit | store domain via App Proxy (`/apps/pawscout/affiliate/*` -> `/proxy/*`) | all responses 200 + `{ok}` per the existing /proxy convention (Shopify replaces non-2xx) |
| Verify magic link | worker domain (`/affiliate/verify`) | clean redirect + no-referrer |
| Portal login + dashboard | worker domain (`/affiliate/portal`) | real `httpOnly; Secure; SameSite=Lax` session cookie, HMAC over partner id + expiry (server secret), 7-day, no in-window revocation |

- **Login:** email -> magic link (identical response whether or not the email is a
  partner: no enumeration) -> session cookie.
- **Shows (own data only):** code, live/scheduled/revoked status + deferred-start
  date, tracked order count, gross face value, commission earned, paid vs pending
  payout, last order date. **No buyer PII ever** - aggregates only.
- Read-only in phase 1.

## Execution: a new 15-minute LANE (not a nightly stage)

Stages 2-4 run as `runAffiliateScreenSweep(env)` added to the 15-minute
`Promise.all` of independent lanes (per `src/index.ts` scheduled handler), each
with per-shop try/catch isolation and cheap early-exit when no applications are in
`verified` state - matching `attributeAffiliateOrders`. Not the nightly staged-
cursor chain (that has next-day latency; a 48h token TTL needs same-hour
processing). Per-tick cap of 5 applications.

## Data model changes (one migration)

- **`affiliate_applications`** (new; note it is DISTINCT from the existing
  thread-keyed `affiliate_applicants` inbox table - comment both): shop, id,
  email, name, channel_url, answers_json, stage (`submitted | verified | judging |
  approved_pending_issue | approved | deflected | declined | owner_queue`), score,
  facts_json, flags_json (doh_failopen, turnstile_off, over_cap), ip_hash,
  created_at, updated_at.
- **`affiliate_tokens`** (new): shop, token_hash, kind (`verify | login`), subject
  id, expires_at, used_at (atomic CAS on claim).
- **`affiliate_orders`**: add `buyer_email_hash`, `self_referral`.
- **`affiliate_partners`**: add UNIQUE index on (shop, contact_email) - AFTER a
  dupe audit of existing rows.
- **GDPR:** `redactContact` extends to affiliate_applications (by email) and the
  buyer hash on affiliate_orders; `redactShop` covers the new tables.

## Console additions (Partners view: `src/console/views/partners.ts` +
`src/console/partners-js.ts`)

- **Applications card:** stage, score, channel link, judge summary, flags; owner
  override actions (Approve anyway -> issues voucher; Decline) - the owner queue
  and deflected/over-cap applicants surface here so they are never invisible.
  Follows the existing `esc()` + `data-*` delegated-handler + two-click-arm
  patterns and the page.ts template-literal escaping rules.
- Self-referral flag on order rows.
- **Config toggles** (in `TenantConfig` alongside `cfg.inbox`): `selfServe.enabled`
  (default OFF - ships dark), daily auto-issue cap, daily screen-spend cap, score
  threshold, starter usage limit.

## Outbound email discipline

All applicant-facing emails (magic link, verify outcome, approval + code, decline/
deflect, portal login) are direct sends that bypass the inbox pipeline, so **each
call site explicitly calls `sanitizeOutbound`** and sets From/Reply-To =
`PARTNERSHIP_FROM` (`sales@activepaw.co.uk`) - the latter is required for deflect
replies to route back into `isPartnershipLane` (which matches on the inbound
to-address). No em/en dashes (runtime-enforced, but authored clean too).

## Non-goals (phase 1)

No public partner directory; no click/link attribution (code-based only); no
self-serve payouts; no tier self-upgrade; no creative asset packs; no raw-fetch
channel fallback.

## Costs

Per verified application: one Firecrawl scrape + two LLM calls, low single-digit
pennies, logged to `llm_usage` as `affiliate-screen` and hard-capped by the daily
screen-spend budget. Turnstile free; emails via existing Resend.

## Open items for the implementation plan

1. Dupe-audit result gating the UNIQUE partner-email index.
2. Pre-flight the protected-customer-data field-level access for order email +
   shipping address (app settings URL is in memory) before the self-referral
   query change.
3. Confirm App Proxy header/redirect behavior and the worker custom-domain route
   for the portal against current Shopify docs before building.
4. Curated coupon-host + disposable-domain blocklists (constants).
5. Signup page copy + terms (reuse the qualifying email's terms list).
6. Whether the theme links the apply page at launch or it stays unlisted until the
   owner shares it.
