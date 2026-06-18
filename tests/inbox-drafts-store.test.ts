/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

async function thread(s: TenantStore, email = 'jane@x.com', status: any = 'needs_reply') {
  await s.upsertContact({ email, name: null, phone: null });
  const tid = await s.createThread({ contactEmail: email, subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-06-18T10:00:00Z', initialStatus: status });
  return tid;
}

describe('inbox drafts store', () => {
  it('inserts a pending draft and finds it; threadsNeedingDraft excludes threads with a pending draft', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await thread(s);
    expect((await s.threadsNeedingDraft(10)).map(t => t.id)).toContain(tid);
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Hello!', bodyHtml: '<p>Hello!</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    expect((await s.getPendingDraft(tid))?.id).toBe(did);
    expect((await s.threadsNeedingDraft(10)).map(t => t.id)).not.toContain(tid);
  });
  it('supersedes pending drafts on re-open', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await thread(s, 'jane@x.com', 'awaiting_customer');
    await s.insertDraft({ threadId: tid, bodyText: 'x', bodyHtml: '<p>x</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    await s.supersedePendingDrafts(tid);
    expect(await s.getPendingDraft(tid)).toBeNull();
    await s.reopenThread(tid);
    expect((await s.getThreadWithMessages(tid))?.thread.status).toBe('needs_reply');
  });
  it('records an outbound message and counts recent sends to a contact', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await thread(s);
    await s.insertOutboundMessage({ threadId: tid, messageId: '<inbox-1@activepaw.co.uk>', from: 'support@activepaw.co.uk', to: 'jane@x.com', subject: 'Re: Hi', bodyText: 'hi', bodyHtml: '<p>hi</p>', sentAt: '2026-06-18T11:00:00Z' });
    expect(await s.recentAutoSendCount('jane@x.com', '2026-06-18T00:00:00Z')).toBe(1);
    expect(await s.recentAutoSendCount('jane@x.com', '2026-06-19T00:00:00Z')).toBe(0);
  });
  it('setDraftStatus transitions and records sent fields', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await thread(s);
    const did = await s.insertDraft({ threadId: tid, bodyText: 'x', bodyHtml: '<p>x</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    await s.setDraftStatus(did, 'sent', { sentMessageId: '<inbox-2@activepaw.co.uk>', sentAt: '2026-06-18T11:00:00Z' });
    expect((await s.getDraft(did))?.status).toBe('sent');
    expect((await s.getDraft(did))?.sent_message_id).toBe('<inbox-2@activepaw.co.uk>');
  });
});
