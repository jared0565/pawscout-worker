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
  it('strips a wrapper-only body (salutation immediately followed by footer) to empty', () => {
    expect(stripAnswerSubstance('Hi Ben,\n\nBest Regards,\nActive Paw Sales Team')).toBe('');
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
    // Supplier Q-A pairs must never be recalled into customer drafts (controller
    // fix round 2, 2026-09-27). Uses a question with 2+ real tokens ('q tokens
    // here' normalizes to a single token and would return false on the
    // RECALL_MIN_OVERLAP gate alone, masking whether the category exclusion
    // actually fired), so this only passes if 'supplier' is truly excluded.
    expect(await captureAnswerPair(s, { id: 't', primary_category: 'supplier' }, 'Do you ship worldwide?', sent, false, '2026-07-12T00:00:00.000Z')).toBe(false);
    expect(await captureAnswerPair(s, thread, 'q tokens here', sent, true, '2026-07-12T00:00:00.000Z')).toBe(false);
    expect(await captureAnswerPair(s, thread, '', sent, false, '2026-07-12T00:00:00.000Z')).toBe(false);
    expect(await captureAnswerPair(s, thread, 'thanks', sent, false, '2026-07-12T00:00:00.000Z')).toBe(false); // <2 tokens
    // 'ship worldwide today' normalizes to 3 usable tokens (clears the question
    // gate), so this can ONLY return false via the empty-substance path below.
    expect(await captureAnswerPair(s, thread, 'ship worldwide today', 'Hi Ben,\n\nBest Regards,\nActive Paw Sales Team', false, '2026-07-12T00:00:00.000Z')).toBe(false); // empty substance
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
  async function seedThread(id: string, category: string, msgs: { dir: 'inbound' | 'outbound'; body: string; at: string }[], lastMessageAt = '2026-07-01T00:00:00.000Z') {
    await env.DB.prepare(
      `INSERT INTO inbox_threads (shop, id, contact_email, subject, status, primary_category, last_message_at, created_at, updated_at)
       VALUES (?1, ?2, 'c@x.com', 's', 'awaiting_customer', ?3, ?4, ?4, ?4)`
    ).bind(SHOP, id, category, lastMessageAt).run();
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

  it('processes threads oldest-first so the NEWEST thread wins a duplicate question', async () => {
    const s = store();
    // Same normalized question ("ship worldwide domestically") in both
    // threads -> same qhash. t-old is the earlier thread with a stale
    // answer; t-new is more recent with the current one. listThreads orders
    // newest-first, so without the oldest-first fix t-old's upsert would run
    // last and clobber t-new's answer.
    await seedThread('t-old', 'lead', [
      { dir: 'inbound', body: 'Do you ship worldwide or only domestically?', at: '2026-05-01T00:00:00.000Z' },
      { dir: 'outbound', body: 'Hi Ben,\n\nOld answer that is no longer accurate.\n\nBest Regards,\nActive Paw Sales Team', at: '2026-05-01T01:00:00.000Z' },
    ], '2026-05-01T01:00:00.000Z');
    await seedThread('t-new', 'lead', [
      { dir: 'inbound', body: 'Do you ship worldwide or only domestically?', at: '2026-06-01T00:00:00.000Z' },
      { dir: 'outbound', body: 'Hi Ben,\n\nYes, worldwide shipping is available and it is fast.\n\nBest Regards,\nActive Paw Sales Team', at: '2026-06-01T01:00:00.000Z' },
    ], '2026-06-01T01:00:00.000Z');

    const n = await backfillAnswerMemory(s);
    expect(n).toBe(2); // both pairs captured; the shared qhash keeps only one row

    const r = await s.listAnswerMemory();
    expect(r.total).toBe(1);
    expect(r.rows[0].answer).toBe('Yes, worldwide shipping is available and it is fast.');
    expect(r.rows[0].updatedAt).toBe('2026-06-01T01:00:00.000Z');
  });
});
