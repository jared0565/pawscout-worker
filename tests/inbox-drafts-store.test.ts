/// <reference types="@cloudflare/vitest-plugin" />
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

  // ── GDPR tests ───────────────────────────────────────────────────────────────

  it('redactContact purges the draft row for that contact', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    const tid = await thread(s, 'erase@example.com', 'needs_reply');
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Hello', bodyHtml: '<p>Hello</p>', confidence: 88, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    // Draft exists before redact
    expect(await s.getDraft(did)).not.toBeNull();

    await s.redactContact('erase@example.com');

    // Draft row must be gone (cascade deleted with the thread)
    expect(await s.getDraft(did)).toBeNull();
  });

  it('redactShop clears inbox_drafts for the shop', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    const tid = await thread(s, 'jane@x.com', 'needs_reply');
    const did = await s.insertDraft({ threadId: tid, bodyText: 'Bye', bodyHtml: '<p>Bye</p>', confidence: 80, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    expect(await s.getDraft(did)).not.toBeNull();

    await s.redactShop();

    expect(await s.getDraft(did)).toBeNull();
  });
});

// Design 2026-11-19, 2d and 2a: the final answer is known by its template key
// on a SENT draft, and the "reply by hand" alert fires once per thread.
describe('reply end-state store support', () => {
  it('hasSentTemplateDraft finds a sent draft by its template key, never a pending one', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await thread(s);
    const id = await s.insertDraft({ threadId: tid, bodyText: 'Final', bodyHtml: '<p>Final</p>', confidence: null, quotesPriceOrder: false, holdReasons: [], model: 'partnership-screen', status: 'pending', meta: { template: 'collaboration_decline' } });
    expect(await s.hasSentTemplateDraft(tid, ['collaboration_decline'])).toBe(false);
    await s.setDraftStatus(id, 'sent', { sentMessageId: '<x@activepaw.co.uk>', sentAt: '2026-11-19T10:00:00Z' });
    expect(await s.hasSentTemplateDraft(tid, ['collaboration_decline'])).toBe(true);
    expect(await s.hasSentTemplateDraft(tid, ['partnership_decline'])).toBe(false);
  });
  it('claimHandReplyAlert is true once per thread', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const a = await thread(s, 'a@x.com');
    const b = await thread(s, 'b@x.com');
    expect(await s.claimHandReplyAlert(a)).toBe(true);
    expect(await s.claimHandReplyAlert(a)).toBe(false);
    expect(await s.claimHandReplyAlert(b)).toBe(true);
  });
});
