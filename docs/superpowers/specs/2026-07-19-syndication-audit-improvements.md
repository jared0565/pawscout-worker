# Syndication engine audit + hardening (2026-07-19)

Owner ask: "Audit the syndication agent, look for weaknesses and improve it
for optimized result." Full read of src/syndicate (run/pack/channels/blotato),
the store layer, routes, console card, spec and tests, plus live-state checks.

## Live state at audit time

The system has NEVER run in production: `tenant_config.syndicate = '{}'` (all
channels disabled), `syndication_ledger` and `syndication_packs` empty, and
BLOTATO_API_KEY absent from the worker secrets. Every finding below was fixed
before first live use, which also made the copy-schema change free (no stored
packs to migrate).

## Findings and fixes (all shipped in this commit)

1. **Unpublished-article send hole (correctness, worst finding).**
   `listPostsSynced` only syncs drafted-to-published; unpublishing a guide in
   Shopify leaves D1 `published` forever, and the sweep would post a social
   link to a 404. `getArticlesForSyndication` already fetched `isPublished`
   and the engine ignored it. Fix: `ensurePack({requirePublished:true})`
   checks LIVE publish state even when a pack is cached; the sweep and the
   manual send route both set it. Unpublished = rows stay queued with a
   visible reason; nothing posts.

2. **Copy grounded only on the title (quality; spec drift).** The 07-11 spec
   promised quick-answer grounding; the implementation fed only title +
   collection + de-slugged handles. Fix: the syndication query now fetches
   the article `body`, `quickAnswerText()` extracts the opening paragraph,
   and the copy call is grounded on it (caption told to lead with the most
   useful takeaway, pinDesc told to weave in real search phrases).

3. **First-enable burst (results/authenticity).** Enabling a channel with a
   backlog of published guides would auto-fire the whole backlog in one
   sweep; burst posting reads as bot behaviour on FB/IG. Fix:
   `AUTO_SEND_COOLDOWN_MS` (6h) per channel: at most one auto send per
   channel per window, manual console sends exempt and respected (an owner
   post starts the window). A backlog now drips out like a human would post.

4. **Eternal 15-minute LLM retry on a failing pack build (cost).** A post
   whose pack build permanently fails (gated copy, deleted article) retried
   the LLM every sweep, 96/day forever. Fix: `PACK_ERROR_BACKOFF_MS` (2h)
   keyed on the `pack build failed` error prefix; cheap gate errors (e.g.
   unpublished) still recheck every sweep.

5. **Stuck-'sent' silence (observability).** A submission Blotato accepted
   but never resolves stayed `sent` silently forever. Fix:
   `CONFIRM_STALE_MS` (24h) writes a visible note on the row; status stays
   `sent` (still polled, never guessed, never re-fired).

6. **Instagram discovery (results).** Caption was shared FB/IG with a
   near-no-hashtag rule. Fix: optional `hashtags` copy field (3-5 tags,
   hard-gated: shape regex, count, brand tokens, price gate, sanitize),
   appended after the link on Instagram only, inside the 2200 budget that
   never truncates the link or a tag. Absent field = old behaviour, so packs
   without it stay valid.

7. **Ledger window (latent).** The sweep read the display default 300 rows;
   past ~100 posts x 3 channels the dedupe set and confirm stage would go
   blind. Sweep now reads 1000 explicitly.

## Deliberately NOT done (owner-visible notes)

- **Blotato `scheduledTime`/`useNextFreeSlot` engagement-window scheduling**:
  real optimizer, but picking posting windows is an owner/audience decision
  and the drip cooldown already prevents the pathological case. Revisit once
  channels are live and UTM data exists.
- **Re-syndication of evergreen guides** (second pin months later): the
  ledger PK (shop, post_id, channel) structurally forbids re-sends today;
  a deliberate phase-2+ feature, not a quiet change.
- **Unpublish sync-back into D1 blog status**: the send gate closes the
  safety hole; a full status back-sync touches the console list semantics
  and was left alone.
- **Activation itself**: the whole rail stays dormant until the owner
  completes the setup checklist (Blotato account + BLOTATO_API_KEY secret +
  channel wiring in the console). No code change can produce results before
  that.

## Test coverage added

47 tests in tests/syndicate.test.ts (14 new): publish gate (sweep path +
cached-pack path), quick-answer grounding (buildCopy payload + engine
plumbing), drip cooldown (backlog of 2, window elapse), pack-build backoff
(LLM call counting, stale-error retry), stale-sent watchdog, hashtag gates
(optional/absent, shape, count, brand, non-string), IG payload with tags
(placement + budget). GraphQL change validated against Admin 2026-04
(read_content scope already held).
