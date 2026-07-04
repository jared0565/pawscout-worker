/// <reference types="@cloudflare/vitest-pool-workers" />
// Audit view v2 (2026-07-04, owner redesign): the landing list is CONTACTS
// (email + name + latest-contact date), filterable by thread classification;
// clicking one opens the full conversation (all threads with that contact),
// newest first, each sent message carrying its provenance (auto_sent = machine
// under the reply toggles, sent = owner-approved HITL, no linked draft = system).
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { getAudit, getAuditConversation } from '../src/console/routes';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

async function seedMailHistory() {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await s.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });

  // Jane, thread 1 (product-question): inbound + auto-sent + approved + system mail.
  const t1 = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-07-01T10:00:00Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(t1, { status: 'needs_reply', primaryCategory: 'product-question', intentScore: 40, summary: 's', classifiedAt: '2026-07-01T10:05:00Z' });
  await s.insertInboundMessageIfNew({ threadId: t1, messageId: '<in1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Hi', bodyText: 'Does it fit large dogs?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-01T10:00:00Z' });
  const d1 = await s.insertDraft({ threadId: t1, bodyText: 'Yes it does.', bodyHtml: '<p>x</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm1', status: 'pending' });
  await s.setDraftStatus(d1, 'auto_sent', { sentMessageId: 're_auto_1', sentAt: '2026-07-01T11:00:00Z' });
  await s.insertOutboundMessage({ threadId: t1, messageId: 're_auto_1', from: 'support@activepaw.co.uk', to: 'jane@x.com', subject: 'Re: Hi', bodyText: 'Yes it does.', bodyHtml: '<p>x</p>', sentAt: '2026-07-01T11:00:00Z' });
  const d2 = await s.insertDraft({ threadId: t1, bodyText: 'It ships free.', bodyHtml: '<p>y</p>', confidence: 90, quotesPriceOrder: false, holdReasons: ['autosend_off'], model: 'm2', status: 'pending' });
  await s.setDraftStatus(d2, 'sent', { sentMessageId: 're_hitl_2', sentAt: '2026-07-01T12:00:00Z' });
  await s.insertOutboundMessage({ threadId: t1, messageId: 're_hitl_2', from: 'support@activepaw.co.uk', to: 'jane@x.com', subject: 'Re: Hi', bodyText: 'It ships free.', bodyHtml: '<p>y</p>', sentAt: '2026-07-01T12:00:00Z' });
  await s.insertOutboundMessage({ threadId: t1, messageId: 're_sys_3', from: 'support@activepaw.co.uk', to: 'jane@x.com', subject: 'Re: Hi', bodyText: 'Invoice attached.', bodyHtml: '<p>z</p>', sentAt: '2026-07-01T13:00:00Z' });

  // Jane, thread 2 (order-status): a later inbound - the conversation view must
  // stitch BOTH threads together; the contact's latest-activity date comes here.
  const t2 = await s.createThread({ contactEmail: 'jane@x.com', subject: 'My order', subjectNorm: 'my order', receivedAt: '2026-07-01T14:00:00Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(t2, { status: 'needs_reply', primaryCategory: 'order-status', intentScore: 50, summary: 's', classifiedAt: '2026-07-01T14:05:00Z' });
  await s.insertInboundMessageIfNew({ threadId: t2, messageId: '<in2@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'My order', bodyText: 'Where is my order?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-01T14:00:00Z' });

  // A second contact (no stored name): an affiliate pitch, older activity.
  const t3 = await s.createThread({ contactEmail: 'pitch@y.com', subject: 'Collab', subjectNorm: 'collab', receivedAt: '2026-07-01T09:00:00Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(t3, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 10, summary: 's', classifiedAt: '2026-07-01T09:05:00Z' });
  await s.insertInboundMessageIfNew({ threadId: t3, messageId: '<in3@y>', inReplyTo: null, references: [], from: 'pitch@y.com', to: 'support@activepaw.co.uk', subject: 'Collab', bodyText: 'What commission do you pay?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-01T09:00:00Z' });
  return s;
}

describe('getAudit (contact list)', () => {
  it('lists contacts newest-activity-first with name, count and categories', async () => {
    await seedMailHistory();
    const r = await getAudit(env.DB, SHOP);
    expect(r.ok).toBe(true);
    expect(r.contacts.map((c) => c.email)).toEqual(['jane@x.com', 'pitch@y.com']);
    const [jane, pitch] = r.contacts;
    expect(jane.name).toBe('Jane');
    expect(jane.lastAt).toBe('2026-07-01T14:00:00Z'); // thread 2's inbound, not thread 1's
    expect(jane.messages).toBe(5);
    expect(jane.categories).toContain('product-question');
    expect(jane.categories).toContain('order-status');
    expect(pitch.name).toBeNull();
    expect(pitch.categories).toEqual(['affiliate']);
    expect(r.more).toBe(false);
  });

  it('filters contacts by thread classification', async () => {
    await seedMailHistory();
    const r = await getAudit(env.DB, SHOP, { category: 'affiliate' });
    expect(r.contacts.map((c) => c.email)).toEqual(['pitch@y.com']);
    const r2 = await getAudit(env.DB, SHOP, { category: 'order-status' });
    expect(r2.contacts.map((c) => c.email)).toEqual(['jane@x.com']);
    // filtered view scopes the activity date to the matching threads
    expect(r2.contacts[0].lastAt).toBe('2026-07-01T14:00:00Z');
  });

  it('treats a bogus category as "all" instead of failing', async () => {
    await seedMailHistory();
    const r = await getAudit(env.DB, SHOP, { category: "x' OR 1=1 --" });
    expect(r.ok).toBe(true);
    expect(r.contacts).toHaveLength(2);
  });

  it('pages older contacts with the before cursor', async () => {
    await seedMailHistory();
    const first = await getAudit(env.DB, SHOP, { limit: 1 });
    expect(first.contacts.map((c) => c.email)).toEqual(['jane@x.com']);
    expect(first.more).toBe(true);
    const rest = await getAudit(env.DB, SHOP, { limit: 1, before: first.contacts[0].lastAt });
    expect(rest.contacts.map((c) => c.email)).toEqual(['pitch@y.com']);
  });
});

describe('getAuditConversation', () => {
  it('returns the full cross-thread conversation newest-first with provenance', async () => {
    await seedMailHistory();
    const r = await getAuditConversation(env.DB, SHOP, 'jane@x.com');
    if (!r.ok) throw new Error('conversation fetch failed');
    expect(r.contact).toEqual({ email: 'jane@x.com', name: 'Jane' });
    expect(r.messages.map((m) => m.at)).toEqual([
      '2026-07-01T14:00:00Z', // thread 2 inbound - both threads stitched together
      '2026-07-01T13:00:00Z', '2026-07-01T12:00:00Z', '2026-07-01T11:00:00Z', '2026-07-01T10:00:00Z'
    ]);
    const [, sys, hitl, auto, first] = r.messages;
    expect(sys.sentVia).toBe('other');
    expect(hitl.sentVia).toBe('approved');
    expect(hitl.model).toBe('m2');
    expect(auto.sentVia).toBe('auto');
    expect(first.direction).toBe('inbound');
    expect(first.sentVia).toBeNull();
    expect(first.body).toContain('large dogs');
    expect(r.messages[0].category).toBe('order-status');
  });

  it('rejects a missing email and returns empty for an unknown one', async () => {
    await seedMailHistory();
    const bad = await getAuditConversation(env.DB, SHOP, '');
    expect(bad.ok).toBe(false);
    const unknown = await getAuditConversation(env.DB, SHOP, 'nobody@nowhere.com');
    if (!unknown.ok) throw new Error('unknown-contact fetch failed');
    expect(unknown.messages).toEqual([]);
  });
});
