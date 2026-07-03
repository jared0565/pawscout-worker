/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { composeDraftForThread } from '../src/inbox/sweep';
import { maybePartnershipDraft } from '../src/inbox/partnership';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };
const noFetch: typeof fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

async function seedFirstTouch(shop: string, opts?: { declaredIntent?: string; category?: string; to?: string }) {
  const s = new TenantStore(env.DB, shop);
  await s.upsertContact({ email: 'kasim@x.com', name: 'Kasim', phone: null });
  const tid = await s.createThread({ contactEmail: 'kasim@x.com', subject: 'Partnership', subjectNorm: 'partnership', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply', declaredIntent: opts?.declaredIntent });
  await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: opts?.category ?? 'affiliate', intentScore: 60, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<a1@${shop}>`, inReplyTo: null, references: [], from: 'kasim@x.com', to: opts?.to ?? 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'I run a dog IG, want to promote you for commission', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
  return { s, tid };
}

describe('partnership first-touch, LIVE default (decline_all, owner policy 2026-07-03)', () => {
  it('drafts the warm decline (not the qualifying email) and records the applicant declined', async () => {
    const { s, tid } = await seedFirstTouch('a.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, CFG, thread, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false); // HITL - owner approves
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/not taking on new partnerships/i);
    expect(draft!.body_text).not.toMatch(/where would you promote/i); // no qualifying questions
    expect(draft!.body_text).toContain('Best Regards,\nActive Paw Partnerships');
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
  });

  it('a declared partnerships form (non-affiliate category) also gets the decline on first touch', async () => {
    const { s, tid } = await seedFirstTouch('c.myshopify.com', { declaredIntent: 'partnerships', category: 'other', to: 'support@activepaw.co.uk' });
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    expect(await s.getApplicantByThread(tid)).toBeNull(); // genuinely first touch
    const r = await composeDraftForThread({ ...env } as any, s, CFG, thread, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/not taking on new partnerships/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
  });

  it('a follow-up AFTER the decline falls through to the generic drafter (no template ping-pong)', async () => {
    const { s, tid } = await seedFirstTouch('e.myshopify.com');
    await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'declined' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).toBeNull(); // generic drafter (affiliate agent) handles the reply
  });
});

describe('partnership first-touch, funnel mode (machinery preserved for re-enable)', () => {
  it('drafts the qualifying email and records the applicant at screen_sent', async () => {
    const { s, tid } = await seedFirstTouch('f.myshopify.com');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch, 'funnel');
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect(draft!.body_text).toContain('Active Paw Partnerships');
    expect((await s.getApplicantByThread(tid))!.stage).toBe('screen_sent');
  });
});

describe('partnership lane routing (unchanged by the mode)', () => {
  it('a plain support thread is untouched by the intercept (generic path runs)', async () => {
    const s = new TenantStore(env.DB, 'b.myshopify.com');
    await s.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Where is my order', subjectNorm: 'where is my order', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'order-status', intentScore: 20, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<b1@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Where is my order', bodyText: 'where is my order?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    // No LLM keys → generic draftReply returns null → composeDraftForThread returns null.
    const r = await composeDraftForThread({ ...env } as any, s, CFG, thread, noFetch);
    expect(r).toBeNull();
    expect(await s.getApplicantByThread(tid)).toBeNull(); // intercept did NOT fire
  });

  it('a declared wholesale form does NOT enter the funnel (generic drafter path)', async () => {
    const s = new TenantStore(env.DB, 'd.myshopify.com');
    await s.upsertContact({ email: 'buyer@trade.com', name: 'Buyer', phone: null });
    const tid = await s.createThread({ contactEmail: 'buyer@trade.com', subject: 'Bulk order', subjectNorm: 'bulk order', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply', declaredIntent: 'wholesale' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 30, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<d1@x>', inReplyTo: null, references: [], from: 'buyer@trade.com', to: 'support@activepaw.co.uk', subject: 'Bulk order', bodyText: 'Can I buy 500 units wholesale?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, CFG, thread, noFetch);
    // No LLM keys → generic drafter returns null; the partnership intercept must NOT fire.
    expect(r).toBeNull();
    expect(await s.getApplicantByThread(tid)).toBeNull();
  });
});
