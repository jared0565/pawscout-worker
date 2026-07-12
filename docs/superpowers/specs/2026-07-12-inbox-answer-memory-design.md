# Inbox Answer Memory (approved-answers grounding) - Design

Date: 2026-07-12. Status: owner-approved design (chat, 2026-07-12), spec for the implementation plan.

## Goal

The inbox learns from every reply the owner approves. When a new email resembles a question we already answered - even reworded - the drafter is grounded with the previously approved answers so drafts stay consistent in facts, policy and voice. This is retrieval grounding, NOT a verbatim answer cache: the model still personalizes each reply, and live facts always override recalled text.

## Why

Observed 2026-07-12 (owner): inquiries repeat, often reworded, and every draft is generated from scratch - each generation is a fresh chance to word things differently or get something wrong. The activepaw.com hallucination (Ben Francis thread) is the canonical failure: the most cacheable answer imaginable, fumbled because the model derived it from nothing. Cost is NOT the driver (drafts run on Haiku, pennies per day); consistency and accuracy are.

## Owner decisions (2026-07-12, via AskUserQuestion)

1. **Console surface: Answer library card with per-pair Disable.** View every stored pair; a Disable switch pulls a bad or outdated answer out of recall. No editing - edited answers would drift from what was actually sent and vetted; disable and let the next approved send replace it.
2. **Consistency only - auto-send untouched.** Recall shapes wording and facts. Confidence scoring, the auto-send gates, the quality loop and the per-agent prompts are unchanged. This feature can never cause a send that would not have happened before.

## Non-goals

- No verbatim reply reuse, no "skip the LLM" path (stale-fact risk: destination-, config- and time-dependent claims).
- No embeddings, vector store or new infrastructure. Matching is deterministic token overlap in the worker.
- No change to the partnership/affiliate lane (its own deterministic templates), invoice sends, or campaign/blog surfaces.
- No confidence or auto-send behavior change.

## Architecture

One new module `src/inbox/answer-memory.ts` (normalize, hash, score, recall, capture, backfill), one new table, one capture hook in `send.ts`, one recall hook in `sweep.ts` + prompt block in `draft.ts`, one console card + two session-authed routes.

Data flow: inbound sweep -> classify -> `composeDraftForThread` -> `recallAnswers(store, category, latestInbound)` -> `draftReply(..., recall)` -> quality loop -> owner approves / auto-send -> `sendReply` -> `captureAnswer` upserts the pair. A one-time guarded backfill imports history from existing threads.

## Data contract

Migration `0031_answer_memory.sql`:

```sql
CREATE TABLE answer_memory (
  shop          TEXT NOT NULL,
  qhash         TEXT NOT NULL,            -- FNV-1a 64-bit hex of category + '|' + question_norm
  category      TEXT NOT NULL,            -- thread primary_category at capture
  question_text TEXT NOT NULL,            -- customer's message, quote-chain stripped, capped 1500 chars
  question_norm TEXT NOT NULL,            -- canonical token string used for matching
  answer_text   TEXT NOT NULL,            -- final SENT substance (salutation/footer/postscript stripped), capped 2000 chars
  thread_id     TEXT NOT NULL,            -- provenance
  disabled      INTEGER NOT NULL DEFAULT 0,
  used_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (shop, qhash)
);
CREATE INDEX idx_answer_memory_recall ON answer_memory (shop, disabled, updated_at);
```

The PK on `(shop, qhash)` makes the memory self-refreshing: re-answering the same normalized question REPLACES the stored answer with the newest vetted one (upsert keeps `used_count`, bumps `updated_at`). Near-duplicates never accumulate.

## Matching (deterministic, zero LLM)

- **Normalize**: lowercase; punctuation to spaces; collapse whitespace; drop a small fixed stopword list (greetings, articles, auxiliaries, courtesy words) and 1-char tokens; keep numbers (sizes/quantities carry meaning). `question_norm` = unique tokens, sorted, space-joined.
- **Score** a new question A against a stored question B on token sets: `score = |A intersect B| / sqrt(|A| * |B|)` (set cosine). Same-category pairs get +0.1, applied BEFORE the threshold test (a same-category match clears the bar slightly easier). A thread with no `primary_category` gets no bonus and matches globally.
- **Accept** when `|A intersect B| >= 2` AND `score >= 0.45`. Rank score desc, then `updated_at` desc. **Top 2** pairs injected.
- **Freshness**: only pairs with `updated_at` within **180 days**. **Disabled pairs excluded.**
- Recall reads up to 500 fresh enabled rows and scores in JS - at the shop's volume (238 sends, 165 threads today) this is years of headroom; the cap is the safety valve.

## Prompt injection (draft.ts)

`draftReply` input gains `recall?: { question: string; answer: string }[]` (question capped 200 chars, answer 500 for the prompt). `buildDraftSystem` appends, after the grounded facts and before the output contract:

> "Previously approved answers to similar past questions - use them to stay consistent in facts, policy and voice. If anything in them conflicts with the store facts or grounded facts above, the facts above WIN (past answers can be out of date). NEVER copy personal details from them: names, destinations, addresses, quantities, prices or order numbers belong to OTHER customers. [Q: ... A: ...] [Q: ... A: ...]"

The block also flows through the revision loop (same `buildDraftSystem` options), so quality revisions keep the grounding.

## Capture (send.ts)

After a successful `sendReply` (owner-approved, owner-edited via `bodyTextOverride`, or auto-send - the FINAL text on the wire):

- Question = the thread's latest inbound, quote-chain stripped via the existing `stripQuotedReply` (`src/inbox/quote.ts` - the same helper `composeDraftForThread` grounds on).
- Answer = sent body minus the deterministic wrapper: leading salutation line ("Hi X,"), trailing footer block ("Best Regards,\n<department>") and anything after it (the P.S. slot).
- Skip when: category is `spam` or `automated`, the thread is the partnership/affiliate lane, question or answer is empty after stripping.
- Fire-and-forget: a capture failure logs a warning and never blocks or fails the send. Invoice sends (`send-invoice.ts`) are not captured.

## Backfill (one-time)

Guarded by a `search_cache` flag (`job:answer-backfill`, ~10-year TTL): on the first inbox sweep after deploy, walk existing threads (same category exclusions), pair each outbound message with the nearest preceding inbound (quote-stripped), and capture with the send's timestamp. Today that imports roughly a hundred vetted pairs. Idempotent: the flag prevents re-runs, and the qhash PK makes an accidental re-run harmless.

## Console: Answer library (Inbox view)

A card listing pairs newest-first (up to 100): question snippet, answer snippet, category chip, times used, last used, and a per-pair **Disable/Enable** toggle. Header shows the total and how many are disabled. Same template-literal rules as every view (no backticks/dollar-brace, esc() every dynamic, data-* + delegation, run tests/console.test.ts).

Routes (session-authed, same shape as the other inbox routes):
- `POST /api/inbox/answers` -> `{ ok, total, disabled, rows: [{ qhash, category, question, answer, usedCount, lastUsedAt, updatedAt, disabled }] }`
- `POST /api/inbox/answers/toggle` `{ qhash, disabled }` -> `{ ok }`

## Error handling

- Recall throws -> caught in `composeDraftForThread`, draft proceeds with no recall (exactly today's behavior).
- Capture throws -> warn log, send unaffected.
- Backfill throws mid-run -> flag not set, next sweep retries; qhash PK dedupes whatever landed.
- Empty/short questions (all-quote follow-ups) produce no tokens -> no capture, no recall.

## Testing

- `tests/inbox-answer-memory.test.ts`: normalization (stopwords, numbers kept, canonical form); scoring + thresholds (reworded match accepted, unrelated rejected, category bonus, top-2 cap, freshness window, disabled excluded); qhash stability; capture stripping (salutation/footer/P.S. removed, spam/affiliate/empty skipped); upsert-replaces semantics; backfill pairing + idempotence.
- `tests/inbox-draft.test.ts` additions: recall block present with the override + no-personal-details wording; absent when no recall; flows through the revise loop.
- `tests/inbox-send.test.ts` additions: successful send captures the pair with the FINAL (possibly owner-edited) text; capture failure does not fail the send.
- `tests/console.test.ts`: Answer library card pins (ids, routes, delegation attributes, esc() usage).

## Rollout

Migration 0031 applied remote BEFORE deploy (new table only - invisible to the running worker). Ships enabled: capture and recall are inert until pairs exist, and the backfill populates history on the first sweep. No new secrets, no config flags, zero added LLM spend.
