/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
function s() { return new TenantStore(env.DB, SHOP); }

describe('inbox store', () => {
  it('upserts a contact and counts messages', async () => {
    const store = s();
    await store.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    await store.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    const row = await env.DB.prepare('SELECT * FROM inbox_contacts WHERE shop=?1 AND email=?2')
      .bind(SHOP, 'jane@x.com').first<{ message_count: number }>();
    expect(row?.message_count).toBe(2);
  });

  it('dedupes inbound by Message-ID and matches a reply to its thread', async () => {
    const store = s();
    await store.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await store.createThread({
      contactEmail: 'jane@x.com', subject: 'Do you ship?', subjectNorm: 'do you ship?',
      receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'new'
    });
    const first = await store.insertInboundMessageIfNew({
      threadId: tid, messageId: '<m1@x>', inReplyTo: null, references: [], from: 'jane@x.com',
      to: 'support@activepaw.co.uk', subject: 'Do you ship?', bodyText: 'hi', bodyHtml: null,
      headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z'
    });
    const dup = await store.insertInboundMessageIfNew({
      threadId: tid, messageId: '<m1@x>', inReplyTo: null, references: [], from: 'jane@x.com',
      to: 'support@activepaw.co.uk', subject: 'Do you ship?', bodyText: 'hi', bodyHtml: null,
      headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z'
    });
    expect(first).toBe(true);
    expect(dup).toBe(false);

    // a reply referencing <m1@x> matches the same thread
    const matched = await store.matchThread({
      contactEmail: 'jane@x.com', inReplyTo: '<m1@x>', references: ['<m1@x>'], subjectNorm: 'do you ship?'
    });
    expect(matched).toBe(tid);
  });

  it('falls back to (contact + normalized subject) when refs miss', async () => {
    const store = s();
    await store.upsertContact({ email: 'jane@x.com', name: null, phone: null });
    const tid = await store.createThread({
      contactEmail: 'jane@x.com', subject: 'Sizing', subjectNorm: 'sizing',
      receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'new'
    });
    const matched = await store.matchThread({
      contactEmail: 'jane@x.com', inReplyTo: null, references: [], subjectNorm: 'sizing'
    });
    expect(matched).toBe(tid);
  });

  it('lists, reads, relabels, restatuses and classifies threads scoped to shop', async () => {
    const store = s();
    await store.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    const tid = await store.createThread({
      contactEmail: 'jane@x.com', subject: 'Bulk order', subjectNorm: 'bulk order',
      receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'new'
    });
    await store.insertInboundMessageIfNew({
      threadId: tid, messageId: '<m@x>', inReplyTo: null, references: [], from: 'jane@x.com',
      to: 'support@activepaw.co.uk', subject: 'Bulk order', bodyText: 'I want 100 beds', bodyHtml: null,
      headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z'
    });

    expect((await store.unclassifiedThreads(10)).map((t) => t.id)).toContain(tid);

    await store.setThreadClassification(tid, {
      status: 'needs_reply', primaryCategory: 'wholesale-b2b', intentScore: 88,
      summary: 'Wants 100 beds', classifiedAt: '2026-06-18T10:05:00Z'
    });
    await store.setThreadLabels(tid, ['wholesale-b2b', 'lead']);

    const got = await store.getThreadWithMessages(tid);
    expect(got?.thread.status).toBe('needs_reply');
    expect(got?.thread.intent_score).toBe(88);
    expect(got?.labels.sort()).toEqual(['lead', 'wholesale-b2b']);
    expect(got?.messages).toHaveLength(1);

    const list = await store.listThreads(null, 50);
    expect(list.map((t) => t.id)).toContain(tid);
    expect(await new TenantStore(env.DB, 'b.myshopify.com').listThreads(null, 50)).toEqual([]);
  });
});
