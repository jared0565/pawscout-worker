/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { ingestParsed } from '../src/inbox/ingest';
import type { ParsedEmail } from '../src/inbox/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

function pe(over: Partial<ParsedEmail>): ParsedEmail {
  return {
    messageId: '<m1@x>', inReplyTo: null, references: [], from: { email: 'jane@x.com', name: 'Jane' },
    to: ['support@activepaw.co.uk'], subject: 'Do you ship to IE?', date: '2026-06-18T10:00:00Z',
    text: 'Hi, do you ship to Ireland?', html: null, headers: {}, ...over
  };
}

describe('ingestParsed', () => {
  it('creates a contact, thread and message; status new for a human email', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({}));
    expect(r.deduped).toBe(false);
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.status).toBe('new');
    expect(got?.thread.contact_email).toBe('jane@x.com');
    expect(got?.messages[0].body_text).toContain('Ireland');
  });

  it('marks a DMARC-fail email as spam (no classification needed)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({
      messageId: '<spam@x>', headers: { 'authentication-results': 'mx; spf=fail dmarc=fail' }
    }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.status).toBe('spam');
  });

  it('marks bulk/auto mail as automated and pre-classified', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({ messageId: '<auto@x>', headers: { precedence: 'bulk' } }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.status).toBe('closed');
    expect(got?.labels).toContain('automated');
    expect(got?.thread.classified_at).not.toBeNull(); // skips the LLM sweep
  });

  it('suppresses a content-less (blank) email: closed + pre-classified so it never drafts or shows', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({ messageId: '<blank@x>', subject: '', text: '', html: null }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.status).toBe('closed');         // excluded from the default "open" inbox view
    expect(got?.thread.classified_at).not.toBeNull();  // excluded from the LLM sweep → no draft generated
    expect(got?.labels).toContain('no_content');
  });

  it('does NOT suppress an attachment-only email with no text (a real damage photo reaches the sweep)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({ messageId: '<photo@x>', subject: 'see photo', text: '', html: null, hasAttachments: true }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.status).toBe('new');
    expect(got?.thread.classified_at).toBeNull();
  });

  it('does NOT re-open an awaiting_customer thread on a blank follow-up', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pe({}));
    await store.setThreadStatus(a.threadId, 'awaiting_customer');
    await ingestParsed(store, pe({
      messageId: '<blankreply@x>', inReplyTo: '<m1@x>', references: ['<m1@x>'],
      subject: 'Re: Do you ship to IE?', text: '', html: null
    }));
    expect((await store.getThreadWithMessages(a.threadId))?.thread.status).toBe('awaiting_customer'); // NOT reopened
  });

  it('dedupes a re-delivered Message-ID and threads a reply', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pe({}));
    const dup = await ingestParsed(store, pe({})); // same Message-ID
    expect(dup.deduped).toBe(true);
    expect(dup.threadId).toBe(a.threadId);
    const reply = await ingestParsed(store, pe({
      messageId: '<m2@x>', inReplyTo: '<m1@x>', references: ['<m1@x>'], subject: 'Re: Do you ship to IE?'
    }));
    expect(reply.threadId).toBe(a.threadId); // same thread
  });

  it('uses the real visitor from a Shopify contact-form notification', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({
      messageId: '<n@shopify>', from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      subject: 'New customer message',
      headers: { 'reply-to': 'John Buyer <john@buyer.com>' },
      text: 'Name: John Buyer\nEmail: john@buyer.com\n\nMessage:\nIs the large bed in stock?'
    }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.contact_email).toBe('john@buyer.com');
    expect(got?.thread.status).toBe('new');        // a real form submission must reach the sweep
    expect(got?.thread.classified_at).toBeNull();  // NOT pre-classified as automated
  });

  it('re-opens an awaiting_customer thread on a customer reply and supersedes the pending draft', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pe({}));                       // creates thread (status new)
    // simulate: thread answered → awaiting_customer + a pending draft exists
    await store.setThreadStatus(a.threadId, 'awaiting_customer');
    await store.insertDraft({ threadId: a.threadId, bodyText: 'x', bodyHtml: '<p>x</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    // customer replies (same thread via refs)
    await ingestParsed(store, pe({ messageId: '<m2@x>', inReplyTo: '<m1@x>', references: ['<m1@x>'], subject: 'Re: Do you ship to IE?' }));
    const got = await store.getThreadWithMessages(a.threadId);
    expect(got?.thread.status).toBe('needs_reply');                    // re-opened
    expect(await store.getPendingDraft(a.threadId)).toBeNull();        // superseded
  });

  it('stores the contact-form declared intent on a new thread (Reason dropdown → declared_intent)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({
      messageId: '<form-partner@shopify>', from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' },
      subject: 'New customer message',
      headers: { 'reply-to': 'Mia Creator <mia@creator.com>' },
      text: 'Name: Mia Creator\nEmail: mia@creator.com\nReason: partnerships\n\nMessage:\nI run a dog TikTok and want to collaborate.'
    }));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.contact_email).toBe('mia@creator.com');
    expect(got?.thread.declared_intent).toBe('partnerships');
  });

  it('leaves declared_intent NULL for a normal direct email (no form, no Reason)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await ingestParsed(store, pe({}));
    const got = await store.getThreadWithMessages(r.threadId);
    expect(got?.thread.declared_intent).toBeNull();
  });

  it('does NOT re-open a spam or closed thread on a new inbound', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pe({ messageId: '<s1@x>' }));
    await store.setThreadStatus(a.threadId, 'closed');
    await ingestParsed(store, pe({ messageId: '<s2@x>', inReplyTo: '<s1@x>', references: ['<s1@x>'] }));
    expect((await store.getThreadWithMessages(a.threadId))?.thread.status).toBe('closed');
  });

  it('a DUPLICATE redelivery of a customer reply does NOT reopen the thread or supersede the draft', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pe({}));                 // thread created (new)
    await store.setThreadStatus(a.threadId, 'awaiting_customer');
    await store.insertDraft({ threadId: a.threadId, bodyText: 'x', bodyHtml: '<p>x</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    // first arrival of the reply → reopens (this is correct)
    await ingestParsed(store, pe({ messageId: '<reply-1@x>', inReplyTo: '<m1@x>', references: ['<m1@x>'], subject: 'Re: Do you ship to IE?' }));
    expect((await store.getThreadWithMessages(a.threadId))?.thread.status).toBe('needs_reply');
    // re-open consumed: put it back to awaiting_customer + a fresh pending draft, then REDELIVER the SAME reply
    await store.setThreadStatus(a.threadId, 'awaiting_customer');
    await store.insertDraft({ threadId: a.threadId, bodyText: 'y', bodyHtml: '<p>y</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const dup = await ingestParsed(store, pe({ messageId: '<reply-1@x>', inReplyTo: '<m1@x>', references: ['<m1@x>'], subject: 'Re: Do you ship to IE?' }));
    expect(dup.deduped).toBe(true);
    expect((await store.getThreadWithMessages(a.threadId))?.thread.status).toBe('awaiting_customer'); // NOT reopened
    expect(await store.getPendingDraft(a.threadId)).not.toBeNull();                                    // draft NOT superseded
  });
});
