# Inbox Answer Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every approved inbox reply becomes a stored Q->A pair; new drafts are grounded with the closest previously-approved answers (deterministic recall, zero LLM cost), with an Answer library console card and per-pair disable.

**Architecture:** One new module `src/inbox/answer-memory.ts` (normalize/hash/strip/recall/capture/backfill) over one new D1 table `answer_memory`. Capture hooks into `sendReply` (fire-and-forget), recall hooks into `composeDraftForThread` and is injected into the drafter's system prompt by `buildDraftSystem`, a flag-guarded one-time backfill runs at the top of the inbox sweep. Two session-authed routes + a console card complete it. Spec: `docs/superpowers/specs/2026-07-12-inbox-answer-memory-design.md`.

**Tech Stack:** Cloudflare Worker (Hono), D1, vitest (`@cloudflare/vitest-pool-workers`, migrations auto-applied from `migrations/` via `applyD1Migrations`), console = template-literal HTML/CSS/JS in `src/console/`.

## Global Constraints

- **Auto-send behavior unchanged**: confidence scoring, `autoSendDecision`, the quality loop and per-agent prompts are NOT modified. Recall shapes wording only.
- **Zero new LLM spend**: recall and capture are fully deterministic. No new `logLlmUsage` tasks.
- **No em-dash or en-dash anywhere** (code, comments, UI copy, test strings). Use hyphens.
- **Console template-literal rules** (browser JS lives inside TS template literals; tsc cannot see it): no backticks or `${}` inside the browser-JS strings, string-build with `+`, `esc()` every dynamic value, third-party/dynamic values ride `data-*` attributes resolved by delegated click handlers (never inline `onclick` with interpolated values). Run `tests/console.test.ts` after ANY `src/console/` edit.
- **Recall injection wording** (exact, from the spec): starts `Previously approved answers to similar past questions - use them to stay consistent in facts, policy and voice.` and includes `the facts above WIN` and `NEVER copy personal details`.
- **Matching numbers** (exact): overlap `>= 2` tokens AND score `>= 0.45` where `score = |A intersect B| / sqrt(|A|*|B|)` plus `+0.1` same-category bonus applied BEFORE the threshold; top **2** pairs; freshness window **180 days** on `updated_at`; candidate read cap **500**; prompt caps question **200** / answer **500** chars; stored caps question **1500** / answer **2000** chars.
- **Excluded from capture/backfill**: categories `spam`, `automated`, `affiliate`, and any partnership-lane thread (`isPartnershipLane`). Invoice sends are not captured.
- **Vitest wedge caution**: run test files in ONE `npx vitest run` invocation per step; if a run dies with ConnectEx/1225 errors, wait 60-75 seconds before retrying.
- After each task's commit, `git push` (standing repo rule).

---

### Task 1: Migration + store layer

**Files:**
- Create: `migrations/0031_answer_memory.sql`
- Modify: `src/tenant-store.ts` (add `AnswerMemoryRow` near the other row interfaces ~line 90; add the five methods next to `logLlmUsage`/`llmUsageDaily` ~line 790)
- Test: `tests/inbox-answer-memory.test.ts` (create)

**Interfaces:**
- Consumes: existing `TenantStore` patterns (`this.db.prepare(...).bind(this.shop, ...)`).
- Produces (Tasks 2/5 rely on these exact signatures):
  - `interface AnswerMemoryRow { qhash: string; category: string; question_text: string; question_norm: string; answer_text: string; thread_id: string; disabled: number; used_count: number; last_used_at: string | null; created_at: string; updated_at: string }`
  - `upsertAnswerMemory(rec: { qhash: string; category: string; questionText: string; questionNorm: string; answerText: string; threadId: string; at?: string }): Promise<void>`
  - `listAnswerMemory(limit?: number): Promise<{ total: number; disabled: number; rows: { qhash: string; category: string; question: string; answer: string; usedCount: number; lastUsedAt: string | null; updatedAt: string; disabled: number }[] }>`
  - `setAnswerDisabled(qhash: string, disabled: boolean): Promise<boolean>`
  - `listRecallCandidates(sinceIso: string, limit?: number): Promise<AnswerMemoryRow[]>`
  - `bumpAnswerUsage(qhashes: string[]): Promise<void>`

- [ ] **Step 1: Write the migration**

`migrations/0031_answer_memory.sql`:

```sql
-- Inbox answer memory (2026-07-12): every approved reply becomes a vetted
-- question->answer pair; drafts are grounded with the closest matches
-- (retrieval grounding, never a verbatim cache). PK (shop, qhash) makes the
-- memory self-refreshing: re-answering the same normalized question REPLACES
-- the stored answer with the newest vetted one.
CREATE TABLE answer_memory (
  shop          TEXT NOT NULL,
  qhash         TEXT NOT NULL,
  category      TEXT NOT NULL,
  question_text TEXT NOT NULL,
  question_norm TEXT NOT NULL,
  answer_text   TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  used_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (shop, qhash)
);
CREATE INDEX idx_answer_memory_recall ON answer_memory (shop, disabled, updated_at);
```

- [ ] **Step 2: Write the failing store tests**

`tests/inbox-answer-memory.test.ts` (new file - Task 2 appends more describes to it):

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const store = () => new TenantStore(env.DB, SHOP);

function pair(over: Partial<{ qhash: string; category: string; questionText: string; questionNorm: string; answerText: string; threadId: string; at: string }> = {}) {
  return {
    qhash: 'h1', category: 'shipping-returns',
    questionText: 'Do you ship worldwide?', questionNorm: 'ship worldwide',
    answerText: 'Yes, we ship internationally to most countries.', threadId: 't1', ...over,
  };
}

describe('answer_memory store layer', () => {
  it('upserts, lists newest-first with camelCase mapping and counts', async () => {
    const s = store();
    await s.upsertAnswerMemory(pair({ qhash: 'h1', at: '2026-07-01T00:00:00.000Z' }));
    await s.upsertAnswerMemory(pair({ qhash: 'h2', questionNorm: 'delivery texas', questionText: 'How long to Texas?', answerText: 'Typically 4-13 days.', at: '2026-07-02T00:00:00.000Z' }));
    const r = await s.listAnswerMemory();
    expect(r.total).toBe(2);
    expect(r.disabled).toBe(0);
    expect(r.rows[0].qhash).toBe('h2'); // newest updated_at first
    expect(r.rows[0].question).toBe('How long to Texas?');
    expect(r.rows[0].usedCount).toBe(0);
  });

  it('re-upserting the same qhash REPLACES the answer, re-enables, and keeps used_count', async () => {
    const s = store();
    await s.upsertAnswerMemory(pair());
    await s.bumpAnswerUsage(['h1']);
    await s.setAnswerDisabled('h1', true);
    await s.upsertAnswerMemory(pair({ answerText: 'Yes - and UK delivery is currently free.' }));
    const r = await s.listAnswerMemory();
    expect(r.total).toBe(1);
    expect(r.rows[0].answer).toBe('Yes - and UK delivery is currently free.');
    expect(r.rows[0].disabled).toBe(0);   // fresh vetted answer re-enables the pair
    expect(r.rows[0].usedCount).toBe(1);  // usage history preserved
  });

  it('setAnswerDisabled flips the flag and reports a missing qhash', async () => {
    const s = store();
    await s.upsertAnswerMemory(pair());
    expect(await s.setAnswerDisabled('h1', true)).toBe(true);
    expect((await s.listAnswerMemory()).disabled).toBe(1);
    expect(await s.setAnswerDisabled('nope', true)).toBe(false);
  });

  it('listRecallCandidates honors disabled and the freshness cutoff', async () => {
    const s = store();
    await s.upsertAnswerMemory(pair({ qhash: 'fresh', at: '2026-07-01T00:00:00.000Z' }));
    await s.upsertAnswerMemory(pair({ qhash: 'stale', at: '2025-01-01T00:00:00.000Z' }));
    await s.upsertAnswerMemory(pair({ qhash: 'off', at: '2026-07-01T00:00:00.000Z' }));
    await s.setAnswerDisabled('off', true);
    const rows = await s.listRecallCandidates('2026-01-01T00:00:00.000Z');
    expect(rows.map((r) => r.qhash)).toEqual(['fresh']);
  });

  it('bumpAnswerUsage increments count and stamps last_used_at for the given hashes only', async () => {
    const s = store();
    await s.upsertAnswerMemory(pair({ qhash: 'h1' }));
    await s.upsertAnswerMemory(pair({ qhash: 'h2', questionNorm: 'other tokens' }));
    await s.bumpAnswerUsage(['h1']);
    await s.bumpAnswerUsage(['h1']);
    const rows = (await s.listAnswerMemory()).rows;
    const h1 = rows.find((r) => r.qhash === 'h1')!;
    const h2 = rows.find((r) => r.qhash === 'h2')!;
    expect(h1.usedCount).toBe(2);
    expect(h1.lastUsedAt).toBeTruthy();
    expect(h2.usedCount).toBe(0);
    await s.bumpAnswerUsage([]); // no-op, must not throw
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/inbox-answer-memory.test.ts`
Expected: FAIL - `upsertAnswerMemory is not a function` (migration applies automatically; the methods do not exist yet).

- [ ] **Step 4: Implement the store layer**

In `src/tenant-store.ts`, add the row interface near the other row interfaces (after `ProfitActionRow`):

```ts
/** One vetted Q->A pair of the inbox answer memory (approved-answers grounding). */
export interface AnswerMemoryRow {
  qhash: string;         // FNV-1a 64-bit hex of category + '|' + question_norm
  category: string;
  question_text: string;
  question_norm: string; // canonical token string used for matching
  answer_text: string;   // final SENT substance (salutation/footer stripped)
  thread_id: string;
  disabled: number;      // 1 = owner pulled this pair out of recall
  used_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}
```

Add the methods next to `llmUsageDaily`:

```ts
  /** Upsert one vetted Q->A pair. Re-answering the same normalized question
   * REPLACES the stored answer with the newest vetted one, re-enables a
   * disabled pair (the new send is fresh vetted content), and preserves the
   * usage history. `at` backdates backfilled pairs to their real send time. */
  async upsertAnswerMemory(rec: { qhash: string; category: string; questionText: string; questionNorm: string; answerText: string; threadId: string; at?: string }): Promise<void> {
    const now = rec.at ?? new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO answer_memory (shop, qhash, category, question_text, question_norm, answer_text, thread_id, disabled, used_count, last_used_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, NULL, ?8, ?8)
         ON CONFLICT(shop, qhash) DO UPDATE SET
           question_text = ?4, answer_text = ?6, thread_id = ?7, disabled = 0, updated_at = ?8`
      )
      .bind(this.shop, rec.qhash, rec.category, rec.questionText, rec.questionNorm, rec.answerText, rec.threadId, now)
      .run();
  }

  /** The Answer library card: pairs newest-first plus totals. */
  async listAnswerMemory(limit = 100): Promise<{ total: number; disabled: number; rows: { qhash: string; category: string; question: string; answer: string; usedCount: number; lastUsedAt: string | null; updatedAt: string; disabled: number }[] }> {
    const counts = await this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(disabled), 0) AS off FROM answer_memory WHERE shop = ?1`)
      .bind(this.shop)
      .first<{ total: number; off: number }>();
    const rs = await this.db
      .prepare(
        `SELECT qhash, category, question_text, answer_text, used_count, last_used_at, updated_at, disabled
         FROM answer_memory WHERE shop = ?1 ORDER BY updated_at DESC LIMIT ?2`
      )
      .bind(this.shop, Math.min(Math.max(limit, 1), 200))
      .all<AnswerMemoryRow>();
    return {
      total: counts?.total ?? 0,
      disabled: counts?.off ?? 0,
      rows: (rs.results ?? []).map((r) => ({
        qhash: r.qhash, category: r.category, question: r.question_text, answer: r.answer_text,
        usedCount: r.used_count, lastUsedAt: r.last_used_at, updatedAt: r.updated_at, disabled: r.disabled,
      })),
    };
  }

  /** Owner Disable/Enable on one pair (recall skips disabled pairs). */
  async setAnswerDisabled(qhash: string, disabled: boolean): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE answer_memory SET disabled = ?3, updated_at = updated_at WHERE shop = ?1 AND qhash = ?2`)
      .bind(this.shop, qhash, disabled ? 1 : 0)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Fresh enabled pairs for recall scoring (scored in JS by the caller). */
  async listRecallCandidates(sinceIso: string, limit = 500): Promise<AnswerMemoryRow[]> {
    const rs = await this.db
      .prepare(
        `SELECT qhash, category, question_text, question_norm, answer_text, thread_id, disabled, used_count, last_used_at, created_at, updated_at
         FROM answer_memory WHERE shop = ?1 AND disabled = 0 AND updated_at >= ?2 ORDER BY updated_at DESC LIMIT ?3`
      )
      .bind(this.shop, sinceIso, limit)
      .all<AnswerMemoryRow>();
    return rs.results ?? [];
  }

  /** Mark pairs as recalled (usage stats on the library card). */
  async bumpAnswerUsage(qhashes: string[]): Promise<void> {
    if (!qhashes.length) return;
    const placeholders = qhashes.map((_, i) => `?${i + 3}`).join(',');
    await this.db
      .prepare(`UPDATE answer_memory SET used_count = used_count + 1, last_used_at = ?2 WHERE shop = ?1 AND qhash IN (${placeholders})`)
      .bind(this.shop, new Date().toISOString(), ...qhashes)
      .run();
  }
```

Note on `setAnswerDisabled`: `updated_at = updated_at` is deliberate - a toggle is not fresh content and must not extend the pair's freshness window.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/inbox-answer-memory.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add migrations/0031_answer_memory.sql src/tenant-store.ts tests/inbox-answer-memory.test.ts
git commit -m "feat(inbox): answer_memory table + store layer (migration 0031)"
git push
```

---

### Task 2: The answer-memory module (normalize, hash, strip, recall, capture, backfill)

**Files:**
- Create: `src/inbox/answer-memory.ts`
- Test: `tests/inbox-answer-memory.test.ts` (append describes)

**Interfaces:**
- Consumes (Task 1): `upsertAnswerMemory`, `listRecallCandidates`, `bumpAnswerUsage`; existing `stripQuotedReply` (`src/inbox/quote.ts`), `isPartnershipLane` (`src/inbox/partnership.ts`), `store.listThreads(status: string | null, limit)`, `store.getThreadWithMessages(threadId)`, `store.getSearchCache(key)` / `store.putSearchCache(key, payload, ttlDays)`.
- Produces (Tasks 3/4 rely on these exact signatures):
  - `normalizeQuestion(text: string): string[]` - sorted unique tokens
  - `fnv1a64(s: string): string` - 16-char hex
  - `qhashOf(category: string, questionNorm: string): string`
  - `stripAnswerSubstance(sentBody: string): string`
  - `recallAnswers(store: TenantStore, category: string | null, question: string): Promise<{ question: string; answer: string }[]>`
  - `captureAnswerPair(store: TenantStore, thread: { id: string; primary_category: string | null }, questionStripped: string, sentBody: string, partnershipLane: boolean, at: string): Promise<boolean>`
  - `captureAnswerFromSend(store: TenantStore, thread: { id: string; primary_category: string | null }, messages: { direction: string; body_text: string | null }[], sentBody: string, partnershipLane: boolean, at: string): Promise<boolean>`
  - `backfillAnswerMemory(store: TenantStore): Promise<number>`
  - `ensureAnswerBackfill(store: TenantStore): Promise<void>` and `export const ANSWER_BACKFILL_FLAG = 'job:answer-backfill'`

- [ ] **Step 1: Write the failing tests** (append to `tests/inbox-answer-memory.test.ts`)

```ts
import { normalizeQuestion, fnv1a64, qhashOf, stripAnswerSubstance, recallAnswers, captureAnswerPair, captureAnswerFromSend, backfillAnswerMemory, ensureAnswerBackfill, ANSWER_BACKFILL_FLAG } from '../src/inbox/answer-memory';

describe('normalizeQuestion', () => {
  it('lowercases, drops stopwords/punctuation/1-char tokens, keeps numbers, sorts unique', () => {
    expect(normalizeQuestion('Hi! Do you ship to Texas, USA? Thanks!')).toEqual(['ship', 'texas', 'usa']);
    expect(normalizeQuestion('Is the 90x60 cm dog bed washable? washable??')).toEqual(['90x60', 'bed', 'cm', 'dog', 'washable']);
    expect(normalizeQuestion('')).toEqual([]);
  });
});

describe('fnv1a64 / qhashOf', () => {
  it('is deterministic 16-hex and distinct across inputs and categories', () => {
    expect(fnv1a64('ship worldwide')).toBe(fnv1a64('ship worldwide'));
    expect(fnv1a64('ship worldwide')).toMatch(/^[0-9a-f]{16}$/);
    expect(fnv1a64('ship worldwide')).not.toBe(fnv1a64('ship worldwid'));
    expect(qhashOf('lead', 'ship worldwide')).not.toBe(qhashOf('other', 'ship worldwide'));
  });
});

describe('stripAnswerSubstance', () => {
  it('strips our salutation, footer and anything after it (the P.S. slot)', () => {
    const sent = 'Hi Ben,\n\nYes, we ship worldwide.\nTracking follows.\n\nBest Regards,\nActive Paw Sales Team\n\nP.S. Try the search bar.';
    expect(stripAnswerSubstance(sent)).toBe('Yes, we ship worldwide.\nTracking follows.');
  });
  it('passes through a body with no wrapper', () => {
    expect(stripAnswerSubstance('Just the substance.')).toBe('Just the substance.');
  });
});

describe('recallAnswers', () => {
  const seed = async (s: TenantStore, qhash: string, category: string, question: string, answer: string, at = '2026-07-01T00:00:00.000Z') => {
    const norm = normalizeQuestion(question).join(' ');
    await s.upsertAnswerMemory({ qhash, category, questionText: question, questionNorm: norm, answerText: answer, threadId: 't-' + qhash, at });
  };

  it('matches a REWORDED question and bumps usage', async () => {
    const s = store();
    // Seed tokens {ship, worldwide, within, country}; query tokens {worldwide,
    // shipping, country, possible}: overlap 2 -> 2/sqrt(16) = 0.5 (+0.1 same
    // category). No stemming, so the reword must share 2 content tokens.
    await seed(s, 'a1', 'shipping-returns', 'Do you ship worldwide or only within your country?', 'Yes, we ship internationally to most countries.');
    const r = await recallAnswers(s, 'shipping-returns', 'Is worldwide shipping to my country possible?');
    expect(r.length).toBe(1);
    expect(r[0].answer).toContain('internationally');
    expect((await s.listAnswerMemory()).rows[0].usedCount).toBe(1);
  });

  it('rejects an unrelated question, respects disabled + freshness, caps at top 2', async () => {
    const s = store();
    await seed(s, 'a1', 'lead', 'Worldwide shipping to any country?', 'A1: yes worldwide shipping.');
    await seed(s, 'a2', 'lead', 'Worldwide shipping available for you?', 'A2: yes shipping worldwide.');
    await seed(s, 'a3', 'lead', 'Is worldwide shipping possible anywhere?', 'A3: shipping worldwide yes.');
    await seed(s, 'a4', 'lead', 'What food fits a kitten?', 'Kitten food answer.');
    await seed(s, 'old', 'lead', 'Shipping worldwide soon?', 'Old.', '2025-01-01T00:00:00.000Z');
    await s.setAnswerDisabled('a3', true);
    const r = await recallAnswers(s, 'lead', 'do you offer worldwide shipping?');
    expect(r.length).toBe(2); // a1+a2 (a3 disabled, old stale, a4 unrelated)
    expect(r.every((x) => x.answer.includes('worldwide'))).toBe(true);
    const none = await recallAnswers(s, 'lead', 'completely different topic entirely');
    expect(none).toEqual([]);
  });

  it('same-category bonus counts toward the threshold', async () => {
    const s = store();
    // Sets sized 6 and 5 sharing 2 tokens (harness, walking): 2/sqrt(30) = 0.365
    // cross-category (< 0.45, rejected); +0.1 same-category = 0.465 (accepted).
    await seed(s, 'b1', 'lead', 'blue harness small dog walking set', 'Harness answer.');
    const inCat = await recallAnswers(s, 'lead', 'harness walking large breed collie');
    const outCat = await recallAnswers(s, 'product-question', 'harness walking large breed collie');
    expect(inCat.length).toBe(1);
    expect(outCat.length).toBe(0);
  });

  it('returns [] for questions with fewer than 2 usable tokens', async () => {
    const s = store();
    await seed(s, 'a1', 'lead', 'Do you ship worldwide?', 'Yes.');
    expect(await recallAnswers(s, 'lead', 'thanks!')).toEqual([]);
  });
});

describe('captureAnswerPair / captureAnswerFromSend', () => {
  const thread = { id: 'th1', primary_category: 'lead' };
  const sent = 'Hi Ben,\n\nYes, we ship worldwide to most countries.\n\nBest Regards,\nActive Paw Sales Team';

  it('captures the stripped substance keyed by category+norm', async () => {
    const s = store();
    const ok = await captureAnswerPair(s, thread, 'Do you ship worldwide?', sent, false, '2026-07-12T00:00:00.000Z');
    expect(ok).toBe(true);
    const rows = (await s.listAnswerMemory()).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].answer).toBe('Yes, we ship worldwide to most countries.');
    expect(rows[0].category).toBe('lead');
  });

  it('skips excluded categories, partnership lane, and empty question/answer', async () => {
    const s = store();
    expect(await captureAnswerPair(s, { id: 't', primary_category: 'spam' }, 'q tokens here', sent, false, '2026-07-12T00:00:00.000Z')).toBe(false);
    expect(await captureAnswerPair(s, { id: 't', primary_category: 'automated' }, 'q tokens here', sent, false, '2026-07-12T00:00:00.000Z')).toBe(false);
    expect(await captureAnswerPair(s, { id: 't', primary_category: 'affiliate' }, 'q tokens here', sent, false, '2026-07-12T00:00:00.000Z')).toBe(false);
    expect(await captureAnswerPair(s, thread, 'q tokens here', sent, true, '2026-07-12T00:00:00.000Z')).toBe(false);
    expect(await captureAnswerPair(s, thread, '', sent, false, '2026-07-12T00:00:00.000Z')).toBe(false);
    expect(await captureAnswerPair(s, thread, 'thanks', sent, false, '2026-07-12T00:00:00.000Z')).toBe(false); // <2 tokens
    expect(await captureAnswerPair(s, thread, 'q tokens here', 'Hi Ben,\n\nBest Regards,\nActive Paw Sales Team', false, '2026-07-12T00:00:00.000Z')).toBe(false); // empty substance
    expect((await s.listAnswerMemory()).total).toBe(0);
  });

  it('captureAnswerFromSend pairs with the LAST inbound, quote-stripped', async () => {
    const s = store();
    const messages = [
      { direction: 'inbound', body_text: 'First question about beds?' },
      { direction: 'outbound', body_text: 'Answer 1' },
      { direction: 'inbound', body_text: 'How long is delivery to Texas?\n\nOn Fri Jul 10 Active Paw <support@activepaw.co.uk> wrote:\n> Answer 1' },
    ];
    const ok = await captureAnswerFromSend(s, thread, messages, sent, false, '2026-07-12T00:00:00.000Z');
    expect(ok).toBe(true);
    const rows = (await s.listAnswerMemory()).rows;
    expect(rows[0].question).toContain('Texas');
    expect(rows[0].question).not.toContain('wrote:');
  });
});

describe('backfill', () => {
  async function seedThread(id: string, category: string, msgs: { dir: 'inbound' | 'outbound'; body: string; at: string }[]) {
    const now = '2026-07-01T00:00:00.000Z';
    await env.DB.prepare(
      `INSERT INTO inbox_threads (shop, id, contact_email, subject, status, primary_category, last_message_at, created_at, updated_at)
       VALUES (?1, ?2, 'c@x.com', 's', 'awaiting_customer', ?3, ?4, ?4, ?4)`
    ).bind(SHOP, id, category, now).run();
    for (let i = 0; i < msgs.length; i++) {
      await env.DB.prepare(
        `INSERT INTO inbox_messages (shop, id, thread_id, direction, from_addr, body_text, received_at, created_at)
         VALUES (?1, ?2, ?3, ?4, 'f@x.com', ?5, ?6, ?6)`
      ).bind(SHOP, id + '-m' + i, id, msgs[i].dir, msgs[i].body, msgs[i].at).run();
    }
  }

  it('imports pairs from history, skipping excluded categories, and is flag-guarded', async () => {
    const s = store();
    await seedThread('t1', 'lead', [
      { dir: 'inbound', body: 'Do you ship worldwide or only domestically?', at: '2026-06-01T00:00:00.000Z' },
      { dir: 'outbound', body: 'Hi Ben,\n\nYes, worldwide shipping is available.\n\nBest Regards,\nActive Paw Sales Team', at: '2026-06-01T01:00:00.000Z' },
    ]);
    await seedThread('t2', 'spam', [
      { dir: 'inbound', body: 'Buy my SEO service for growth?', at: '2026-06-02T00:00:00.000Z' },
      { dir: 'outbound', body: 'Hi there,\n\nNo thanks kindly.\n\nBest Regards,\nActive Paw Customer Support', at: '2026-06-02T01:00:00.000Z' },
    ]);
    const n = await backfillAnswerMemory(s);
    expect(n).toBe(1);
    const r = await s.listAnswerMemory();
    expect(r.total).toBe(1);
    expect(r.rows[0].answer).toBe('Yes, worldwide shipping is available.');
    expect(r.rows[0].updatedAt).toBe('2026-06-01T01:00:00.000Z'); // backdated to the send

    // ensureAnswerBackfill: first run sets the flag, second is a no-op even with new threads
    await env.DB.prepare(`DELETE FROM answer_memory WHERE shop = ?1`).bind(SHOP).run();
    await ensureAnswerBackfill(s);
    expect((await s.listAnswerMemory()).total).toBe(1);
    expect(await s.getSearchCache(ANSWER_BACKFILL_FLAG)).toBeTruthy();
    await env.DB.prepare(`DELETE FROM answer_memory WHERE shop = ?1`).bind(SHOP).run();
    await ensureAnswerBackfill(s); // flag set -> no re-import
    expect((await s.listAnswerMemory()).total).toBe(0);
  });
});
```

Also add `import type { TenantStore } from '../src/tenant-store';`? No - `TenantStore` is already imported as a value in this file (Task 1). Nothing more to import.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/inbox-answer-memory.test.ts`
Expected: FAIL - cannot resolve `../src/inbox/answer-memory`.

- [ ] **Step 3: Implement the module**

`src/inbox/answer-memory.ts`:

```ts
// src/inbox/answer-memory.ts
//
// Inbox answer memory (2026-07-12): approved-answers RETRIEVAL GROUNDING.
// Every reply the owner approves (or auto-sends) is stored as a vetted
// question->answer pair; when a similar question arrives - even reworded -
// the top matches are injected into the drafter's prompt so replies stay
// consistent in facts, policy and voice. This is deliberately NOT a verbatim
// cache: the model still personalizes, live facts always override, and the
// prompt forbids copying personal details from past answers.
// Spec: docs/superpowers/specs/2026-07-12-inbox-answer-memory-design.md

import type { TenantStore } from '../tenant-store';
import { stripQuotedReply } from './quote';
import { isPartnershipLane } from './partnership';

/** Categories whose sends are never remembered (no reusable substance). */
const EXCLUDED_CATEGORIES = new Set(['spam', 'automated', 'affiliate']);

// Courtesy/grammar words carry no matching signal; product and commerce words
// (ship, order, refund, sizes, numbers) are the signal and are kept.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'i', 'im', 'we', 'you', 'your', 'yours', 'our', 'ours', 'me', 'my',
  'it', 'its', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'not',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'as',
  'that', 'this', 'these', 'those', 'there', 'here', 'if', 'then', 'than', 'so', 'too', 'also', 'just', 'very', 'really',
  'how', 'what', 'when', 'where', 'which', 'who', 'why',
  'please', 'hi', 'hello', 'hey', 'dear', 'thanks', 'thank', 'regards', 'kind', 'best',
  'any', 'some', 'have', 'has', 'had', 'get', 'got', 'let', 'know', 'want', 'wanted', 'wondering',
  'question', 'ask', 'asking', 'looking', 'forward', 'hearing', 'reply', 'response', 'help', 'need', 'like', 'am', 'only',
]);

/** Canonical matching tokens: lowercase, alphanumeric runs only, no stopwords
 * or 1-char tokens, numbers kept (sizes/quantities carry meaning), unique, sorted. */
export function normalizeQuestion(text: string): string[] {
  const raw = (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  return [...new Set(raw.filter((t) => t.length >= 2 && !STOPWORDS.has(t)))].sort();
}

/** FNV-1a 64-bit as 16-char hex (sync, dependency-free; collision odds are
 * irrelevant at catalog scale and a collision only merges two memory slots). */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export function qhashOf(category: string, questionNorm: string): string {
  return fnv1a64(`${category}|${questionNorm}`);
}

// The deterministic wrapper our pipeline adds around every reply: the
// applySalutation greeting ("Hi Name,\n\n") and the applyFooter block
// ("Best Regards,\n<department>"), with the P.S. slot after the footer.
// Only the substance between them is worth remembering.
const LEADING_SALUTATION = /^\s*hi\s[^\n]{0,60},\s*\n+/i;
const FOOTER_ONWARD = /\n\s*best regards,\s*\n[\s\S]*$/i;

export function stripAnswerSubstance(sentBody: string): string {
  return (sentBody ?? '').replace(LEADING_SALUTATION, '').replace(FOOTER_ONWARD, '').trim();
}

const RECALL_WINDOW_DAYS = 180;   // facts drift; older answers age out of recall
const RECALL_TOP = 2;
const RECALL_MIN_OVERLAP = 2;
const RECALL_MIN_SCORE = 0.45;
const SAME_CATEGORY_BONUS = 0.1;  // applied BEFORE the threshold test
const PROMPT_Q_CAP = 200;
const PROMPT_A_CAP = 500;
const STORE_Q_CAP = 1500;
const STORE_A_CAP = 2000;

/** Top matching vetted pairs for a new question (deterministic set-cosine on
 * normalized tokens; zero LLM). Bumps usage stats on the recalled pairs. */
export async function recallAnswers(
  store: TenantStore, category: string | null, question: string
): Promise<{ question: string; answer: string }[]> {
  const a = new Set(normalizeQuestion(question));
  if (a.size < RECALL_MIN_OVERLAP) return [];
  const since = new Date(Date.now() - RECALL_WINDOW_DAYS * 86400_000).toISOString();
  const candidates = await store.listRecallCandidates(since, 500);
  const scored: { qhash: string; question: string; answer: string; score: number; updatedAt: string }[] = [];
  for (const c of candidates) {
    const b = c.question_norm.split(' ').filter(Boolean);
    if (!b.length) continue;
    let inter = 0;
    for (const t of b) if (a.has(t)) inter++;
    if (inter < RECALL_MIN_OVERLAP) continue;
    const score = inter / Math.sqrt(a.size * b.length) + (category && c.category === category ? SAME_CATEGORY_BONUS : 0);
    if (score < RECALL_MIN_SCORE) continue;
    scored.push({ qhash: c.qhash, question: c.question_text, answer: c.answer_text, score, updatedAt: c.updated_at });
  }
  scored.sort((x, y) => y.score - x.score || (y.updatedAt < x.updatedAt ? -1 : 1));
  const top = scored.slice(0, RECALL_TOP);
  if (top.length) await store.bumpAnswerUsage(top.map((t) => t.qhash));
  return top.map((t) => ({ question: t.question.slice(0, PROMPT_Q_CAP), answer: t.answer.slice(0, PROMPT_A_CAP) }));
}

/** Store one vetted pair (the core). Returns false when the send is not
 * memory-worthy: excluded category, partnership lane, or empty/unmatchable
 * question or answer after stripping. */
export async function captureAnswerPair(
  store: TenantStore, thread: { id: string; primary_category: string | null },
  questionStripped: string, sentBody: string, partnershipLane: boolean, at: string
): Promise<boolean> {
  const category = thread.primary_category ?? 'other';
  if (partnershipLane || EXCLUDED_CATEGORIES.has(category)) return false;
  const question = (questionStripped ?? '').trim();
  const answer = stripAnswerSubstance(sentBody);
  if (!question || !answer) return false;
  const tokens = normalizeQuestion(question);
  if (tokens.length < RECALL_MIN_OVERLAP) return false; // could never be recalled
  const questionNorm = tokens.join(' ');
  await store.upsertAnswerMemory({
    qhash: qhashOf(category, questionNorm), category,
    questionText: question.slice(0, STORE_Q_CAP), questionNorm,
    answerText: answer.slice(0, STORE_A_CAP), threadId: thread.id, at,
  });
  return true;
}

/** Send-time hook: pair the FINAL sent text with the thread's latest inbound
 * (quote-chain stripped). The caller passes the messages it already loaded. */
export async function captureAnswerFromSend(
  store: TenantStore, thread: { id: string; primary_category: string | null },
  messages: { direction: string; body_text: string | null }[],
  sentBody: string, partnershipLane: boolean, at: string
): Promise<boolean> {
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
  if (!lastInbound) return false;
  return captureAnswerPair(store, thread, stripQuotedReply(lastInbound.body_text ?? ''), sentBody, partnershipLane, at);
}

export const ANSWER_BACKFILL_FLAG = 'job:answer-backfill';

/** One-time import of historical sends: pair each outbound with the nearest
 * preceding inbound, backdated to the send time. Idempotent via the qhash PK. */
export async function backfillAnswerMemory(store: TenantStore): Promise<number> {
  const threads = await store.listThreads(null, 500);
  let imported = 0;
  for (const t of threads) {
    try {
      const got = await store.getThreadWithMessages(t.id);
      if (!got) continue;
      const inboundToAddrs = got.messages.filter((m) => m.direction === 'inbound').map((m) => m.to_addr ?? '');
      const lane = isPartnershipLane({ inboundToAddrs, declaredIntent: got.thread.declared_intent ?? null, primaryCategory: t.primary_category ?? null });
      let lastInbound = '';
      for (const m of got.messages) {
        if (m.direction === 'inbound') { lastInbound = stripQuotedReply(m.body_text ?? ''); continue; }
        if (m.direction !== 'outbound') continue;
        if (await captureAnswerPair(store, { id: t.id, primary_category: t.primary_category ?? null }, lastInbound, m.body_text ?? '', lane, m.received_at)) imported++;
      }
    } catch (e) {
      console.warn(`answer backfill skipped thread ${t.id}: ${(e as Error).message}`);
    }
  }
  return imported;
}

/** Sweep hook: run the backfill exactly once per shop (search_cache flag).
 * A failure logs and leaves the flag unset so the next sweep retries; the
 * qhash PK makes a partial import harmless. Never throws (the sweep's
 * classify/draft work must proceed regardless). */
export async function ensureAnswerBackfill(store: TenantStore): Promise<void> {
  try {
    if (await store.getSearchCache(ANSWER_BACKFILL_FLAG)) return;
    const imported = await backfillAnswerMemory(store);
    await store.putSearchCache(ANSWER_BACKFILL_FLAG, JSON.stringify({ done: true, imported }), 3650);
    console.log(`answer memory backfill imported ${imported} pairs`);
  } catch (e) {
    console.warn(`answer backfill failed (will retry next sweep): ${(e as Error).message}`);
  }
}
```

Note: `src/inbox/partnership.ts` does not import answer-memory back, so the static `isPartnershipLane` import creates no cycle.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/inbox-answer-memory.test.ts`
Expected: PASS (all describes from Tasks 1 and 2).

If the category-bonus test fails on the score arithmetic, recount the token sets (stopwords list changes set sizes) and adjust the TEST's wording (never the thresholds) until the cross-category score lands in [0.45 - bonus, 0.45).

- [ ] **Step 5: Commit**

```bash
git add src/inbox/answer-memory.ts tests/inbox-answer-memory.test.ts
git commit -m "feat(inbox): answer-memory module - normalize, hash, recall, capture, backfill"
git push
```

---

### Task 3: Recall injection in the drafter

**Files:**
- Modify: `src/inbox/draft.ts` (`buildDraftSystem` ~line 140, `reviseDraft` ~line 164, `draftReply` input type + call ~line 183)
- Test: `tests/agents/scaffolding.test.ts` (append)

**Interfaces:**
- Consumes: nothing new (plain data in).
- Produces: `draftReply` input gains `recall?: { question: string; answer: string }[]` (Task 4 passes it).

**IMPORTANT:** `src/inbox/draft.ts` is shared core. Before editing run `python -m graphite context src/inbox/draft.ts` and read flagged call sites (expected callers of `draftReply`: `composeDraftForThread` in sweep.ts only).

- [ ] **Step 1: Write the failing tests** (append to `tests/agents/scaffolding.test.ts`, inside the existing `describe`)

```ts
  it('injects previously approved answers with the override and no-personal-details rules', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING,
      subject: 'Shipping', conversation: 'Do you deliver worldwide?',
      recall: [{ question: 'Do you ship worldwide?', answer: 'Yes, we ship internationally to most countries.' }],
    });
    expect(sink.system).toContain('Previously approved answers to similar past questions');
    expect(sink.system).toContain('the facts above WIN');
    expect(sink.system).toContain('NEVER copy personal details');
    expect(sink.system).toContain('[Q: Do you ship worldwide? A: Yes, we ship internationally to most countries.]');
  });

  it('omits the recall block when no recall is provided', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const sink: { system?: string } = {};
    const llm = capturingLlm({ bodyText: 'Hi.', confidence: 85, quotesPriceOrOrder: false }, sink);
    await draftReply(llm, store, CFG, {
      agent: stubAgent(false), grounding: GROUNDING, subject: 'Shipping', conversation: 'Do you deliver worldwide?'
    });
    expect(sink.system).not.toContain('Previously approved answers');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/agents/scaffolding.test.ts`
Expected: FAIL - the first new test's `toContain('Previously approved answers...')` (unknown `recall` key is ignored by TS structural typing in the test? No - it is a typed object literal, so tsc inside vitest fails compile with "Object literal may only specify known properties"). Either failure mode is the expected RED.

- [ ] **Step 3: Implement**

In `buildDraftSystem`, extend the opts type and add the block AFTER the grounded-facts segment and BEFORE `COMMERCIAL_GUARDRAILS`:

```ts
function buildDraftSystem(
  agent: CategoryAgent, grounding: Grounding,
  opts: { hasLatest: boolean; guidance?: string; shippingFact?: string; revisionIssues?: string[]; recall?: { question: string; answer: string }[] }
): string {
  return (
    SHARED_SCAFFOLDING + ' ' + STORE_FACTS + ' ' +
    (opts.shippingFact ? opts.shippingFact + ' ' : '') +
    agent.promptFragment(grounding) + ' ' +
    (grounding.facts ? `Grounded facts you MAY rely on for this reply: ${grounding.facts} ` : '') +
    // Approved-answers memory (2026-07-12): consistency grounding from vetted
    // past sends. Facts always win over recalled text, and personal details in
    // past answers belong to OTHER customers - both stated to the model here.
    (opts.recall?.length
      ? 'Previously approved answers to similar past questions - use them to stay consistent in facts, policy and voice. If anything in them conflicts with the store facts or grounded facts above, the facts above WIN (past answers can be out of date). NEVER copy personal details from them: names, destinations, addresses, quantities, prices or order numbers belong to OTHER customers. ' +
        opts.recall.map((r) => `[Q: ${r.question} A: ${r.answer}]`).join(' ') + ' '
      : '') +
    (agent.commercial ? COMMERCIAL_GUARDRAILS + ' ' : '') +
```

(rest of the function unchanged).

In `reviseDraft`, add `recall` to the parameters and pass it through:

```ts
async function reviseDraft(
  llm: LlmClient, store: TenantStore, chain: ReturnType<typeof resolveChain>,
  agent: CategoryAgent, grounding: Grounding, guidance: string | undefined,
  latest: string, baseUser: string, previousBody: string, issues: string[], shippingFact: string,
  recall: { question: string; answer: string }[] | undefined
): Promise<DraftResult | null> {
  const system = buildDraftSystem(agent, grounding, { hasLatest: !!latest, guidance, shippingFact, revisionIssues: issues, recall });
```

In `draftReply`: add `recall?: { question: string; answer: string }[]` to the input object type; pass `recall: input.recall` in BOTH `buildDraftSystem` calls (the direct one and via the `reviseDraft` closure):

```ts
  const system = buildDraftSystem(agent, grounding, { hasLatest: !!latest, guidance, shippingFact, recall: input.recall });
```
```ts
    (prev, issues) => reviseDraft(llm, store, chain, agent, grounding, guidance, latest, baseUser, prev.bodyText, issues, shippingFact, input.recall),
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/agents/scaffolding.test.ts tests/inbox-draft.test.ts tests/agents/draft-generic.test.ts`
Expected: PASS (new tests plus no regressions in the drafter suites).

- [ ] **Step 5: Commit**

```bash
git add src/inbox/draft.ts tests/agents/scaffolding.test.ts
git commit -m "feat(inbox): recall block in the draft system prompt (facts win, no personal details)"
git push
```

---

### Task 4: Pipeline wiring - sweep recall + backfill, send capture

**Files:**
- Modify: `src/inbox/sweep.ts` (import; recall before the `draftReply` call ~line 372; `ensureAnswerBackfill` at the top of the per-shop block in `runInboxClassifySweep` ~line 47)
- Modify: `src/inbox/send.ts` (import; capture hook after `insertOutboundMessage` ~line 42)
- Test: `tests/inbox-send.test.ts` (append), `tests/inbox-sweep.test.ts` (append)

**Interfaces:**
- Consumes (Task 2): `recallAnswers`, `captureAnswerFromSend`, `ensureAnswerBackfill`, `ANSWER_BACKFILL_FLAG`; (Task 3): `draftReply` `recall` input.
- Produces: nothing new.

**IMPORTANT:** sweep.ts and send.ts are shared core. Run `python -m graphite context src/inbox/sweep.ts` and `python -m graphite context src/inbox/send.ts` first and read the flagged call sites.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('sendReply', ...)` block of `tests/inbox-send.test.ts` (the suite already defines `CFG` and the mid-suite `const okFetch`; these tests use both). The thread question tokens {ship, worldwide, shop} clear the 2-token capture floor:

```ts
  it('a successful send captures the FINAL text into answer memory (owner edits included)', async () => {
    const s = new TenantStore(env.DB, 'd.myshopify.com');
    await s.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Ship?', subjectNorm: 'ship?', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'lead', intentScore: 50, summary: null, classifiedAt: '2026-06-18T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<c1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Ship?', bodyText: 'Do you ship worldwide from your shop?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Draft answer.', bodyHtml: '<p>Draft answer.</p>', confidence: 95, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft,
      'Hi Jane,\n\nYes, we ship worldwide to most countries.\n\nBest Regards,\nActive Paw Sales Team', okFetch);
    expect(r.ok).toBe(true);
    const mem = await s.listAnswerMemory();
    expect(mem.total).toBe(1);
    expect(mem.rows[0].question).toBe('Do you ship worldwide from your shop?');
    expect(mem.rows[0].answer).toBe('Yes, we ship worldwide to most countries.'); // owner-edited FINAL text, wrapper stripped
    expect(mem.rows[0].category).toBe('lead');
  });

  it('a capture failure never fails the send', async () => {
    const s = new TenantStore(env.DB, 'e.myshopify.com');
    await s.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Ship?', subjectNorm: 'ship?', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'lead', intentScore: 50, summary: null, classifiedAt: '2026-06-18T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<c2@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Ship?', bodyText: 'Do you ship worldwide from your shop?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Yes we do ship worldwide.', bodyHtml: '<p>x</p>', confidence: 95, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    (s as any).upsertAnswerMemory = async () => { throw new Error('boom'); };
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const draft = (await s.getDraft(did))!;
    const r = await sendReply({ ...env, RESEND_API_KEY: 'rk' } as any, s, CFG, thread, draft, undefined, okFetch);
    expect(r.ok).toBe(true);
    expect((await s.getDraft(did))?.status).toBe('sent');
  });
```

Append inside the `describe('runInboxClassifySweep', ...)` block of `tests/inbox-sweep.test.ts` (uses the suite's `seedShopWithThread` helper - thread question "I want to buy the large bed now" tokens {bed, buy, large, now} overlap the seeded pair's {bed, buy, large}: 3/sqrt(12) = 0.87). Add to the file's imports: `import { normalizeQuestion, ANSWER_BACKFILL_FLAG } from '../src/inbox/answer-memory';`

```ts
  it('drafting grounds with recalled approved answers, and the sweep runs the one-time backfill', async () => {
    await seedShopWithThread();
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertAnswerMemory({
      qhash: 'seed1', category: 'lead',
      questionText: 'Can I buy the large bed?', questionNorm: normalizeQuestion('Can I buy the large bed?').join(' '),
      answerText: 'The large bed is available on our website.', threadId: 'prior-thread',
    });
    let draftSystem = '';
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (String(url).includes('openrouter')) {
        const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[] };
        const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
        if (system.includes('customer-service email reply')) { // the drafter (vs the classifier)
          draftSystem = system;
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ customerAsks: ['buy the large bed'], bodyText: 'Yes, the large bed is available.', confidence: 90, quotesPriceOrOrder: false, commercialIntent: false }) } }], usage: { cost: 0.0001 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ isHuman: true, category: 'lead', intentScore: 60, summary: 'Wants the large bed', labels: ['lead'] }) } }], usage: { cost: 0.0001 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch;

    await runInboxClassifySweep({ ...env, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'rk' } as any, fetchImpl);

    expect(draftSystem).toContain('Previously approved answers to similar past questions');
    expect(draftSystem).toContain('The large bed is available on our website.');
    // The flag-guarded one-time backfill ran during this sweep.
    expect(await store.getSearchCache(ANSWER_BACKFILL_FLAG)).toBeTruthy();
  });
```

If the drafter is never reached because `proposeInvoiceOne` intercepts the thread, mirror whatever the suite's existing "drafts a reply for a needs_reply thread" test does to reach `draftOne` - that test proves this exact seed reaches the drafter.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/inbox-send.test.ts tests/inbox-sweep.test.ts`
Expected: FAIL - no capture happens, no recall block, no backfill flag.

- [ ] **Step 3: Implement the wiring**

`src/inbox/send.ts` - add the import and the hook right after the `insertOutboundMessage` line (line 42), before `setDraftStatus`:

```ts
import { captureAnswerFromSend } from './answer-memory';
```
```ts
  await store.insertOutboundMessage({ threadId: thread.id, messageId: r.messageId, from: 'support@activepaw.co.uk', to: thread.contact_email, subject: `Re: ${subject}`, bodyText, bodyHtml, sentAt });
  // Answer memory (2026-07-12): the FINAL sent text (owner edits included)
  // becomes a vetted Q->A pair for future recall. Never blocks the send.
  try {
    await captureAnswerFromSend(store, thread, got?.messages ?? [], bodyText, partnershipLane, sentAt);
  } catch (e) { console.warn(`answer capture failed for ${thread.id}: ${(e as Error).message}`); }
```

`src/inbox/sweep.ts` - add the import:

```ts
import { recallAnswers, ensureAnswerBackfill } from './answer-memory';
```

In `runInboxClassifySweep`, first line inside the per-shop `try` (before the `unclassifiedThreads` loop):

```ts
      const cfg = await store.getConfig();
      if (!cfg || !cfg.inbox.enabled) continue;
      // One-time import of historical Q->A pairs (flag-guarded, never throws).
      await ensureAnswerBackfill(store);
```

In `composeDraftForThread`, immediately before the `draftReply` call:

```ts
  // Approved-answers recall (2026-07-12): ground the drafter with vetted past
  // answers to similar questions. Failure degrades to no recall, never blocks.
  let recall: { question: string; answer: string }[] = [];
  try {
    recall = await recallAnswers(store, thread.primary_category ?? null, latestInbound);
  } catch (e) { console.warn(`answer recall failed for ${thread.id}: ${(e as Error).message}`); }

  const draft = await draftReply(llm, store, cfg, {
    agent, grounding, subject: thread.subject ?? '', conversation, latestMessage: latestInbound,
    customerName: contact?.name ?? null, customerEmail: thread.contact_email, recall
  });
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/inbox-send.test.ts tests/inbox-sweep.test.ts tests/inbox-answer-memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inbox/sweep.ts src/inbox/send.ts tests/inbox-send.test.ts tests/inbox-sweep.test.ts
git commit -m "feat(inbox): wire answer memory - capture on send, recall into drafts, one-time backfill"
git push
```

---

### Task 5: Routes + Answer library console card + docs

**Files:**
- Modify: `src/index.ts` (two handlers immediately BEFORE the `// --- Profitability agent (2026-07-09)...` comment block ~line 575)
- Modify: `src/console/views/inbox.ts` (append a card `<section>` before the view's closing backtick; append `.ans-*` CSS to `inboxCss`)
- Modify: `src/console/inbox-js.ts` (append the answers JS before the closing backtick)
- Modify: `src/console/page.ts` (add `ansLoad();` on its own line right after `loadInboxSettings();` in the startup block ~line 996)
- Modify: `docs/STATES.md` (one probe row), `docs/HANDOVER.md` (short section)
- Test: `tests/console.test.ts` (append one it-block)

**Interfaces:**
- Consumes (Task 1): `listAnswerMemory`, `setAnswerDisabled`. Console helpers `el()`, `esc()`, `setMsg()`, `api()` already exist in the page bundle.
- Produces: `POST /api/inbox/answers`, `POST /api/inbox/answers/toggle`.

- [ ] **Step 1: Write the failing console test** (append to `tests/console.test.ts`)

```ts
  it('Inbox carries the Answer library card wired to /inbox/answers with delegated toggles', async () => {
    const html = await consolePage('test-api-key').text();
    for (const id of ['ans-list', 'ans-count', 'ans-msg']) expect(html).toContain('id="' + id + '"');
    expect(html).toContain('Answer library');
    expect(html).toContain('.ans-row'); // namespaced card CSS present
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    expect(scripts).toContain('function ansLoad(');
    expect(scripts).toContain('function ansToggle(');
    expect(scripts).toContain("'/inbox/answers'");
    expect(scripts).toContain("'/inbox/answers/toggle'");
    // qhash rides an ESCAPED data attribute resolved by delegation, never inline onclick JS.
    expect(scripts).toContain('data-ans-toggle="\'+esc(');
    expect(scripts).toContain('ansLoad();'); // loaded on startup
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/console.test.ts`
Expected: FAIL on the new it-block only.

- [ ] **Step 3: Implement routes** (`src/index.ts`, before the Profitability comment block)

```ts
// --- Inbox answer memory (2026-07-12): the Answer library card. List is
// read-only; toggle flips one pair's disabled flag (recall skips disabled).
app.post('/api/inbox/answers', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { limit?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  const limit = Number.isFinite(Number(body.limit)) ? Math.floor(Number(body.limit)) : 100;
  const r = await new TenantStore(c.env.DB, s).listAnswerMemory(limit);
  return c.json({ ok: true, ...r });
});
app.post('/api/inbox/answers/toggle', async (c) => {
  const s = await shopOf(c); if (typeof s !== 'string') return s;
  let body: { qhash?: unknown; disabled?: unknown } = {};
  try { body = await c.req.json(); } catch {}
  if (typeof body.qhash !== 'string' || !body.qhash) return c.json({ ok: false, error: 'qhash required' }, 400);
  if (typeof body.disabled !== 'boolean') return c.json({ ok: false, error: 'disabled must be true or false' }, 400);
  const ok = await new TenantStore(c.env.DB, s).setAnswerDisabled(body.qhash, body.disabled);
  return c.json(ok ? { ok: true } : { ok: false, error: 'Pair not found' });
});
```

- [ ] **Step 4: Implement the card** (append to `inboxView` in `src/console/views/inbox.ts`, after the workspace section's closing `</section>`, before the template's closing backtick)

```html

  <section class="card">
    <h2>Answer library</h2>
    <p class="sub" style="margin:0 0 10px">Every reply you approve is remembered as the customer's question and your vetted answer. When a similar question arrives - even reworded - the drafter is grounded with the closest approved answers so replies stay consistent; live facts always override them, and personal details are never copied across customers. Disable a pair to pull a bad or outdated answer out of recall; approving a new reply to the same question replaces and re-enables it. History imports automatically on the first sweep.</p>
    <p id="ans-count" class="muted" style="margin:0 0 8px;font-size:12.5px"></p>
    <div id="ans-list"><p class="muted">Loading…</p></div>
    <div class="row" style="margin-top:10px"><button type="button" class="ghost" onclick="ansLoad()">Refresh</button></div>
    <p id="ans-msg" class="msg muted"></p>
  </section>
```

Append to `inboxCss`:

```css
  /* --- Answer library (approved-answers memory) --- */
  .ans-row{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1.6fr) 150px;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);font-size:12.5px}
  .ans-row:last-child{border-bottom:none}
  .ans-q{color:var(--ink);font-weight:550;overflow-wrap:anywhere}
  .ans-a{color:var(--subdued);overflow-wrap:anywhere;white-space:pre-line}
  .ans-meta{color:var(--subdued);font-size:11.5px}
  .ans-cat{display:inline-block;font-size:10.5px;font-weight:650;border-radius:8px;padding:1px 7px;background:rgba(88,166,255,.16);color:#58a6ff;margin-bottom:4px}
  .ans-row.off .ans-q,.ans-row.off .ans-a{opacity:.45;text-decoration:line-through}
  @media(max-width:820px){.ans-row{grid-template-columns:1fr}}
```

- [ ] **Step 5: Implement the JS** (append inside the `inboxJs` template literal in `src/console/inbox-js.ts`, before its closing backtick; TEMPLATE RULES: no backticks or dollar-brace, `+` concat, `esc()` every dynamic)

```js
// --- Answer library (approved-answers memory) ---
function ansSnip(t,n){ t=String(t==null?'':t); return t.length>n?(t.slice(0,n)+'…'):t; }
async function ansLoad(){
  var box=el('ans-list'); if(!box) return;
  try{
    var r=await api('/inbox/answers',{});
    if(!r.ok){ setMsg('ans-msg','Failed to load.','no'); return; }
    var cnt=el('ans-count');
    if(cnt) cnt.textContent=r.total+' remembered answer'+(r.total===1?'':'s')+(r.disabled?(' ('+r.disabled+' disabled)'):'');
    if(!r.rows.length){ box.innerHTML='<p class="muted">Nothing remembered yet - pairs appear as you approve replies (history imports automatically on the first sweep).</p>'; return; }
    var s='';
    for(var i=0;i<r.rows.length;i++){
      var a=r.rows[i];
      s+='<div class="ans-row'+(a.disabled?' off':'')+'">'
        +'<div><span class="ans-cat">'+esc(a.category)+'</span><div class="ans-q">'+esc(ansSnip(a.question,180))+'</div></div>'
        +'<div class="ans-a">'+esc(ansSnip(a.answer,260))+'</div>'
        +'<div class="ans-meta">Used '+esc(String(a.usedCount))+'x'
        +(a.lastUsedAt?('<br>last '+esc(new Date(a.lastUsedAt).toLocaleDateString())):'')
        +'<br><button type="button" class="ghost" data-ans-toggle="'+esc(a.qhash)+'" data-ans-off="'+(a.disabled?'0':'1')+'">'+(a.disabled?'Enable':'Disable')+'</button></div>'
        +'</div>';
    }
    box.innerHTML=s;
  }catch(e){ setMsg('ans-msg','Could not load.','no'); }
}
async function ansToggle(btn,qhash,off){
  btn.disabled=true;
  try{
    var r=await api('/inbox/answers/toggle',{qhash:qhash,disabled:off});
    if(!r.ok){ setMsg('ans-msg','Failed: '+(r.error||'unknown'),'no'); btn.disabled=false; return; }
    setMsg('ans-msg',off?'Disabled - this answer will not be recalled.':'Enabled again.','ok');
    ansLoad();
  }catch(e){ setMsg('ans-msg','Could not save.','no'); btn.disabled=false; }
}
(function(){
  var box=el('ans-list');
  if(box) box.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('[data-ans-toggle]'):null;
    if(!b) return;
    ansToggle(b,b.getAttribute('data-ans-toggle'),b.getAttribute('data-ans-off')==='1');
  });
})();
```

In `src/console/page.ts`, add `ansLoad();` on its own line directly after `loadInboxSettings();` in the startup block.

Before writing, grep the console bundle for an existing `ansSnip`/`ansLoad`/`ansToggle` to confirm no name collision: `grep -n "ansLoad\|ansToggle\|ansSnip" src/console/*.ts` - expect no hits.

- [ ] **Step 6: Docs**

`docs/STATES.md` - add one row to the inbox section's probe table:

```markdown
| Answer memory (approved-answers grounding) | pairs + disabled: `npx wrangler d1 execute pawscout --remote --command "SELECT COUNT(*), SUM(disabled) FROM answer_memory"`; backfill flag: `SELECT cache_key FROM search_cache WHERE cache_key='job:answer-backfill'` | capture on every sent reply; recall into every draft; no config switch (inert until pairs exist) |
```

`docs/HANDOVER.md` - add a short section after the inbox section:

```markdown
## Inbox answer memory (2026-07-12)

Every approved/auto-sent reply is captured as a vetted Q->A pair (`answer_memory`,
migration 0031; salutation/footer stripped; spam/automated/affiliate and the
partnership lane excluded). Drafting recalls the top 2 matching pairs
(deterministic token overlap, 180-day window, zero LLM) and injects them into the
system prompt as consistency grounding - live facts always override, personal
details are never copied. One-time history backfill runs flag-guarded on the first
sweep (`search_cache` key `job:answer-backfill`). Console: Inbox -> Answer library
(per-pair Disable). Auto-send gates are untouched by design.
```

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run tests/console.test.ts tests/inbox-routes.test.ts`
Expected: PASS.

Then the wider affected set in one invocation:

Run: `npx vitest run tests/inbox-answer-memory.test.ts tests/inbox-send.test.ts tests/inbox-sweep.test.ts tests/agents/scaffolding.test.ts tests/inbox-draft.test.ts tests/console.test.ts`
Expected: PASS. Also run `npx tsc --noEmit` - expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/console/views/inbox.ts src/console/inbox-js.ts src/console/page.ts docs/STATES.md docs/HANDOVER.md tests/console.test.ts
git commit -m "feat(console): Answer library card + /api/inbox/answers routes + docs"
git push
```

---

## Deploy (after final review, owner \"go\" required)

1. `npx wrangler d1 migrations apply pawscout --remote` (0031 - new table, invisible to the running worker)
2. `npx wrangler deploy`
3. Verify: `SELECT COUNT(*) FROM answer_memory` grows after the first 15-min sweep (backfill), and the flag row exists in `search_cache`.
