/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import type { ThreadStatus } from '../src/inbox/types';

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

  it("'open' filter hides processed threads (converted/closed/spam) but keeps active ones", async () => {
    const store = s();
    await store.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    const mk = (subject: string, status: ThreadStatus) => store.createThread({
      contactEmail: 'jane@x.com', subject, subjectNorm: subject,
      receivedAt: '2026-06-18T10:00:00Z', initialStatus: status,
    });
    const newId = await mk('a', 'new');
    const replyId = await mk('b', 'needs_reply');
    const awaitId = await mk('c', 'awaiting_customer');
    const convId = await mk('d', 'converted');
    const closedId = await mk('e', 'closed');
    const spamId = await mk('f', 'spam');

    const openIds = (await store.listThreads('open', 50)).map((t) => t.id);
    expect(openIds).toEqual(expect.arrayContaining([newId, replyId, awaitId]));
    expect(openIds).not.toContain(convId);
    expect(openIds).not.toContain(closedId);
    expect(openIds).not.toContain(spamId);

    // 'All' (null) still returns every thread, including processed ones.
    expect((await store.listThreads(null, 50)).length).toBe(6);
    // An exact status still matches only that status.
    expect((await store.listThreads('converted', 50)).map((t) => t.id)).toEqual([convId]);
  });

  it('redactContact erases all inbox PII for one email (case-insensitive) and leaves other contacts/shops intact', async () => {
    const store = s();
    const otherStore = new TenantStore(env.DB, 'other.myshopify.com');

    // seed jane on the primary shop
    await store.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    const janeTid = await store.createThread({
      contactEmail: 'jane@x.com', subject: 'Returns?', subjectNorm: 'returns?',
      receivedAt: '2026-06-18T11:00:00Z', initialStatus: 'new'
    });
    await store.insertInboundMessageIfNew({
      threadId: janeTid, messageId: '<jane-m1@x>', inReplyTo: null, references: [], from: 'jane@x.com',
      to: 'support@activepaw.co.uk', subject: 'Returns?', bodyText: 'I want to return', bodyHtml: null,
      headersJson: '{}', receivedAt: '2026-06-18T11:00:00Z'
    });
    await store.setThreadLabels(janeTid, ['returns', 'priority']);

    // seed bob on the same primary shop
    await store.upsertContact({ email: 'bob@x.com', name: 'Bob', phone: null });
    const bobTid = await store.createThread({
      contactEmail: 'bob@x.com', subject: 'Shipping?', subjectNorm: 'shipping?',
      receivedAt: '2026-06-18T12:00:00Z', initialStatus: 'new'
    });
    await store.insertInboundMessageIfNew({
      threadId: bobTid, messageId: '<bob-m1@x>', inReplyTo: null, references: [], from: 'bob@x.com',
      to: 'support@activepaw.co.uk', subject: 'Shipping?', bodyText: 'Do you ship?', bodyHtml: null,
      headersJson: '{}', receivedAt: '2026-06-18T12:00:00Z'
    });

    // seed jane on a different shop — must remain untouched
    await otherStore.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    const otherJaneTid = await otherStore.createThread({
      contactEmail: 'jane@x.com', subject: 'Other shop', subjectNorm: 'other shop',
      receivedAt: '2026-06-18T13:00:00Z', initialStatus: 'new'
    });

    // verify inboxDataSummary before redaction
    const summary = await store.inboxDataSummary('jane@x.com');
    expect(summary.threads).toBe(1);
    expect(summary.messages).toBe(1);

    // redact with mixed-case email (proves lowercasing)
    const removed = await store.redactContact('JANE@x.com');
    expect(removed).toBeGreaterThan(0); // labels + messages + thread + contact

    // jane's contact, thread, messages, labels are gone from primary shop
    const janeContact = await env.DB.prepare('SELECT * FROM inbox_contacts WHERE shop=?1 AND email=?2').bind(SHOP, 'jane@x.com').first();
    expect(janeContact).toBeNull();

    const janeThread = await env.DB.prepare('SELECT * FROM inbox_threads WHERE shop=?1 AND id=?2').bind(SHOP, janeTid).first();
    expect(janeThread).toBeNull();

    const janeMessages = await env.DB.prepare('SELECT * FROM inbox_messages WHERE shop=?1 AND thread_id=?2').bind(SHOP, janeTid).all();
    expect(janeMessages.results).toHaveLength(0);

    const janeLabels = await env.DB.prepare('SELECT * FROM inbox_thread_labels WHERE shop=?1 AND thread_id=?2').bind(SHOP, janeTid).all();
    expect(janeLabels.results).toHaveLength(0);

    // bob on primary shop is intact
    const bobContact = await env.DB.prepare('SELECT * FROM inbox_contacts WHERE shop=?1 AND email=?2').bind(SHOP, 'bob@x.com').first();
    expect(bobContact).not.toBeNull();

    const bobThread = await env.DB.prepare('SELECT * FROM inbox_threads WHERE shop=?1 AND id=?2').bind(SHOP, bobTid).first();
    expect(bobThread).not.toBeNull();

    // jane on other shop is untouched
    const otherJaneThread = await env.DB.prepare('SELECT * FROM inbox_threads WHERE shop=?1 AND id=?2').bind('other.myshopify.com', otherJaneTid).first();
    expect(otherJaneThread).not.toBeNull();
  });

  it('purges inbox_invoices on redactContact and inboxDataSummary reflects invoices count', async () => {
    const s2 = new TenantStore(env.DB, 'a.myshopify.com');
    await s2.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    const tid = await s2.createThread({ contactEmail: 'c@x.com', subject: 'x', subjectNorm: 'x', receivedAt: new Date().toISOString(), initialStatus: 'awaiting_customer' });
    await s2.insertInvoice({ threadId: tid, lineItems: [], total: 1, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'sent' });
    expect((await s2.inboxDataSummary('c@x.com')).invoices).toBe(1);
    await s2.redactContact('c@x.com');
    expect((await s2.inboxDataSummary('c@x.com')).invoices).toBe(0);
  });
});
