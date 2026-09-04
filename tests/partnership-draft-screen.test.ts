/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { composeDraftForThread } from '../src/inbox/sweep';
import { maybePartnershipDraft, AFFILIATE_APPLY_URL } from '../src/inbox/partnership';
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

// decline_all is the 2026-07-03 policy, kept behind the Settings toggle since
// 2026-07-04 (default is now the voucher funnel). These tests pin the toggle path.
const DECLINE_CFG: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'decline_all' } };

describe('partnership first-touch, decline_all toggle (2026-07-03 policy, config-driven)', () => {
  it('drafts the warm decline (not the qualifying email) and records the applicant declined', async () => {
    const { s, tid } = await seedFirstTouch('a.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, DECLINE_CFG, thread, noFetch);
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
    const r = await composeDraftForThread({ ...env } as any, s, DECLINE_CFG, thread, noFetch);
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

describe('partnership first-touch, LIVE default (funnel_voucher, owner policy 2026-07-04)', () => {
  it('drafts the VOUCHER qualifying email (code terms + posting-date question), applicant screen_sent', async () => {
    const { s, tid } = await seedFirstTouch('vd.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, CFG, thread, noFetch); // plain DEFAULT_INBOX = the live default
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false); // qualifying emails are ALWAYS HITL
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect(draft!.body_text).toContain('your own discount code');
    expect(draft!.body_text).toContain('when would your first post go live');
    expect(draft!.body_text).toContain('coupon or deal sites');
    expect(draft!.body_text).not.toMatch(/tracked with your own link/i); // link wording stays in the link variant
    expect(draft!.body_text).not.toMatch(/not taking on new partnerships/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('screen_sent');
  });

  it('a PASSED applicant\'s follow-up gets a holding ack, never the affiliate agent\'s decline', async () => {
    const { s, tid } = await seedFirstTouch('vp.myshopify.com');
    await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'passed_to_form' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull(); // must NOT fall through to the generic decline agent
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/reviewing|taking a look/i);
    expect(draft!.body_text).not.toMatch(/not taking on new partnerships/i);
  });
});

describe('partnership first-touch, signup_page mode (owner policy 2026-07-18: self-serve form)', () => {
  const SIGNUP_CFG: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'signup_page' } };

  it('drafts the application-page invite (no screening questions), applicant passed_to_form', async () => {
    const { s, tid } = await seedFirstTouch('sp.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, SIGNUP_CFG, thread, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false); // HITL like every funnel email
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).not.toMatch(/where would you promote/i);   // no email screening
    expect(draft!.body_text).not.toMatch(/not taking on new partnerships/i);
    // 2026-08-07 REVERSAL: this asserted `not.toMatch(/\d+\s?%/)` ("terms live
    // on the page, never in email"). The owner ruled the commission must be
    // stated in the reply, so the invite now carries the figures. They still
    // interpolate from the constants the apply page renders, so the two cannot
    // disagree - only the location changed.
    expect(draft!.body_text).toMatch(/\d+\s?%/);
    expect(draft!.body_text).toMatch(/only partnership we run/i);
    expect(draft!.body_text).toContain('Best Regards,\nActive Paw Partnerships');
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('a screen_sent applicant whose questions never actually went out gets the invite once, stage moves (no re-send loop)', async () => {
    const { s, tid } = await seedFirstTouch('sq.myshopify.com');
    await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'screen_sent' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, SIGNUP_CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).not.toMatch(/where would you promote/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form'); // next reply gets partner handling, not another invite
  });

  // REVERSED 2026-08-14 by owner rule ("when affiliate is introduced, make sure
  // to also give the direct link to the form"). This test used to assert the
  // vendor decline must NOT contain AFFILIATE_APPLY_URL, on the premise that
  // "vendors are not invited to the affiliate form".
  //
  // The premise did not hold against the body it was guarding. SERVICE_DECLINE_BODY
  // has always carried the sentence "If you run a channel or audience and would
  // like to promote Active Paw as an affiliate, that programme is open to
  // anyone" - so the invitation was already there, conditionally, and dropping
  // the URL never removed it. It only removed the way to act on it, leaving
  // "just let us know and we will send you the details": a promise a human then
  // has to keep by hand, for the one sender class we least want to correspond
  // with. The link is the LOWER-touch option, and the form's own Turnstile and
  // screener are what actually keep a non-creator out.
  //
  // What still must hold is that this is a DECLINE, so the assertions below now
  // pin the refusal itself plus the conditional framing of the offer, which is
  // the thing that keeps it from reading as an invitation to a vendor.
  it('a pure service pitch still gets the vendor decline, with the programme named as the only collaboration on offer', async () => {
    const s = new TenantStore(env.DB, 'sv.myshopify.com');
    await s.upsertContact({ email: 'seo@x.com', name: 'Sam', phone: null });
    const tid = await s.createThread({ contactEmail: 'seo@x.com', subject: 'Site speed', subjectNorm: 'site speed', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 40, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<sv1@sv.myshopify.com>', inReplyTo: null, references: [], from: 'seo@x.com', to: 'contact@activepaw.co.uk', subject: 'Site speed', bodyText: 'I am a freelance SEO specialist and I offer search engine optimization for your store', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, SIGNUP_CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    // Still a refusal of the SERVICE they actually pitched...
    expect(draft!.body_text).toMatch(/in-house/);
    expect(draft!.body_text).toMatch(/settled policy rather than a budget or timing question/);
    expect(draft!.body_text).not.toMatch(/great (?:potential )?fit|look forward to seeing your application/i);
    // ...with the programme named as the ONLY collaboration on offer (owner rule
    // 2026-09-04), actionable rather than a promise to send details later.
    expect(draft!.body_text).toMatch(/only collaboration we (?:currently )?run/i);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).not.toMatch(/we will send you the details/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
  });
});

describe('decline template auto-send (owner opt-in 2026-07-03; decline_all toggle on)', () => {
  const AUTO_CFG: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'decline_all', autosend: true, agents: { affiliate: { autosend: true } } } };

  it('auto-sends when the global switch AND the affiliate toggle are both on', async () => {
    const { s, tid } = await seedFirstTouch('g.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, AUTO_CFG, thread, noFetch);
    expect(r!.send).toBe(true);
    const draft = await s.getPendingDraft(tid);
    expect(JSON.parse(draft!.hold_reasons ?? '[]')).toEqual([]);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
  });

  it('holds (autosend_off) when the global switch is on but the affiliate toggle is off', async () => {
    const { s, tid } = await seedFirstTouch('h.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const cfg: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'decline_all', autosend: true } }; // no per-agent opt-in
    const r = await composeDraftForThread({ ...env } as any, s, cfg, thread, noFetch);
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(JSON.parse(draft!.hold_reasons ?? '[]')).toContain('autosend_off');
  });

  it('holds (autosend_off) when only the affiliate toggle is on but the global switch is off', async () => {
    const { s, tid } = await seedFirstTouch('i.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const cfg: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'decline_all', autosend: false, agents: { affiliate: { autosend: true } } } };
    const r = await composeDraftForThread({ ...env } as any, s, cfg, thread, noFetch);
    expect(r!.send).toBe(false);
  });

  it('holds (rate_limited) after 3 outbound messages to the same sender in 24h', async () => {
    const { s, tid } = await seedFirstTouch('j.myshopify.com');
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await s.insertOutboundMessage({ threadId: tid, messageId: `<out${i}@j>`, from: 'sales@activepaw.co.uk', to: 'kasim@x.com', subject: 're', bodyText: 'x', bodyHtml: 'x', sentAt: new Date(now - i * 3600_000).toISOString() });
    }
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, AUTO_CFG, thread, noFetch);
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(JSON.parse(draft!.hold_reasons ?? '[]')).toContain('rate_limited');
  });
});

describe('partnership first-touch, funnel_link mode (link programme preserved verbatim)', () => {
  it('drafts the LINK qualifying email and records the applicant at screen_sent', async () => {
    const { s, tid } = await seedFirstTouch('f.myshopify.com');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch, 'funnel_link');
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect(draft!.body_text).toContain('tracked with your own link'); // the original link terms, unchanged
    expect(draft!.body_text).not.toContain('voucher trial');
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
