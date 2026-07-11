# Blog Distribution System (creative packs + syndication) - design

## Status

Approved direction from the 2026-07-11 brainstorm; spec awaiting owner review.
Builds on the live blog pipeline (worker authors Shopify DRAFT guides, owner
publishes) and the campaigns machinery. Supersedes the syndication half of
`demo-store2/docs/blog-rss-pinterest-traffic-prd.md` (its "Phase 2"): that PRD
predates the worker blog pipeline and recommended Zapier/Make; this design
keeps orchestration inside the worker per the mitigate-inside-the-system rule
and uses Blotato only as a dumb posting rail.

## Summary

Every published guide is already a conversion-ready landing page (quick
answer, FAQ + FAQPage schema, Shop-this-guide combo block). This system
manufactures distribution for each guide automatically and measures which
channel brings buyers:

1. **Creative pack** per published guide: channel-ready images composed from
   the post's real hero image + brand tokens, and one small LLM call that
   writes all channel copy (pin title/description, social caption, email
   teaser, alt text) under the store's customer-facing rules.
2. **Syndication fan-out** with a per-post-per-channel ledger:
   - Social (Pinterest, Facebook, Instagram; later X/Threads/Bluesky as
     config) via the **Blotato unified posting API** (owner decision
     2026-07-11: "Blotato rail, 90-day review").
   - **Email digest** and **partner swipe pack** as auto-drafted campaigns in
     the existing campaigns machinery (sending stays owner-clicked, always).
   - Feed-fed aggregators (Flipboard, Bloglovin, Tumblr) ride the existing
     Shopify Atom feed: owner setup tasks, zero code.
3. **HITL**: per-channel auto toggles, all OFF at first. Publish detection
   queues posts in the console; the owner clicks Send per channel until a
   channel earns its auto switch (same preview-to-full-auto ramp as the
   profit agent).
4. **Measurement**: per-channel UTMs on every link; Shopify analytics
   attributes sessions/sales; email opens/clicks via existing email_events.

Owner-chosen channel set (AskUserQuestion 2026-07-11): Pinterest, email
digest, partner swipe packs, Meta/Instagram, plus the aggregator tier.
Community sites (Reddit/Quora) stay manual forever: the pack's captions serve
as paste-ready swipe copy; no automation (ban risk). Classic article
directories: never (SEO poison).

## Goals

- Zero-marginal-effort distribution: publishing a guide is the only manual
  step required for a post to reach every armed channel.
- Near-zero marginal cost: one small LLM call per post (~1p); no per-post
  fees; the only new spend is Blotato at $29/mo with an explicit 90-day
  earn-it review.
- Owner control that can relax per channel as trust builds.
- Attribution good enough to kill or double down on channels with data.

## Non-goals

- No AI-generated lifestyle imagery (accuracy risk; composition over
  generation). Revisit only if composed creatives underperform.
- No prices on creatives or captions, ever: the profit agent reprices every
  15 minutes; pins live for months. The landing page always shows the live
  price.
- No Zapier/Make/Buffer-style external automation holding the logic.
- No TikTok/video in this system (needs video assets; the Traffic board
  tracks short-video as its own channel).
- No email capture widget on articles in v1 (possible v1.1 flywheel).
- No auto-publish of guides themselves; this system starts at the owner's
  publish action.

## Architecture

New module `src/syndicate/` (mirrors `src/blog/` layering: pure logic
separated from I/O):

- `pack.ts` - creative pack build: caption LLM call + validation; (phase 2)
  image composition.
- `channels.ts` - channel registry + adapter interface
  `{ key, kind: 'blotato' | 'campaign', send(ctx, post, pack): Promise<SendResult> }`.
- `blotato.ts` - thin client for `POST /v2/posts` (one function; per-platform
  target payloads verified at plan time from help.blotato.com).
- `digest.ts` - digest + partner-pack campaign draft builders (reuse
  `src/campaigns.ts` create path; never send).
- `run.ts` - the sweep: detect newly published guides, ensure pack, enqueue
  ledger rows, fire auto channels, retry transient failures (attempts <= 3).

Trigger: the existing 15-minute cron calls the sweep. Publish detection
reuses the drafted-to-published sync (`listPostsSynced` /
`getPublishedMap`); a guide's first appearance as published enqueues it.
Idempotency: `UNIQUE(shop, post_id, channel)` on the ledger means re-runs and
crashes can never double-post.

## Data model

Migration (next free number):

- `syndication_packs`: `shop, post_id` (PK pair, references the blog draft
  row), `captions_json` (the validated copy object), `pin_image_url`,
  `square_image_url` (null until phase 2; v1 posts use the article hero),
  `created_at`, `updated_at`.
- `syndication_ledger`: `shop, post_id, channel, status`
  (`queued|sent|failed|skipped`), `external_id` (pin/post id), `error`,
  `attempts`, `sent_at`, `created_at`; `UNIQUE(shop, post_id, channel)`.

All access via `TenantStore` methods (tenant-isolation guard), same as every
other table.

`tenant_config.syndication`:

```json
{
  "channels": {
    "pinterest": { "enabled": true, "auto": false, "boardId": "..." },
    "facebook":  { "enabled": false, "auto": false, "pageId": "..." },
    "instagram": { "enabled": false, "auto": false }
  },
  "digest": { "mode": "weekly" },
  "partnersPack": { "enabled": true }
}
```

`enabled` = the channel is configured/connected; `auto` = fire on publish
without a click. Digest `mode`: `weekly` (default, bundles the week's guides)
or `per-post`. Digest and partner packs are campaign DRAFTS regardless of any
toggle: the campaigns rule stands, nothing broadcasts from a cron.

## Social rail: Blotato (owner decision, with exit path)

- `BLOTATO_API_KEY` is a worker secret (`wrangler secret put`), handled like
  `RESEND_API_KEY`: never in code, vars, or logs.
- One adapter posts to every connected platform via `POST /v2/posts` with a
  per-platform `target`. Account connections (Pinterest/FB/IG OAuth) happen
  once in Blotato's dashboard, not in our code: no developer-app
  registrations, no Meta app review, no OAuth callback routes in the worker.
- Media: Blotato accepts public image URLs; ours are Shopify CDN URLs.
- **90-day review checkpoint** (record on the Traffic board row at rollout):
  compare per-channel UTM sessions + attributed sales against the $29/mo.
  If only Pinterest earns its keep, build the free native Pinterest adapter
  behind the same `channels.ts` interface and cancel Blotato; the interface
  exists precisely so the rail is swappable without touching pack, ledger,
  console, or UTMs.
- Known vendor cautions (from review research 2026-07-11): small founder-led
  SaaS, weak billing support per some reviews, and **generating an API key
  immediately ends the free trial and starts paid billing** - the owner
  should not generate the key until phase 1 is deploy-ready.

## Creative pack

### Copy (phase 1)

One LLM call per guide (task label `blog-syndication-copy`, text role, ~500-800
tokens) returns JSON:

```json
{ "pinTitle": "...", "pinDesc": "...", "caption": "...", "teaser": "...", "altText": "..." }
```

Validation gates (reject + retry once, else fail the pack build; failed packs
surface in console):

- `sanitizeOutbound` on every field (em/en-dash rule).
- De-brand check against `BRAND_TOKENS` (`src/debrand.ts`).
- No-price gate: reject any field matching a currency amount (pins outlive
  repricing).
- No fulfilment-origin claims (prompt rule, same standing policy as inbox).
- Length caps per channel (Pinterest title <= 100, description <= 500;
  caption <= 2200; teaser <= 300; altText <= 500 - exact platform caps
  verified at plan time).

Prompt grounding: article title, quick-answer text, and the combo product
titles; the copy may only restate what the article says (no new claims).

### Images

- **Phase 1**: the article's hero image as-is (already congruence-checked by
  the vision pass at authoring time; already de-branded at import).
- **Phase 2**: composed brand creatives rendered in-worker: 1000x1500
  Pinterest pin and 1080x1080 square; template = hero image + brand color
  band + title text + logo chip. Candidate stack: satori + resvg-wasm
  (verify bundle-size fit against the Workers limit at plan time; fallback:
  hand-written SVG template + resvg only). Output stored via Shopify Files
  `fileCreate` (verify `write_files` scope; if missing it joins the next
  merchant re-auth; fallback: R2 public bucket).

## Email digest + partner swipe pack (phase 3)

- **Digest**: sweep collects guides published since the last digest campaign;
  weekly mode creates one campaign draft bundling them (subject from titles,
  body = teaser + creative + UTM link per guide), audience `buyers`.
  Appears in the Campaigns view as a normal draft; owner reviews and sends.
- **Partner swipe pack**: per guide, a campaign draft to audience `partners`:
  the article UTM link, the creative, paste-ready captions, and a static
  "share with your voucher code" reminder (no per-recipient merge fields in
  v1; campaigns are broadcast-static today).
- Compliance is inherited wholesale from campaigns: live consent resolution,
  HMAC unsubscribe, RFC 8058 headers, postal address, send ledger.

## UTMs and measurement

Shared helper `utmUrl(articleUrl, channel)`:

- `utm_source`: `pinterest | facebook | instagram | email | partners | ...`
- `utm_medium`: `social | email | affiliate`
- `utm_campaign`: `guide-<article-handle>`

Shopify analytics attributes sessions and sales per source/campaign with no
theme changes. Digest engagement rides existing `email_events`. Rollout adds
a "Blog syndication" row to the Traffic board; the 90-day Blotato review and
per-channel verdicts get recorded in that row's notes.

## Console

Blog view gains a **Distribution** card (same template-literal rules as all
console JS; node smoke test alongside):

- Recent published guides, each with: creative thumbnail(s), captions
  preview, per-channel status chips (`queued / sent / failed / skipped`),
  Send-now button per queued/failed channel (failed shows the error and
  retries), Regenerate-pack button.
- Channel header row: per-channel `auto` toggles + connection state; digest
  mode selector. Toggles persist via a syndication config route.
- Failure/disconnect banner at the top of the Blog view (inbox reply-mode
  banner pattern).

Routes (console-session authed via `shopOf`, in `src/index.ts`):

- `POST /api/syndicate/list` - recent published guides + pack + ledger state.
- `POST /api/syndicate/send` - `{postId, channel}` manual fire (also retry).
- `POST /api/syndicate/regenerate` - rebuild the pack for a post.
- `POST /api/syndicate/config` - save toggles/digest mode.

## Failure handling

- Ledger row records `error` + `attempts`; sweep retries transient failures
  (network/5xx) up to 3 attempts across cron runs; 4xx (bad payload, auth)
  goes straight to `failed` with the error surfaced in console.
- Blotato auth failure (401) marks all Blotato channels disconnected in the
  banner; nothing else in the system is affected.
- Pack-build failure (LLM outage) leaves the post queued with a visible
  error; the outage-hardening rules from 2026-07-10 apply (402 advances
  tiers; floor-served copy is fine here since captions are validated by code
  gates, not confidence).

## Cost

- Per post: one ~800-token Haiku call (~$0.001-0.002) + free API calls.
  Composition is zero-LLM. Digest/partner sends ride existing Resend usage.
- Fixed: Blotato $29/mo (Starter; API on every paid plan), subject to the
  90-day review. No other new subscriptions.

## Security & compliance

- `BLOTATO_API_KEY` via `wrangler secret put` only.
- No tokens in theme JS (nothing theme-side changes at all).
- Customer-facing copy passes the same standing gates as inbox drafts
  (accuracy, de-brand, no fulfilment-origin claims, sanitizeOutbound).
- Consent: digest/partner audiences resolve live at send time exactly as
  campaigns do today; this system never touches consent logic.
- Images: only our own catalog/article imagery; never supplier-branded
  originals (import de-brand already guarantees this).

## Delivery phases

1. **Core + Blotato, hero-image posts**: migration, pack copy build +
   validation, ledger + sweep on the 15-min cron, Blotato adapter
   (Pinterest target first, FB/IG as the owner connects accounts), UTM
   helper, Distribution card + routes + toggles, Traffic board row.
2. **Composed creatives**: pin + square templates, Shopify Files storage,
   thumbnails in console, Blotato posts switch to composed images.
3. **Digest + partner swipe packs**: campaign draft builders + digest mode
   config.

Each phase is independently valuable; plans are written per phase
(writing-plans), starting with phase 1.

## Owner setup checklist (parallel with the build, all free)

- Blotato account (7-day trial; **do not generate the API key until phase 1
  is deploy-ready** - key generation starts billing).
- Pinterest Business account, claim `activepaw.co.uk`, create a "Pet Care
  Guides" board; connect it in Blotato.
- Facebook Page + Instagram business account linked; connect in Blotato.
- Aggregators, one-time: Flipboard / Bloglovin / Tumblr accounts pointed at
  `https://activepaw.co.uk/blogs/guides.atom`.
- (Later, manual tier: Medium/LinkedIn republishing experiments with
  canonical links, one week after original publish.)

## Verification items during planning (do not guess)

- Blotato `/v2/posts` per-platform target payload shapes (Pinterest boardId,
  IG account ref), media URL handling, and rate limits (help.blotato.com).
- Platform copy length caps (Pinterest title/description, IG caption).
- `write_files` in the current Shopify scope set (phase 2 storage).
- satori + resvg-wasm bundle size vs the worker's plan limit (phase 2).
- Exact blog Atom URL renders populated entries (`/blogs/guides.atom`).

## Acceptance criteria (phase 1)

- [ ] Publishing a guide results, within 15 minutes, in a queued Distribution
      row in the console with validated captions and the hero image.
- [ ] Clicking Send for Pinterest creates a real pin (verified on the board)
      whose destination URL carries the correct UTMs; the ledger row stores
      the external id; re-running the sweep never duplicates it.
- [ ] A channel with `auto` on posts without any click on the next sweep
      after publish; channels default to manual.
- [ ] A failed send shows its error in console and can be retried; 3 failed
      attempts stop automatic retries.
- [ ] Captions can never contain a price, a supplier brand token, or an
      em/en-dash (unit tests on the validation gates).
- [ ] No campaign email is ever sent by the cron (digest/partner packs exist
      only as drafts until the owner clicks Send).
