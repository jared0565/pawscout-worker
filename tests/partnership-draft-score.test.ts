/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { maybePartnershipDraft, buildQualifyingEmail } from '../src/inbox/partnership';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

// The scoring branch serves both funnel variants (2026-07-04): 'funnel_voucher'
// is the live default (screens for a discount-code trial); 'funnel_link' is the
// original link programme preserved verbatim. decline_all is pinned at the end
// as the config-driven toggle.

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

function llmReturning(content: string): typeof fetch {
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200 })) as unknown as typeof fetch;
}
const factsJson = (o: Record<string, unknown>) => JSON.stringify({
  channelUrls: ['https://tiktok.com/@dogmum'], disqualifier: 'none', audienceRelevance: 'pet_uk', acceptsTerms: 'yes',
  engagement: 'plausible', evidence: 'concrete', experience: 'some', method: 'content', specificity: 'specific', ...o });

async function seedAnswered(shop: string) {
  const s = new TenantStore(env.DB, shop);
  await s.upsertContact({ email: 'kasim@x.com', name: 'Kasim', phone: null });
  const tid = await s.createThread({ contactEmail: 'kasim@x.com', subject: 'Partnership', subjectNorm: 'partnership', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 60, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
  // original pitch (inbound)
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<a1@x>', inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'I run a dog IG, want to promote you for commission', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
  // we SENT the qualifying email (outbound) - the precondition for scoring their reply
  await s.insertOutboundMessage({ threadId: tid, messageId: '<screen@ap>', from: 'sales@activepaw.co.uk', to: 'kasim@x.com', subject: 'Re: Partnership', bodyText: buildQualifyingEmail('Kasim', 'link'), bodyHtml: '<p>questions</p>', sentAt: '2026-06-22T10:30:00Z' });
  // they replied with answers (inbound)
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<a2@x>', inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'answers: my tiktok @dogmum, 8k UK dog owners, honest review, fine with #ad', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T11:00:00Z' });
  await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'screen_sent' }); // already screened
  return { s, tid };
}

async function runFunnel(s: TenantStore, tid: string, fetchImpl: typeof fetch, mode: 'funnel_link' | 'funnel_voucher' = 'funnel_link') {
  const got = (await s.getThreadWithMessages(tid))!;
  return maybePartnershipDraft({ ...env, OPENROUTER_API_KEY: 'k' } as any, s, CFG, got.thread, got, fetchImpl, mode);
}

describe('partnership scoring branch (funnel_link mode, preserved programme)', () => {
  it('clear pass → form-invite draft, applicant passed_to_form', async () => {
    const { s, tid } = await seedAnswered('a.myshopify.com');
    const r = await runFunnel(s, tid, llmReturning(factsJson({})));
    expect(r!.send).toBe(false);
    expect((await s.getPendingDraft(tid))!.body_text).toMatch(/partner application/i);
    const app = await s.getApplicantByThread(tid);
    expect(app!.stage).toBe('passed_to_form');
    expect(app!.score).toBeGreaterThanOrEqual(8);
  });

  it('hard gate → respectful decline draft, applicant declined', async () => {
    const { s, tid } = await seedAnswered('b.myshopify.com');
    const r = await runFunnel(s, tid, llmReturning(factsJson({ channelUrls: [] })));
    expect((await s.getPendingDraft(tid))!.body_text).toMatch(/not a fit for our affiliate programme/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
    expect(r!.send).toBe(false);
  });

  it('extraction failure → escalate (holding ack), applicant escalated', async () => {
    const { s, tid } = await seedAnswered('c.myshopify.com');
    const r = await runFunnel(s, tid, llmReturning('not json'));
    expect((await s.getPendingDraft(tid))!.body_text).toMatch(/reviewing|taking a look/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('escalated');
    expect(r!.send).toBe(false);
  });

  // Premature-scoring race: applicant is at screen_sent but the qualifying email was
  // never actually sent (no outbound) - e.g. its pending draft was superseded by a
  // follow-up. Must RE-ISSUE the questions, NOT score the non-answer into a decline.
  it('re-issues the qualifying email (does NOT score/decline) when the screen was never sent', async () => {
    const s = new TenantStore(env.DB, 'race.myshopify.com');
    await s.upsertContact({ email: 'kasim@x.com', name: 'Kasim', phone: null });
    const tid = await s.createThread({ contactEmail: 'kasim@x.com', subject: 'Partnership', subjectNorm: 'partnership', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 60, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<race1@x>', inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'I can bring you tons of sales!', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:00:00Z' });
    await s.upsertApplicant({ threadId: tid, contactEmail: 'kasim@x.com', stage: 'screen_sent' }); // drafted, NOT sent
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<race2@x>', inReplyTo: null, references: [], from: 'kasim@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'are you there?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-22T10:05:00Z' });

    const r = await runFunnel(s, tid, llmReturning(factsJson({ channelUrls: [] })));
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i); // re-issued questions
    expect(draft!.body_text).not.toMatch(/not a fit for our affiliate programme/i); // NOT a decline
    expect((await s.getApplicantByThread(tid))!.stage).toBe('screen_sent'); // unchanged
  });
});

describe('partnership scoring branch (funnel_voucher mode, live default)', () => {
  it('clear pass → VOUCHER invite draft (trial code, not the partner application), owner alerted to Partners', async () => {
    const { s, tid } = await seedAnswered('va.myshopify.com');
    const r = await runFunnel(s, tid, llmReturning(factsJson({})), 'funnel_voucher');
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toContain('trial discount code');
    expect(draft!.body_text).not.toMatch(/partner application/i);
    const app = await s.getApplicantByThread(tid);
    expect(app!.stage).toBe('passed_to_form');
    expect(app!.score).toBeGreaterThanOrEqual(8);
  });

  it('a discount-code-led candidate passes under voucher weights where the link programme escalates', async () => {
    // relevance 2 + engagement 2 + evidence(vague) 1 + experience(none) 0 +
    // method(discount: link 0 / voucher 1) + specificity 2 = 7 vs 8.
    const borderline = { evidence: 'vague', experience: 'none', method: 'discount' };
    const linkCase = await seedAnswered('vb.myshopify.com');
    await runFunnel(linkCase.s, linkCase.tid, llmReturning(factsJson(borderline)), 'funnel_link');
    expect((await linkCase.s.getApplicantByThread(linkCase.tid))!.stage).toBe('escalated');

    const voucherCase = await seedAnswered('vc.myshopify.com');
    await runFunnel(voucherCase.s, voucherCase.tid, llmReturning(factsJson(borderline)), 'funnel_voucher');
    const app = await voucherCase.s.getApplicantByThread(voucherCase.tid);
    expect(app!.stage).toBe('passed_to_form');
    expect(app!.score).toBe(8);
  });

  it('coupon/deal sites stay a hard decline in voucher mode (the code is for THEIR audience)', async () => {
    const { s, tid } = await seedAnswered('vg.myshopify.com');
    await runFunnel(s, tid, llmReturning(factsJson({ disqualifier: 'coupon_cashback' })), 'funnel_voucher');
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
    expect((await s.getPendingDraft(tid))!.body_text).toMatch(/not a fit for our affiliate programme/i);
  });
});

// Accepted-partner support (2026-07-14): once we have GENUINELY accepted a
// partner (a live voucher exists), their further replies must get a context-aware
// acknowledgement, NOT the stale "reviewing the fit" holding ack. The carve-out
// keys on partnerPoolState === 'live', never on the stage, so an escalated or
// awaiting-issue applicant still gets the (accurate) holding ack.
describe('accepted-partner replies (live voucher) get a context-aware draft, not the holding ack', () => {
  async function seedAcceptedPartner(shop: string, opts: { withLiveVoucher: boolean; stage?: 'passed_to_form' | 'escalated' } = { withLiveVoucher: true }) {
    const s = new TenantStore(env.DB, shop);
    await s.upsertContact({ email: 'amjad@x.com', name: 'Amjad', phone: null });
    const tid = await s.createThread({ contactEmail: 'amjad@x.com', subject: 'Partnership', subjectNorm: 'partnership', receivedAt: '2026-07-13T07:00:00Z', initialStatus: 'needs_reply' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 60, summary: null, classifiedAt: '2026-07-13T07:00:01Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<p1@x>', inReplyTo: null, references: [], from: 'amjad@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'I run a dog IG and want to promote you', bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-13T07:00:00Z' });
    await s.insertOutboundMessage({ threadId: tid, messageId: '<q@ap>', from: 'sales@activepaw.co.uk', to: 'amjad@x.com', subject: 'Re: Partnership', bodyText: buildQualifyingEmail('Amjad', 'voucher'), bodyHtml: '<p>q</p>', sentAt: '2026-07-13T07:05:00Z' });
    // We already issued and sent the code (our outbound), and the partner replies with a thank-you.
    await s.insertOutboundMessage({ threadId: tid, messageId: '<code@ap>', from: 'sales@activepaw.co.uk', to: 'amjad@x.com', subject: 'Re: Partnership', bodyText: 'Great news - your trial is set up. Your code is ACTIVEPAW-AMJAD5.', bodyHtml: '<p>x</p>', sentAt: '2026-07-13T09:00:00Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<ty@x>', inReplyTo: null, references: [], from: 'amjad@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText: 'Thank you so much for the great news!', bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-13T10:00:00Z' });
    await s.upsertApplicant({ threadId: tid, contactEmail: 'amjad@x.com', stage: opts.stage ?? 'passed_to_form' });
    if (opts.withLiveVoucher) {
      const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'amjad@x.com', name: 'Amjad' });
      // Deferred code (starts_at in the future) - partnerPoolState still 'live' because it filters on ends_at.
      await s.createAffiliateVoucher({ partnerId, code: 'ACTIVEPAW-AMJAD5', pctOff: 5, commissionPct: 2, startsAt: '2099-07-19T00:00:00.000Z', endsAt: '2099-08-18T00:00:00.000Z' });
      expect(await s.partnerPoolState('amjad@x.com')).toBe('live');
    }
    return { s, tid };
  }

  const draftJson = JSON.stringify({ bodyText: 'You are very welcome, we are thrilled to have you on board and cannot wait to see how it goes.', confidence: 82, quotesPriceOrOrder: false });

  it('live partner + thank-you -> context-aware LLM draft (not the holding ack), send:false, model partner-support', async () => {
    const { s, tid } = await seedAcceptedPartner('acc.myshopify.com');
    const r = await runFunnel(s, tid, llmReturning(draftJson), 'funnel_voucher');
    expect(r!.send).toBe(false);
    const d = (await s.getPendingDraft(tid))!;
    expect(d.model).toBe('partner-support');
    expect(d.body_text).toMatch(/on board/i);            // the LLM's own words reached the draft
    expect(d.body_text).toMatch(/Active Paw Partnerships/); // partnership footer applied
    expect(d.body_text).not.toMatch(/reviewing the fit|taking a look/i); // NOT the stale holding ack
  });

  it('live partner + LLM failure -> neutral accepted-partner acknowledgement, still not the holding ack', async () => {
    const { s, tid } = await seedAcceptedPartner('accf.myshopify.com');
    await runFunnel(s, tid, llmReturning('not json'), 'funnel_voucher');
    const d = (await s.getPendingDraft(tid))!;
    expect(d.model).toBe('partner-support');
    expect(d.body_text).toMatch(/welcome to the Active Paw partner programme/i);
    expect(d.body_text).not.toMatch(/reviewing the fit|taking a look/i);
  });

  it('passed_to_form WITHOUT a live voucher (awaiting owner to issue) keeps the holding ack', async () => {
    const { s, tid } = await seedAcceptedPartner('await.myshopify.com', { withLiveVoucher: false });
    await runFunnel(s, tid, llmReturning(draftJson), 'funnel_voucher');
    const d = (await s.getPendingDraft(tid))!;
    expect(d.model).toBe('partnership-screen');
    expect(d.body_text).toMatch(/reviewing|taking a look/i);
  });

  it('escalated WITHOUT a live voucher keeps the holding ack (owner may still decline)', async () => {
    const { s, tid } = await seedAcceptedPartner('esc.myshopify.com', { withLiveVoucher: false, stage: 'escalated' });
    await runFunnel(s, tid, llmReturning(draftJson), 'funnel_voucher');
    const d = (await s.getPendingDraft(tid))!;
    expect(d.model).toBe('partnership-screen');
    expect(d.body_text).toMatch(/reviewing|taking a look/i);
  });
});

describe('decline_all toggle (config-driven) intercepts in-flight applicants too', () => {
  it('an answered screen under decline_all gets the decline, applicant declined', async () => {
    const { s, tid } = await seedAnswered('live.myshopify.com');
    const got = (await s.getThreadWithMessages(tid))!;
    // no override: the mode comes from cfg.inbox.affiliateMode
    const cfg: TenantConfig = { ...CFG, inbox: { ...DEFAULT_INBOX, affiliateMode: 'decline_all' } };
    const r = await maybePartnershipDraft({ ...env, OPENROUTER_API_KEY: 'k' } as any, s, cfg, got.thread, got, llmReturning(factsJson({})));
    expect(r!.send).toBe(false);
    expect((await s.getPendingDraft(tid))!.body_text).toMatch(/not a fit for our affiliate programme/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
  });
});
