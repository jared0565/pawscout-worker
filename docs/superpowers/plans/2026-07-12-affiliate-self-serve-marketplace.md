# Affiliate self-serve marketplace - implementation plan

**Spec:** `docs/superpowers/specs/2026-07-12-affiliate-self-serve-marketplace-design.md` (v2)
**Method:** subagent-driven TDD, one task per dispatch, review after each.
**Grounding confirmed:** dupe audit clean (5 partners / 5 distinct emails - UNIQUE
index safe); worker owns `pawscout.activepaw.co.uk` custom domain (portal viable
off the App Proxy); `issueVoucher(store, admin, {email,name,pctOff,commissionPct,
trialDays?,usageLimit?,now?})` returns `IssueResult | {ok:false,error,reconnectRequired?}`;
15-min lanes are a `Promise.all([...])` in `src/index.ts:1766`.

## Global Constraints (the reviewer's attention lens - binding)

- **Trust model:** LLM output (channel judge, `extractScreenFacts`) may only
  DEFLECT, never RAISE a score or approve. Approval gates on deterministic checks
  + score>=8; the low blast radius is the real control, not verification.
- **Starter code blast radius:** usage limit **15**, commission **2%**, 5% off,
  deferred start. These exact values.
- **Auto-mint** is allowed with no human; but former partners and over-cap
  applicants route to the owner queue, never silent auto-approve.
- **Portal is on the worker domain** `pawscout.activepaw.co.uk` (real cookies);
  the apply form is on the store domain via App Proxy and every proxied response
  is HTTP 200 `{ok}` (Shopify replaces non-2xx).
- **Turnstile mandatory once `selfServe.enabled`**: missing secret -> POST
  hard-fails, never silently skips.
- **`sanitizeOutbound` on EVERY applicant-facing send**; From/Reply-To =
  `sales@activepaw.co.uk` (`PARTNERSHIP_FROM`) so deflect replies route into
  `isPartnershipLane`.
- **No em/en dashes** anywhere (runtime-enforced; author clean).
- **`TenantStore` is the only module that touches D1** (enforced by a guard test).
- **Tokens:** 256-bit random, stored SHA-256-hashed, single-use via atomic CAS
  (`UPDATE ... WHERE used_at IS NULL`), TTL enforced.
- **Buyer email stored as a keyed hash** (`buyer_email_hash`), never raw; only use
  is equality matching. Null order email = "no determination", never a false zero.
- **`selfServe.enabled` default OFF** - the whole feature ships dark.
- Run `python -m graphite context/impact <file>` before editing shared files
  (`tenant-store.ts`, `index.ts`, `affiliate-attribution.ts`, `partnership.ts`).

## Task 1 - migration + store methods + GDPR

**Files:** `migrations/0032_affiliate_selfserve.sql`, `src/tenant-store.ts`, `src/types.ts`.

- Migration:
  - `affiliate_applications` (shop, id, email, name, channel_url, answers_json,
    stage, score INTEGER, facts_json, flags_json, ip_hash, created_at, updated_at;
    PK (shop,id); index (shop, stage, updated_at)). Comment: DISTINCT from the
    thread-keyed `affiliate_applicants` inbox table.
  - `affiliate_tokens` (shop, token_hash, kind, subject_id, expires_at, used_at;
    PK (shop, token_hash)).
  - `ALTER affiliate_orders ADD buyer_email_hash TEXT; ADD self_referral INTEGER DEFAULT 0`.
  - `CREATE UNIQUE INDEX idx_affiliate_partners_email_uniq ON affiliate_partners(shop, contact_email)`
    (dupe audit already clean).
- `TenantConfig` (types.ts): add `selfServe?: { enabled: boolean; autoIssueCapPerDay: number;
  screenSpendCapGbpPerDay: number; scoreThreshold: number; starterUsageLimit: number }`
  with defaults `{enabled:false, autoIssueCapPerDay:5, screenSpendCapGbpPerDay:2,
  scoreThreshold:8, starterUsageLimit:15}`.
- Store methods: `insertApplication`, `getApplication`, `updateApplicationStage`,
  `listApplicationsByStage`, `listApplicationsForConsole`, `applicationByEmail`,
  `channelUrlRegistered(host)`, `countApplicationsToday(ipHash|domain)`,
  `insertToken`, `claimToken(hash,kind)` (atomic CAS returning subject_id|null),
  `countAutoIssuedToday`, `sumScreenSpendTodayGbp`. Extend `redactContact` to purge
  `affiliate_applications` by email + null the buyer hash on `affiliate_orders`;
  extend `redactShop` to the new tables.
- Tests (`tests/affiliate-selfserve-store.test.ts`): applied migration; token
  claim is single-use (second claim returns null); dedupe/lookup methods;
  redaction coverage; UNIQUE index rejects a duplicate partner email insert.

## Task 2 - self-referral guard in attribution

**Files:** `src/affiliate-attribution.ts`, `src/tenant-store.ts` (upsertAffiliateOrder).
Run `graphite context/impact src/affiliate-attribution.ts` first.

- Extend `ORDERS_QUERY` nodes with `email` and `shippingAddress { address1 zip }`.
- Compute `buyerEmailHash` (keyed HMAC over normalized email) and a normalized
  shipping key; set `self_referral=1` when either matches the voucher partner's
  email/known address. **Null email -> self_referral stays 0 AND a flag, never a
  commission change on absence.** When self_referral, commission is zeroed
  (`commissionGbp=0`) even for eligible orders; the ledger row still records gross.
- `upsertAffiliateOrder` gains `buyerEmailHash`, `selfReferral` columns.
- Tests: matching buyer email -> commission 0 + flag; matching shipping addr,
  different email -> flagged; null email -> unflagged, commission unchanged; normal
  third-party order -> unaffected. **Pre-flight note for owner:** protected-
  customer-data field access for order `email`/`shippingAddress` must be enabled in
  the app dashboard or the query returns null emails (guard treats that as "no
  determination" - safe, but the guard is inert until access is granted).

## Task 3 - Stage 0 apply route + gates + magic link

**Files:** new `src/affiliate/apply.ts`, `src/affiliate/gates.ts`, wire into
`src/index.ts` under the App Proxy (`/proxy/affiliate/apply` GET+POST). Run
`graphite context src/index.ts`.

- `gates.ts` (pure, deterministic, unit-testable): `validEmailSyntax`,
  `isDisposableDomain` (curated ~50-domain constant), `isCouponHost` (blocklist),
  `honeypotOk(fields, nowMs)`, `channelHostAllowed(url)`. MX-via-DoH is a separate
  async `mxExists(domain)` with fail-open + flag.
- POST handler order: Turnstile verify (hard-fail if `selfServe.enabled` &&
  secret missing) -> honeypot/timestamp -> field validation -> email gates ->
  channel gates -> `partnerPoolState==='former'` -> owner_queue -> dedupe (live
  partner / mid-application / new) all returning the SAME generic 200 body ->
  rate-limit (mainstream providers on a higher bucket) -> insert application
  (stage `submitted`) -> issue `verify` token -> send magic-link email
  (`sanitizeOutbound`, From `PARTNERSHIP_FROM`). GET renders the form HTML
  (Turnstile widget, honeypot, signed timestamp) - worker-rendered, 200.
- Tests (`tests/affiliate-apply.test.ts`, `tests/affiliate-gates.test.ts`): each
  gate; uniform response for the three dedupe cases (no enumeration); former
  partner -> owner_queue; disposable/coupon-host rejected; Turnstile-missing hard
  fail when enabled; over-rate-limit generic response; happy path inserts + issues
  token. Use `app.request` with a signed proxy signature (existing test helper).

## Task 4 - Stage 1 verify + the screen lane (stages 2-4)

**Files:** `src/affiliate/verify.ts`, `src/affiliate/screen.ts`, new generic
`firecrawlScrape` in `src/firecrawl.ts`, extend `extractScreenFacts` in
`src/inbox/partnership.ts` (run `graphite context src/inbox/partnership.ts`),
wire `runAffiliateScreenSweep` into the `Promise.all` at `src/index.ts:1766`.

- `firecrawlScrape(env, url)`: generic /scrape wrapper (JS render, waitFor,
  timeout), returns text or null.
- `extractScreenFacts` gains optional `opts?: {channelEvidence?: string;
  usageLabel?: string}` - evidence as a SEPARATE JSON field with its own char
  budget; usage label parameterized (default keeps `partnership-screen`; this lane
  passes `affiliate-screen`). Enums/vocabulary UNCHANGED.
- `verify.ts` (GET `/affiliate/verify` on WORKER domain): claim token (atomic) ->
  set stage `verified` -> `Referrer-Policy: no-referrer`, render clean tokenless
  confirmation page (200). Actual judging is deferred to the lane.
- `runAffiliateScreenSweep(env)`: early-exit if no `verified` applications;
  per-shop try/catch; per-tick cap 5; per-application: check daily screen-spend
  budget (skip + flag if exceeded) -> firecrawlScrape -> channel judge (PASS or
  DEFLECT only) -> `extractScreenFacts(..., {channelEvidence, usageLabel:'affiliate-screen'})`
  -> `scoreScreen`: hard gate -> `declined`; score>=threshold AND under daily
  auto-issue cap -> `upsertAffiliatePartner({...,channelUrl})` then `issueVoucher`
  (usageLimit from config) -> on ok send approval+code email, stage `approved`; on
  ok:false retry next tick, on persistent/no-end-date error stage
  `approved_pending_issue` + owner alert; over cap -> `owner_queue`; else ->
  `deflected` + deflect email (invites email reply). Every email `sanitizeOutbound`
  + `PARTNERSHIP_FROM`.
- Tests (`tests/affiliate-screen.test.ts`): injection page cannot raise score
  (judge returns DEFLECT / score capped); score>=8 happy path issues a voucher +
  approval email; over-cap -> owner_queue; issueVoucher no-end-date -> pending +
  alert, no approval email; spend-cap exceeded -> skipped + flag; LLM-null ->
  deflect. Fake `firecrawl`/`llm`/`admin` injected, no network.

## Task 5 - partner portal (worker domain)

**Files:** `src/affiliate/portal.ts`, routes on the worker domain (NOT `/proxy`):
`GET /affiliate/portal`, `POST /affiliate/portal/login`, `GET /affiliate/portal/data`.

- Login: POST email -> if a live partner, issue `login` token + magic link;
  ALWAYS return the same 200 body (no enumeration). Verify link sets an
  `httpOnly; Secure; SameSite=Lax` cookie = HMAC(partnerId|exp, server secret),
  7-day.
- Dashboard: cookie -> partnerId -> read own ledger aggregates (code, status +
  deferred-start date, order count, gross, commission, paid/pending, last order).
  NO buyer PII. New store method `partnerPortalSummary(partnerId)`.
- Tests (`tests/affiliate-portal.test.ts`): login response identical for
  partner/non-partner; valid cookie returns only that partner's aggregates;
  tampered/expired cookie rejected; no buyer fields in the payload.

## Task 6 - console Applications card + self-referral flag + config

**Files:** `src/console/views/partners.ts`, `src/console/partners-js.ts`,
`src/console/routes.ts` (or wherever partner APIs live), config plumbing.
Run `tests/console.test.ts` after (template-literal gotcha).

- Applications card: stage, score, channel link, judge summary, flags; owner
  actions Approve anyway (-> issueVoucher) and Decline, two-click armed, `esc()`
  every dynamic value, `data-*` delegated handlers, double-escaped backslashes.
- Self-referral flag rendered on order rows.
- Config toggles for the `selfServe` block; `/api/affiliate/applications` list +
  action routes (session-token authed).
- Tests: pin the card render, the action routes, and the config round-trip in
  `tests/console.test.ts` + a partners API test.

## Deploy sequence (owner-gated, after all tasks pass + final review)

1. `npx wrangler d1 migrations apply pawscout --remote` (0032).
2. `npx wrangler deploy`.
3. Owner: set `TURNSTILE_SECRET`; enable protected-customer-data field access
   (order email + shipping) in the app dashboard; leave `selfServe.enabled` OFF
   until the apply page + terms copy are reviewed; then flip on and link the page.

## Task dependency order

1 -> 2 (needs new order columns) ; 1 -> 3 -> 4 (verify precedes lane) ; 1 -> 5 ;
1,4 -> 6. Execute 1,2,3,4,5,6 in sequence (each reviewed before the next).
