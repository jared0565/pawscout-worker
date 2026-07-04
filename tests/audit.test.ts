/// <reference types="@cloudflare/vitest-pool-workers" />
// Audit view (2026-07-04, owner ask): a reviewable trail of every email received
// and sent, newest first, with provenance on each send - auto_sent (machine, under
// the reply toggles) vs sent (owner-approved HITL) vs no linked draft (system mail).
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { getAudit } from '../src/console/routes';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

async function seedMailHistory() {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await s.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
  const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-07-01T10:00:00Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'product-question', intentScore: 40, summary: 's', classifiedAt: '2026-07-01T10:05:00Z' });
  // 10:00 inbound question
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<in1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Hi', bodyText: 'Does it fit large dogs?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-01T10:00:00Z' });
  // 11:00 reply sent AUTOMATICALLY (draft auto_sent, linked via sent_message_id)
  const d1 = await s.insertDraft({ threadId: tid, bodyText: 'Yes it does.', bodyHtml: '<p>x</p>', confidence: 90, quotesPriceOrder: false, holdReasons: [], model: 'm1', status: 'pending' });
  await s.setDraftStatus(d1, 'auto_sent', { sentMessageId: 're_auto_1', sentAt: '2026-07-01T11:00:00Z' });
  await s.insertOutboundMessage({ threadId: tid, messageId: 're_auto_1', from: 'support@activepaw.co.uk', to: 'jane@x.com', subject: 'Re: Hi', bodyText: 'Yes it does.', bodyHtml: '<p>x</p>', sentAt: '2026-07-01T11:00:00Z' });
  // 12:00 reply APPROVED by the owner (draft sent)
  const d2 = await s.insertDraft({ threadId: tid, bodyText: 'It ships free.', bodyHtml: '<p>y</p>', confidence: 90, quotesPriceOrder: false, holdReasons: ['autosend_off'], model: 'm2', status: 'pending' });
  await s.setDraftStatus(d2, 'sent', { sentMessageId: 're_hitl_2', sentAt: '2026-07-01T12:00:00Z' });
  await s.insertOutboundMessage({ threadId: tid, messageId: 're_hitl_2', from: 'support@activepaw.co.uk', to: 'jane@x.com', subject: 'Re: Hi', bodyText: 'It ships free.', bodyHtml: '<p>y</p>', sentAt: '2026-07-01T12:00:00Z' });
  // 13:00 outbound with NO linked draft (system mail, e.g. an invoice)
  await s.insertOutboundMessage({ threadId: tid, messageId: 're_sys_3', from: 'support@activepaw.co.uk', to: 'jane@x.com', subject: 'Re: Hi', bodyText: 'Invoice attached.', bodyHtml: '<p>z</p>', sentAt: '2026-07-01T13:00:00Z' });
  return { s, tid };
}

describe('getAudit', () => {
  it('returns the mail trail newest-first with per-send provenance', async () => {
    await seedMailHistory();
    const r = await getAudit(env.DB, SHOP);
    expect(r.ok).toBe(true);
    expect(r.messages.map((m) => m.at)).toEqual([
      '2026-07-01T13:00:00Z', '2026-07-01T12:00:00Z', '2026-07-01T11:00:00Z', '2026-07-01T10:00:00Z'
    ]);
    const [sys, hitl, auto, inbound] = r.messages;
    expect(sys.direction).toBe('outbound');
    expect(sys.sentVia).toBe('other');            // no linked draft = system mail
    expect(hitl.sentVia).toBe('approved');        // owner approved in HITL
    expect(hitl.model).toBe('m2');
    expect(auto.sentVia).toBe('auto');            // machine-sent under the toggles
    expect(inbound.direction).toBe('inbound');
    expect(inbound.sentVia).toBeNull();
    expect(inbound.from).toBe('jane@x.com');
    expect(inbound.category).toBe('product-question');
    expect(inbound.body).toContain('large dogs');
    expect(r.more).toBe(false);
  });

  it('filters by direction', async () => {
    await seedMailHistory();
    const rIn = await getAudit(env.DB, SHOP, { direction: 'inbound' });
    expect(rIn.messages).toHaveLength(1);
    expect(rIn.messages[0].direction).toBe('inbound');
    const rOut = await getAudit(env.DB, SHOP, { direction: 'outbound' });
    expect(rOut.messages).toHaveLength(3);
    expect(rOut.messages.every((m) => m.direction === 'outbound')).toBe(true);
  });

  it('pages older messages with the before cursor and reports more honestly', async () => {
    await seedMailHistory();
    const page = await getAudit(env.DB, SHOP, { before: '2026-07-01T12:00:00Z' });
    expect(page.messages.map((m) => m.at)).toEqual(['2026-07-01T11:00:00Z', '2026-07-01T10:00:00Z']);
    // a full page signals more may exist; the next cursor drains it
    const first = await getAudit(env.DB, SHOP, { limit: 2 });
    expect(first.messages).toHaveLength(2);
    expect(first.more).toBe(true);
    const rest = await getAudit(env.DB, SHOP, { limit: 2, before: first.messages[1].at });
    expect(rest.messages).toHaveLength(2);
  });

  it('ignores a bogus direction value instead of failing', async () => {
    await seedMailHistory();
    const r = await getAudit(env.DB, SHOP, { direction: "x' OR 1=1" });
    expect(r.ok).toBe(true);
    expect(r.messages).toHaveLength(4); // treated as "all"
  });
});
