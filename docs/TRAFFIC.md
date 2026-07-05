# Traffic - the acquisition strategy board

Added 2026-07-05. The console's tenth view: a persistent board of acquisition
channels, so traffic strategy lives in the product instead of chat scrollback
or the owner's head. This doc covers what it is, how it is built, the seeding
semantics, and where it is designed to grow.

## What it is (and deliberately is not)

One row per channel that could bring visitors: a platform, a partnership type,
a content play. Each row carries:

| Field | Meaning |
|---|---|
| `status` | `idea` (not started), `testing` (running small), `active` (demonstrably working), `paused` (deliberately parked) |
| `priority` | 1 (work on it now) to 5 (someday) |
| `rationale` | why this channel fits THIS store - grounded, not generic |
| `next_action` | the ONE next step. If it cannot be stated, the channel is not ready to work on |
| `notes` | what actually happened: numbers, dates, verdicts |

It is not an analytics dashboard. It intentionally holds strategy state, not
metrics; metrics hooks are future work (see the last section). The discipline
that keeps it useful: a channel is only `active` when it demonstrably brings
visitors or orders, and every non-paused channel has an honest `next_action`.

## Data model

`traffic_channels` (migration `0022_traffic_channels.sql`), keyed
`(shop, id)`, indexed `(shop, priority)`. All raw D1 access lives in
`TenantStore` per the tenant-isolation guard:

- `listTrafficChannels()` - ordered by priority then name
- `upsertTrafficChannel(c)` - omitted id = create; returns the id
- `deleteTrafficChannel(id)`

## Engine: `src/traffic.ts`

- `STARTER_CHANNELS` - the seven-channel starter strategy (see below)
- `listTrafficBoard(store)` - list + **lazy seed**: a shop's FIRST read seeds
  the starter set, then never again (an emptied board stays empty only if the
  owner deletes every row AND never reloads the view; in practice a fully
  cleared board reseeds on next read - by design, the starter set is the
  fallback strategy, not precious data)
- `validateTrafficPayload(body)` - name <= 120, status enum, priority 1-5,
  free text trimmed and capped (rationale 600, next action 400, notes 1000)
- `trafficChannelForUi(row)` - snake_case row -> camelCase UI shape

## Routes (console-session authed via `shopOf`, in `src/index.ts`)

- `POST /api/traffic` - list (seeds on first read)
- `POST /api/traffic/save` - upsert one channel
- `POST /api/traffic/delete` - delete by id

## Console

- View: `src/console/views/traffic.ts` (`#/traffic`, rail entry between
  Campaigns and Settings). Board rows are clickable; a shared editor card
  (`trf-editor-card`) fills from the clicked row. Delete is two-click armed
  via `prtArm`. Browser JS: `src/console/traffic-js.ts` (standard rules:
  template-literal-safe, `esc()` on every dynamic value, event delegation on
  escaped `data-trf-id` attributes).
- Keyboard: ten routes, nine digits - `1`-`8` reach Glance..Traffic, `9`
  Settings, `0` Help (special-cased in `shell.ts`).
- KB: the Help view has a "Traffic and growth" section covering the board and
  the methodology in owner language.

## The starter strategy (why these seven)

Grounded in what the store runs today - live campaigns with engagement
tracking, a tracked partner voucher funnel, a CJ-sourced catalog under the
competition-aware margin policy:

1. **Google free product listings** (idea, P1) - free Shopping-tab placement
   for the whole catalog; the highest-leverage untouched channel. First step:
   connect the Google and YouTube sales channel, verify the feed.
2. **Email marketing** (active, P1) - fully built (consent read live from
   Shopify, compliance footer, engagement tracking). Owned channel.
3. **Partner and affiliate program** (testing, P1) - the voucher trial IS the
   evaluation; orders attribute per code.
4. **SEO on collections and products** (idea, P2) - cheapest compounding
   asset; start with a title/meta audit.
5. **Short-video social** (idea, P2) - pet content is the most forgiving
   organic niche; product-in-use clips.
6. **Reorder and retention email** (paused, P3) - built, dormant behind
   `RETENTION_REORDER_ENABLED` until order volume justifies reminders.
7. **Paid ads** (idea, P4) - parked behind unit economics: no spend until a
   hero product passes a breakeven-CPA check under the margin policy.

## Tests

`tests/traffic.test.ts` (seed-once, per-shop isolation, ordering, edit/delete
semantics, payload validation, dash rule on seeded copy) plus console pins in
`tests/console.test.ts` (rail entry, ids, endpoints, startup load, escaped
data attributes, armed delete, ROUTES + `0`-key handling).

## Where this grows next (not built)

- **Per-channel signals**: campaigns engagement (email_events) and
  partner-attributed orders already exist in D1 and could render on their
  channel rows; Google Search Console / GA4 would need new integrations.
- **Next-action nudges**: a Glance attention-queue item when a P1 channel's
  next action has not changed in N weeks.
- Keep additions inside the worker per the mitigate-inside-the-system rule.
