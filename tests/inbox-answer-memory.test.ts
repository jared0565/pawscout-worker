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
