/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { composeDraftForThread } from '../src/inbox/sweep';
import { maybePartnershipDraft, AFFILIATE_APPLY_URL, buildHoldingAck, buildQualifyingEmail, buildSignupInvite, buildSecondTouch } from '../src/inbox/partnership';
import { countWords } from '../src/inbox/draft-quality';
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
    expect((r as { send: boolean }).send).toBe(false); // HITL - owner approves
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/not a fit for our affiliate programme/i);
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
    expect(draft!.body_text).toMatch(/not a fit for our affiliate programme/i);
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
    expect((r as { send: boolean }).send).toBe(false); // qualifying emails are ALWAYS HITL
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect(draft!.body_text).toContain('your own discount code');
    expect(draft!.body_text).toContain('when would your first post go live');
    expect(draft!.body_text).toContain('coupon or deal sites');
    expect(draft!.body_text).not.toMatch(/tracked with your own link/i); // link wording stays in the link variant
    expect(draft!.body_text).not.toMatch(/not a fit for our affiliate programme/i);
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
    expect(draft!.body_text).not.toMatch(/not a fit for our affiliate programme/i);
  });
});

describe('partnership first-touch, signup_page mode (owner policy 2026-07-18: self-serve form)', () => {
  const SIGNUP_CFG: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'signup_page' } };

  it('drafts the application-page invite (no screening questions), applicant passed_to_form', async () => {
    const { s, tid } = await seedFirstTouch('sp.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, SIGNUP_CFG, thread, noFetch);
    expect(r).not.toBeNull();
    expect((r as { send: boolean }).send).toBe(false); // HITL like every funnel email
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).not.toMatch(/where would you promote/i);   // no email screening
    expect(draft!.body_text).not.toMatch(/not a fit for our affiliate programme/i);
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
  // 2026-09-17, REVERSED AGAIN by owner rule: it is no longer a decline at all.
  // "We are receiving too many offers on their services and we are just
  // declining them blankly": the vendor now gets the prove-first answer (the
  // code trial is the filter, tracked orders decide) and is staged like any
  // invited applicant. The assertions pin the filter story, the link and the
  // absence of the old in-house refusal.
  it('a pure service pitch gets the prove-first answer with the link, staged passed_to_form', async () => {
    const s = new TenantStore(env.DB, 'sv.myshopify.com');
    await s.upsertContact({ email: 'seo@x.com', name: 'Sam', phone: null });
    const tid = await s.createThread({ contactEmail: 'seo@x.com', subject: 'Site speed', subjectNorm: 'site speed', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 40, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<sv1@sv.myshopify.com>', inReplyTo: null, references: [], from: 'seo@x.com', to: 'contact@activepaw.co.uk', subject: 'Site speed', bodyText: 'I am a freelance SEO specialist and I offer search engine optimization for your store', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, SIGNUP_CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    // The filter, not a refusal of the service they pitched...
    expect(draft!.body_text).toMatch(/receive a lot of offers/i);
    expect(draft!.body_text).toMatch(/who can actually deliver/i);
    expect(draft!.body_text).not.toMatch(/in-house|settled policy/);
    expect(draft!.body_text).not.toMatch(/great (?:potential )?fit|look forward to seeing your application/i);
    // ...actionable rather than a promise to send details later.
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).not.toMatch(/we will send you the details/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });
});

describe('decline template auto-send (owner opt-in 2026-07-03; decline_all toggle on)', () => {
  const AUTO_CFG: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'decline_all', autosend: true, agents: { affiliate: { autosend: true } } } };

  it('auto-sends when the global switch AND the affiliate toggle are both on', async () => {
    const { s, tid } = await seedFirstTouch('g.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, AUTO_CFG, thread, noFetch);
    expect((r as { send: boolean }).send).toBe(true);
    const draft = await s.getPendingDraft(tid);
    expect(JSON.parse(draft!.hold_reasons ?? '[]')).toEqual([]);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
  });

  it('holds (autosend_off) when the global switch is on but the affiliate toggle is off', async () => {
    const { s, tid } = await seedFirstTouch('h.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const cfg: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'decline_all', autosend: true } }; // no per-agent opt-in
    const r = await composeDraftForThread({ ...env } as any, s, cfg, thread, noFetch);
    expect((r as { send: boolean }).send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(JSON.parse(draft!.hold_reasons ?? '[]')).toContain('autosend_off');
  });

  it('holds (autosend_off) when only the affiliate toggle is on but the global switch is off', async () => {
    const { s, tid } = await seedFirstTouch('i.myshopify.com');
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const cfg: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'decline_all', autosend: false, agents: { affiliate: { autosend: true } } } };
    const r = await composeDraftForThread({ ...env } as any, s, cfg, thread, noFetch);
    expect((r as { send: boolean }).send).toBe(false);
  });

  it('holds (rate_limited) after 3 outbound messages to the same sender in 24h', async () => {
    const { s, tid } = await seedFirstTouch('j.myshopify.com');
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await s.insertOutboundMessage({ threadId: tid, messageId: `<out${i}@j>`, from: 'sales@activepaw.co.uk', to: 'kasim@x.com', subject: 're', bodyText: 'x', bodyHtml: 'x', sentAt: new Date(now - i * 3600_000).toISOString() });
    }
    const thread = (await s.getThreadWithMessages(tid))!.thread;
    const r = await composeDraftForThread({ ...env } as any, s, AUTO_CFG, thread, noFetch);
    expect((r as { send: boolean }).send).toBe(false);
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

// Owner rule 2026-09-04: the funnel never repeats a message it already sent on
// the thread. The July offender was exactly this holding ack, sent twice to the
// same applicant; now the second one is the shorter touch, and always HITL.
describe('funnel never repeats a sent message', () => {
  it('a passed applicant who already received the holding ack gets the shorter second touch, held', async () => {
    const { s, tid } = await seedFirstTouch('vh.myshopify.com');
    await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'passed_to_form' });
    const first = buildHoldingAck('Kasim');
    await s.insertOutboundMessage({ threadId: tid, messageId: '<h1@activepaw>', from: 'contact@activepaw.co.uk', to: 'kasim@x.com', subject: 'Re: Partnership', bodyText: first, bodyHtml: '<p>x</p>', sentAt: '2026-06-23T10:00:00Z' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).not.toBe(first);
    expect(countWords(draft!.body_text)).toBeLessThan(countWords(first));
    expect(draft!.body_text).toMatch(/review/i);
    expect(JSON.parse(draft!.hold_reasons ?? '[]')).toContain('repeat_touch');
  });
});

// Owner rule 2026-09-04 (Paul's thread, pojoseph422): an invited applicant who
// answers the programme by insisting on a DIFFERENT arrangement is not a
// screened applicant checking in, so the holding note ("reviewing the fit") is
// the wrong reply. Introduced twice and still insisting: the friendly decline,
// applicant declined. Introduced once: the shorter invite follow-up (the
// earlier "tell them about the only programme" rule). Any other reply at that
// stage keeps the holding note.
describe('an invited applicant who insists on another form of collaboration', () => {
  const SIGNUP_CFG: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'signup_page' } };
  const REFUSAL = 'I\'m not looking to operate purely as a referral partner. What I had in mind is a more hands-on growth partnership, where I work alongside you to improve the customer journey and increase conversions, on a results-based collaboration.';

  async function seedInvited(shop: string, introductions: 1 | 2, reply: string) {
    const { s, tid } = await seedFirstTouch(shop);
    await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'passed_to_form' });
    if (introductions === 2) {
      await s.insertOutboundMessage({ threadId: tid, messageId: `<q1@${shop}>`, from: 'contact@activepaw.co.uk', to: 'kasim@x.com', subject: 'Re: Partnership', bodyText: buildQualifyingEmail('Kasim', 'voucher'), bodyHtml: '<p>x</p>', sentAt: '2026-06-23T10:00:00Z' });
      await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<a2@${shop}>`, inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Re: Partnership', bodyText: 'Here are my answers: a small dog page, no brand work yet.', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-24T10:00:00Z' });
    }
    await s.insertOutboundMessage({ threadId: tid, messageId: `<i1@${shop}>`, from: 'contact@activepaw.co.uk', to: 'kasim@x.com', subject: 'Re: Partnership', bodyText: buildSignupInvite('Kasim'), bodyHtml: '<p>x</p>', sentAt: '2026-06-25T10:00:00Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<a3@${shop}>`, inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Re: Partnership', bodyText: reply, bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-26T10:00:00Z' });
    return { s, tid };
  }

  it('introduced twice and still insisting: the friendly decline, held, applicant declined', async () => {
    const { s, tid } = await seedInvited('cd2.myshopify.com', 2, REFUSAL);
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, SIGNUP_CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/do not skip the trial for anyone/i);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).not.toMatch(/reviewing the fit|taking a look/i);
    expect(JSON.parse(draft!.hold_reasons ?? '[]')).toEqual([]);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
  });

  it('introduced once and insisting: the shorter invite follow-up, not the holding note; stage unchanged', async () => {
    const { s, tid } = await seedInvited('cd1.myshopify.com', 1, REFUSAL);
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, SIGNUP_CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toBe(buildSecondTouch('signup_invite', 'Kasim'));
    expect(draft!.body_text).not.toMatch(/reviewing the fit|taking a look/i);
    expect(JSON.parse(draft!.hold_reasons ?? '[]')).toContain('repeat_touch');
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('introduced twice, but a plain reply: the holding note as before, stage unchanged', async () => {
    const { s, tid } = await seedInvited('cd0.myshopify.com', 2, 'Thanks, I have submitted the application form.');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, SIGNUP_CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/reviewing|taking a look/i);
    expect(draft!.body_text).not.toMatch(/do not skip the trial for anyone/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });
});
