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

// Owner rule 2026-09-04: "if they keep sending the same message, consider them
// as spam and block their succeeding messages". The rule the owner chose: spam
// on the 2nd copy of a message we already replied to, or the 3rd copy overall.
// Customers are protected: a thread in an order/shipping/product/complaint/
// wholesale lane, or a contact linked to a Shopify customer, never trips it.
describe('repeat-sender block (ingest)', () => {
  const PITCH = 'I am proposing a performance based collaboration where I will drive 40+ orders with 5k+ targeted visitors within one week. In return I would receive a 3% commission after the results start coming in. Drop your WhatsApp number and I will guide you through the process.';
  const VENDOR = 'vendor@x.com';
  const AUTH_PASS = { 'authentication-results': 'mx; spf=pass dkim=pass dmarc=pass' };
  /** An authenticated message: a block is punitive, so only a sender who proved
   * their address (DMARC pass) can earn one. Spoofed copies never block anyone. */
  const pv = (over: Parameters<typeof pe>[0]) => pe({ headers: AUTH_PASS, ...over });

  /** The sweep's verdict on a vendor pitch: a category no customer lane protects. */
  const classifyOther = (store: TenantStore, threadId: string, status: 'new' | 'needs_reply' = 'needs_reply') =>
    store.setThreadClassification(threadId, { status, primaryCategory: 'other', intentScore: 5, summary: null, classifiedAt: '2026-09-01T10:01:00Z' });

  async function firstPitchAnswered(store: TenantStore) {
    const a = await ingestParsed(store, pv({ messageId: '<p1@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Collaboration', text: PITCH, date: '2026-09-01T10:00:00Z' }));
    // We only reply to a thread the sweep has classified (drafting needs it).
    await classifyOther(store, a.threadId);
    await store.insertOutboundMessage({ threadId: a.threadId, messageId: '<our1@activepaw>', from: 'sales@activepaw.co.uk', to: VENDOR, subject: 'Re: Collaboration', bodyText: 'Our affiliate programme is the only partnership we run.', bodyHtml: '<p>x</p>', sentAt: '2026-09-01T12:00:00Z' });
    await store.setThreadStatus(a.threadId, 'awaiting_customer');
    return a.threadId;
  }

  it('the 2nd copy of a pitch we already answered marks the thread spam, blocks the sender, and does not reopen', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const tid = await firstPitchAnswered(store);
    await store.insertDraft({ threadId: tid, bodyText: 'stale', bodyHtml: '<p>x</p>', confidence: null, quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending' });
    const r = await ingestParsed(store, pv({ messageId: '<p2@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Re: Collaboration', inReplyTo: '<our1@activepaw>', references: ['<p1@x>', '<our1@activepaw>'], text: PITCH + '\n\nOn Tue, Sep 1, 2026 Active Paw wrote:\n> Our affiliate programme', date: '2026-09-03T10:00:00Z' }));
    expect(r.threadId).toBe(tid);
    const got = (await store.getThreadWithMessages(tid))!;
    expect(got.thread.status).toBe('spam');
    expect(got.labels).toContain('spam');
    expect(await store.getPendingDraft(tid)).toBeNull();
    const contact = (await store.getContactByEmail(VENDOR))!;
    expect(contact.blocked_at).not.toBeNull();
    expect(contact.blocked_reason).toMatch(/repeat/i);
  });

  it("a blocked sender's next message lands as spam at ingest, pre-classified, even under a new subject", async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertContact({ email: VENDOR, name: 'Vendor', phone: null });
    await store.blockContact(VENDOR, 'repeat message x2');
    const r = await ingestParsed(store, pv({ messageId: '<p9@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Quick question about your store', text: 'Completely different text this time, are you the owner of this store? I have a proposal for you.', date: '2026-09-05T10:00:00Z' }));
    const got = (await store.getThreadWithMessages(r.threadId))!;
    expect(got.thread.status).toBe('spam');
    expect(got.thread.primary_category).toBe('spam');
    expect(got.thread.classified_at).not.toBeNull(); // never enters the LLM sweep
    expect(got.labels).toContain('spam');
  });

  it('a reworded follow-up is not a repeat: the thread reopens and the sender stays unblocked', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const tid = await firstPitchAnswered(store);
    await ingestParsed(store, pv({ messageId: '<p3@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Re: Collaboration', inReplyTo: '<our1@activepaw>', references: ['<p1@x>'], text: 'Hello, wondering if you saw my last message on driving predictable sales? Open for a brief chat this week?', date: '2026-09-03T10:00:00Z' }));
    expect((await store.getThreadWithMessages(tid))!.thread.status).toBe('needs_reply');
    expect((await store.getContactByEmail(VENDOR))!.blocked_at).toBeNull();
  });

  it('a 2nd copy BEFORE any reply does not block; the 3rd copy does', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pv({ messageId: '<q1@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello', text: PITCH, date: '2026-09-01T10:00:00Z' }));
    await ingestParsed(store, pv({ messageId: '<q2@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello', text: PITCH, date: '2026-09-01T10:05:00Z' }));
    expect((await store.getContactByEmail(VENDOR))!.blocked_at).toBeNull();
    expect((await store.getThreadWithMessages(a.threadId))!.thread.status).toBe('new');
    await classifyOther(store, a.threadId, 'new');
    await ingestParsed(store, pv({ messageId: '<q3@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello again', text: PITCH, date: '2026-09-02T10:00:00Z' }));
    expect((await store.getContactByEmail(VENDOR))!.blocked_at).not.toBeNull();
  });

  // aramid 114e2e7b (2026-10-07): customer protection reads the thread's
  // category, which the sweep writes later. A customer who sent the same
  // product question three times before the sweep ran was unprotected and got
  // blocked. The block now waits until every thread holding an earlier copy has
  // been classified; then the protection can see what the sender is.
  it('copies on a thread the sweep has not classified yet never block; once it is classified as no customer lane, the next copy does', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const ask = 'Is the orthopaedic memory foam dog bed available in the extra large size and grey colour please?';
    const a = await ingestParsed(store, pv({ messageId: '<n1@x>', from: { email: 'asker@x.com', name: 'A' }, subject: 'Dog bed', text: ask, date: '2026-09-01T10:00:00Z' }));
    await ingestParsed(store, pv({ messageId: '<n2@x>', from: { email: 'asker@x.com', name: 'A' }, subject: 'Dog bed', text: ask, date: '2026-09-01T10:02:00Z' }));
    await ingestParsed(store, pv({ messageId: '<n3@x>', from: { email: 'asker@x.com', name: 'A' }, subject: 'Dog bed', text: ask, date: '2026-09-01T10:04:00Z' }));
    expect((await store.getContactByEmail('asker@x.com'))!.blocked_at).toBeNull();
    expect((await store.getThreadWithMessages(a.threadId))!.thread.status).toBe('new');
    await classifyOther(store, a.threadId, 'new');
    await ingestParsed(store, pv({ messageId: '<n4@x>', from: { email: 'asker@x.com', name: 'A' }, subject: 'Dog bed', text: ask, date: '2026-09-01T10:30:00Z' }));
    expect((await store.getContactByEmail('asker@x.com'))!.blocked_at).not.toBeNull();
  });

  it('a thread the sweep will never classify (no longer new) does not hold the block back', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pv({ messageId: '<z1@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello', text: PITCH, date: '2026-09-01T10:00:00Z' }));
    await store.setThreadStatus(a.threadId, 'closed'); // closed before the sweep reached it: classified_at stays NULL
    await ingestParsed(store, pv({ messageId: '<z2@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello', text: PITCH, date: '2026-09-01T10:05:00Z' }));
    await ingestParsed(store, pv({ messageId: '<z3@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello', text: PITCH, date: '2026-09-01T10:10:00Z' }));
    expect((await store.getContactByEmail(VENDOR))!.blocked_at).not.toBeNull();
  });

  it('a thread left unclassified for more than a day does not hold the block back', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pv({ messageId: '<y1@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello', text: PITCH, date: '2026-09-01T10:00:00Z' }));
    await env.DB.prepare('UPDATE inbox_threads SET created_at = ?1 WHERE shop = ?2 AND id = ?3')
      .bind(new Date(Date.now() - 2 * 86_400_000).toISOString(), SHOP, a.threadId).run();
    await ingestParsed(store, pv({ messageId: '<y2@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello', text: PITCH, date: '2026-09-01T10:05:00Z' }));
    await ingestParsed(store, pv({ messageId: '<y3@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello', text: PITCH, date: '2026-09-01T10:10:00Z' }));
    expect((await store.getContactByEmail(VENDOR))!.blocked_at).not.toBeNull();
  });

  it('the same copies on a thread the sweep classified as a product question never block', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const ask = 'Is the orthopaedic memory foam dog bed available in the extra large size and grey colour please?';
    const a = await ingestParsed(store, pv({ messageId: '<pq1@x>', from: { email: 'asker2@x.com', name: 'A' }, subject: 'Dog bed', text: ask, date: '2026-09-01T10:00:00Z' }));
    await store.setThreadClassification(a.threadId, { status: 'new', primaryCategory: 'product-question', intentScore: 60, summary: null, classifiedAt: '2026-09-01T10:01:00Z' });
    for (const [id, when] of [['<pq2@x>', '2026-09-01T10:02:00Z'], ['<pq3@x>', '2026-09-01T10:04:00Z']]) {
      await ingestParsed(store, pv({ messageId: id, from: { email: 'asker2@x.com', name: 'A' }, subject: 'Dog bed', text: ask, date: when }));
    }
    expect((await store.getContactByEmail('asker2@x.com'))!.blocked_at).toBeNull();
  });

  it('a customer in an order-status thread is never blocked for re-sending the same message', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const ask = 'Hello, I placed order 1042 nine days ago and the tracking has not moved since Friday. Can you tell me where my parcel is and when it will arrive?';
    const a = await ingestParsed(store, pv({ messageId: '<c1@x>', from: { email: 'cust@x.com', name: 'Cust' }, subject: 'Order 1042', text: ask, date: '2026-09-01T10:00:00Z' }));
    await store.setThreadClassification(a.threadId, { status: 'needs_reply', primaryCategory: 'order-status', intentScore: 50, summary: null, classifiedAt: '2026-09-01T10:01:00Z' });
    await store.insertOutboundMessage({ threadId: a.threadId, messageId: '<our-c1@activepaw>', from: 'support@activepaw.co.uk', to: 'cust@x.com', subject: 'Re: Order 1042', bodyText: 'Looking into it.', bodyHtml: '<p>x</p>', sentAt: '2026-09-01T12:00:00Z' });
    await store.setThreadStatus(a.threadId, 'awaiting_customer');
    await ingestParsed(store, pv({ messageId: '<c2@x>', from: { email: 'cust@x.com', name: 'Cust' }, subject: 'Re: Order 1042', inReplyTo: '<our-c1@activepaw>', references: ['<c1@x>'], text: ask, date: '2026-09-03T10:00:00Z' }));
    expect((await store.getContactByEmail('cust@x.com'))!.blocked_at).toBeNull();
    expect((await store.getThreadWithMessages(a.threadId))!.thread.status).toBe('needs_reply');
  });

  it('a contact linked to a Shopify customer is never blocked', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const tid = await firstPitchAnswered(store);
    await store.linkContactToShopifyCustomer(VENDOR, 'gid://shopify/Customer/1');
    await ingestParsed(store, pv({ messageId: '<p4@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Re: Collaboration', inReplyTo: '<our1@activepaw>', references: ['<p1@x>'], text: PITCH, date: '2026-09-03T10:00:00Z' }));
    expect((await store.getContactByEmail(VENDOR))!.blocked_at).toBeNull();
    expect((await store.getThreadWithMessages(tid))!.thread.status).toBe('needs_reply');
  });

  it('unblockContact lifts the block, so the next message is treated normally again', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertContact({ email: VENDOR, name: 'Vendor', phone: null });
    await store.blockContact(VENDOR, 'repeat message x2');
    await store.unblockContact(VENDOR);
    const r = await ingestParsed(store, pv({ messageId: '<p8@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Hello', text: 'A brand new message that is long enough to be judged on its own merits by the funnel.', date: '2026-09-06T10:00:00Z' }));
    expect((await store.getThreadWithMessages(r.threadId))!.thread.status).toBe('new');
    expect((await store.getContactByEmail(VENDOR))!.blocked_at).toBeNull();
  });
  // aramid reviewer findings on the first cut (2026-09-04), all three fixed here:
  // the block keyed on an unauthenticated From address (a spoofer could silence a
  // customer); customer protection leaned on a classification the sweep may not
  // have written yet; and a block was never lifted when the contact later became
  // a customer.
  it('three identical copies WITHOUT a passing DMARC result never block: a spoofer cannot silence a third party', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const [id, when] of [['<s1@x>', '2026-09-01T10:00:00Z'], ['<s2@x>', '2026-09-01T10:05:00Z'], ['<s3@x>', '2026-09-02T10:00:00Z']]) {
      await ingestParsed(store, pe({ messageId: id, from: { email: 'victim@x.com', name: 'V' }, subject: 'Hello ' + id, text: PITCH, date: when, headers: {} }));
    }
    expect((await store.getContactByEmail('victim@x.com'))!.blocked_at).toBeNull();
  });

  // aramid 2f32d185 (2026-10-07): only the message that SETS the block had to
  // pass DMARC. The earlier copies it counted were read back with no check, so
  // two forged copies under a victim's address (on a domain whose DMARC result
  // is 'none', which is not spam) plus one genuine message with the same text
  // blocked the genuine sender. Every counted copy must now have passed DMARC.
  it('forged earlier copies are not counted: two unauthenticated copies and a genuine third never block', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pe({ messageId: '<g1@x>', from: { email: 'victim@x.com', name: 'V' }, subject: 'Hello', text: PITCH, date: '2026-09-01T10:00:00Z', headers: {} }));
    const b = await ingestParsed(store, pe({ messageId: '<g2@x>', from: { email: 'victim@x.com', name: 'V' }, subject: 'Hello there', text: PITCH, date: '2026-09-01T10:05:00Z', headers: {} }));
    // Classified, so the wait for the sweep cannot be what holds the block back.
    await classifyOther(store, a.threadId, 'new');
    await classifyOther(store, b.threadId, 'new');
    await ingestParsed(store, pv({ messageId: '<g3@x>', from: { email: 'victim@x.com', name: 'V' }, subject: 'Hello again', text: PITCH, date: '2026-09-02T10:00:00Z' }));
    expect((await store.getContactByEmail('victim@x.com'))!.blocked_at).toBeNull();
  });

  it('a forged copy we replied to is not counted: a genuine second copy never blocks', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await ingestParsed(store, pe({ messageId: '<h1@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Collaboration', text: PITCH, date: '2026-09-01T10:00:00Z', headers: {} }));
    await classifyOther(store, a.threadId);
    await store.insertOutboundMessage({ threadId: a.threadId, messageId: '<our-h1@activepaw>', from: 'sales@activepaw.co.uk', to: VENDOR, subject: 'Re: Collaboration', bodyText: 'Our affiliate programme is the only partnership we run.', bodyHtml: '<p>x</p>', sentAt: '2026-09-01T12:00:00Z' });
    await store.setThreadStatus(a.threadId, 'awaiting_customer');
    await ingestParsed(store, pv({ messageId: '<h2@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Collaboration', text: PITCH, date: '2026-09-02T10:00:00Z' }));
    expect((await store.getContactByEmail(VENDOR))!.blocked_at).toBeNull();
  });

  it("the block's reason counts the copies, not every recent message from the sender", async () => {
    const store = new TenantStore(env.DB, SHOP);
    const tid = await firstPitchAnswered(store);
    // A different message in between: not a copy, so not in the count.
    await ingestParsed(store, pv({ messageId: '<r2@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Re: Collaboration', inReplyTo: '<our1@activepaw>', references: ['<p1@x>'], text: 'Hello, wondering if you saw my last message on driving predictable sales? Open for a brief chat this week?', date: '2026-09-02T10:00:00Z' }));
    expect((await store.getThreadWithMessages(tid))!.thread.status).toBe('needs_reply');
    await ingestParsed(store, pv({ messageId: '<r3@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Collaboration', text: PITCH, date: '2026-09-03T10:00:00Z' }));
    expect((await store.getContactByEmail(VENDOR))!.blocked_reason).toBe('repeat message: same text sent 2 times, blocked at ingest');
  });

  it('contact-form copies are not counted toward a block on the address typed into the form', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // A form post's DMARC result is the relay's, and its address is whatever
    // was typed, so it proves nothing about that address.
    const form = (id: string, when: string) => pe({
      messageId: id, from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' }, subject: 'New customer message',
      headers: { ...AUTH_PASS, 'reply-to': 'Typed <typed@x.com>' }, text: `Name: Typed
Email: typed@x.com

Message:
${PITCH}`, date: when
    });
    const a = await ingestParsed(store, form('<k1@shopify>', '2026-09-01T10:00:00Z'));
    const b = await ingestParsed(store, form('<k2@shopify>', '2026-09-01T10:05:00Z'));
    await classifyOther(store, a.threadId, 'new');
    await classifyOther(store, b.threadId, 'new');
    await ingestParsed(store, pv({ messageId: '<k3@x>', from: { email: 'typed@x.com', name: 'Typed' }, subject: 'Hello', text: PITCH, date: '2026-09-02T10:00:00Z' }));
    expect((await store.getContactByEmail('typed@x.com'))!.blocked_at).toBeNull();
  });

  it('an order-shaped message re-sent three times on an UNCLASSIFIED thread never blocks (no dependence on the sweep)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const ask = 'Hello, I placed order 1042 nine days ago and the tracking has not moved since Friday. Can you tell me where my parcel is and when it will arrive?';
    for (const [id, when] of [['<u1@x>', '2026-09-01T10:00:00Z'], ['<u2@x>', '2026-09-01T10:05:00Z'], ['<u3@x>', '2026-09-02T10:00:00Z']]) {
      await ingestParsed(store, pv({ messageId: id, from: { email: 'cust2@x.com', name: 'Cust' }, subject: 'Order 1042 ' + id, text: ask, date: when }));
    }
    expect((await store.getContactByEmail('cust2@x.com'))!.blocked_at).toBeNull();
  });

  // aramid llm-review b4b33fbf (fixed 2026-09-07): a block was set once and
  // never re-read, so a wrongly blocked contact who later wrote about an order
  // was spam for ever. The same deterministic guard that stops a customer being
  // blocked (an order-shaped message, from an authenticated sender) now lets
  // one back in: the block lifts at ingest and the message enters the queue.
  it('an order-shaped, DMARC-passing message from a blocked sender lifts the block and enters the queue', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertContact({ email: VENDOR, name: 'Vendor', phone: null });
    await store.blockContact(VENDOR, 'repeat message x3');
    const r = await ingestParsed(store, pv({ messageId: '<ord1@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Order 1042', text: 'Hi, I placed order #1042 last week and it has not arrived yet. Can you check the tracking for me?', date: '2026-09-06T10:00:00Z' }));
    const got = (await store.getThreadWithMessages(r.threadId))!;
    expect(got.thread.status).toBe('new');          // a normal inbound, not spam
    expect(got.thread.classified_at).toBeNull();    // enters the LLM sweep like any customer message
    expect(got.labels).not.toContain('spam');
    const c = (await store.getContactByEmail(VENDOR))!;
    expect(c.blocked_at).toBeNull();
  });

  it("a blocked sender's order-shaped message WITHOUT a passing DMARC result stays blocked", async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertContact({ email: VENDOR, name: 'Vendor', phone: null });
    await store.blockContact(VENDOR, 'repeat message x3');
    const r = await ingestParsed(store, pe({ messageId: '<ord2@x>', from: { email: VENDOR, name: 'Vendor' }, subject: 'Order 1042', text: 'Hi, I placed order #1042 last week and it has not arrived yet.', date: '2026-09-06T10:00:00Z' }));
    expect((await store.getThreadWithMessages(r.threadId))!.thread.status).toBe('spam');
    expect((await store.getContactByEmail(VENDOR))!.blocked_at).not.toBeNull();
  });

  // aramid b4b33fbf, rest of it (2026-10-07): a blocked customer who wrote
  // through the contact form could never get through, because form posts were
  // left out entirely. An order-shaped form message now reaches the queue, but
  // the address in a form is whatever was typed, so it never lifts the block
  // (security review of the first cut): the owner does that from the list. A
  // form post never SETS a block either.
  const formFrom = (email: string, text: string, id: string) => pe({
    messageId: id, from: { email: 'no-reply@shopifyemail.com', name: 'Active Paw' }, subject: 'New customer message',
    headers: { 'reply-to': `Buyer <${email}>` }, text: `Name: Buyer\nEmail: ${email}\n\nMessage:\n${text}`, date: '2026-09-06T10:00:00Z'
  });

  it('an order-shaped contact-form message from a blocked sender enters the queue, and the block stays', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertContact({ email: 'buyer@x.com', name: 'Buyer', phone: null });
    await store.blockContact('buyer@x.com', 'repeat message x3');
    const r = await ingestParsed(store, formFrom('buyer@x.com', 'Hi, I placed order #1042 last week and it has not arrived yet. Can you check the tracking for me?', '<f1@shopify>'));
    const got = (await store.getThreadWithMessages(r.threadId))!;
    expect(got.thread.contact_email).toBe('buyer@x.com');
    expect(got.thread.status).toBe('new');
    expect(got.labels).not.toContain('spam');
    expect((await store.getContactByEmail('buyer@x.com'))!.blocked_at).not.toBeNull();
  });

  it('three identical contact-form messages never block the address typed into the form', async () => {
    const store = new TenantStore(env.DB, SHOP);
    for (const id of ['<f2@shopify>', '<f3@shopify>', '<f4@shopify>']) {
      await ingestParsed(store, formFrom('typed@x.com', PITCH, id));
    }
    expect((await store.getContactByEmail('typed@x.com'))!.blocked_at).toBeNull();
  });

  it('linking the contact to a Shopify customer lifts an existing block', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertContact({ email: VENDOR, name: 'Vendor', phone: null });
    await store.blockContact(VENDOR, 'repeat message x2');
    await store.linkContactToShopifyCustomer(VENDOR, 'gid://shopify/Customer/9');
    const c = (await store.getContactByEmail(VENDOR))!;
    expect(c.blocked_at).toBeNull();
    expect(c.blocked_reason).toBeNull();
  });
});
