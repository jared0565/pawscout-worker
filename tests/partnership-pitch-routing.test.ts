/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Pitch-pattern routing (owner-observed patterns, 2026-07-05):
 *  - commission-for-volume pitches get the SAME funnel plus the earned-tier
 *    terms (tiers earned through the attribution ledger, never negotiated
 *    against promises);
 *  - pure service pitches (site-speed/SEO/listing vendors) get the dedicated
 *    prove-first answer (owner rule 2026-09-17: the code trial is the filter,
 *    replacing the 2026-09-04 hard decline) - never the qualifying questions;
 *  - any creator signal stands the service detector down (when in doubt, the
 *    funnel; never a wrong decline - the standing grounded-reply rule).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  detectVolumePitch, detectServicePitch, detectOffPlatformRequest, buildQualifyingEmail, buildSignupInvite,
  maybePartnershipDraft, QUALIFYING_MARKER, AFFILIATE_APPLY_URL, PARTNERSHIP_STANCE, buildAcceptedPartnerAck, buildServiceProveFirst, buildAccessDecline,
  STANDARD_COMMISSION_PCT, TIER_REVIEW_ORDERS, TIER_MAX_PCT, detectRateAboveStandard
} from '../src/inbox/partnership';
import { otherAgent } from '../src/inbox/agents/other';
import { affiliateAgent } from '../src/inbox/agents/affiliate';
import { leadAgent } from '../src/inbox/agents/lead';
import { wholesaleAgent } from '../src/inbox/agents/wholesale';
// (the on-ramp tests below exercise maybePartnershipDraft with category 'other')
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };
const noFetch: typeof fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

async function seedFirstTouch(shop: string, bodyText: string) {
  const s = new TenantStore(env.DB, shop);
  await s.upsertContact({ email: 'p@x.com', name: 'Sam', phone: null });
  const tid = await s.createThread({ contactEmail: 'p@x.com', subject: 'Partnership', subjectNorm: 'partnership', receivedAt: '2026-07-05T10:00:00Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 60, summary: null, classifiedAt: '2026-07-05T10:00:01Z' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<p1@${shop}>`, inReplyTo: null, references: [], from: 'p@x.com', to: 'sales@activepaw.co.uk', subject: 'Partnership', bodyText, bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-05T10:00:00Z' });
  return { s, tid };
}

/** COLD first touch, the shape the Yusuf thread actually had (2026-08-02): the
 * pitch is the FIRST message, it arrives at contact@, the classifier calls it
 * 'other', and there is no prior outbound. Distinct from seedFirstTouch (which
 * uses sales@ + category 'affiliate', so isPartnershipLane alone routes it and a
 * detector regression would still pass) and from seedBaitOpener (which seeds an
 * earlier outbound). Only this shape proves the DETECTOR is what routes it. */
async function seedColdPitch(shop: string, bodyText: string) {
  const s = new TenantStore(env.DB, shop);
  await s.upsertContact({ email: 'p@x.com', name: 'Yusuf', phone: null });
  const tid = await s.createThread({ contactEmail: 'p@x.com', subject: 'Activepaw', subjectNorm: 'activepaw', receivedAt: '2026-08-02T09:53:06Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 0, summary: null, classifiedAt: '2026-08-02T09:54:00Z' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<c1@${shop}>`, inReplyTo: null, references: [], from: 'p@x.com', to: 'contact@activepaw.co.uk', subject: 'Activepaw', bodyText, bodyHtml: null, headersJson: '{}', receivedAt: '2026-08-02T09:53:06Z' });
  return { s, tid };
}

/** Bait-opener shape from the live threads (2026-07-05): innocent question at
 * contact@ classified 'other', our answer, then the real pitch in a follow-up. */
async function seedBaitOpener(shop: string, opener: string, pitch: string) {
  const s = new TenantStore(env.DB, shop);
  await s.upsertContact({ email: 'p@x.com', name: 'Sam', phone: null });
  const tid = await s.createThread({ contactEmail: 'p@x.com', subject: '', subjectNorm: '', receivedAt: '2026-07-04T10:00:00Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 20, summary: null, classifiedAt: '2026-07-04T10:00:01Z' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<o1@${shop}>`, inReplyTo: null, references: [], from: 'p@x.com', to: 'contact@activepaw.co.uk', subject: '', bodyText: opener, bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-04T10:00:00Z' });
  await s.insertOutboundMessage({ threadId: tid, messageId: `<r1@${shop}>`, from: 'contact@activepaw.co.uk', to: 'p@x.com', subject: '', bodyText: 'Hi Sam,\n\nYes, we ship there.\n\nBest Regards,\nActive Paw Customer Support', bodyHtml: '<p>Yes</p>', sentAt: '2026-07-04T11:00:00Z' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<o2@${shop}>`, inReplyTo: `<r1@${shop}>`, references: [], from: 'p@x.com', to: 'contact@activepaw.co.uk', subject: '', bodyText: pitch, bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-05T09:00:00Z' });
  return { s, tid };
}

// Condensed from the live pending threads (2026-07-05 realignment).
const OLATUNJI_PITCH = 'How are you doing? I have a strategy that can position your store to generate consistently 40 fulfilled orders and you only pay me 3% commissions.';
const AMJAD_PITCH = 'I would love the opportunity to demonstrate what I can bring to your store. If I can consistently generate 5-7 orders per day using my GSE marketing method, would you be willing to work with me long-term?';
const SALMAN_PITCH = 'I am reaching out as a freelancer because I see the vision behind what you are building. With my 3+ years experience in the e-commerce ecosystem, I know I can change the current trajectory of your brands revenue structure in under 3 months of consistent marketing and optimization. Let me know your availability for a meeting.';
const SAMLARRY_PITCH = 'Your store caught my attention because it can generate at least 25 sales per week. If I am able to consistently generate 15 sales per week for your store, would you be open to paying me a commission?';

// Owner rule 2026-09-17 (prove-first): the stance every drafting agent shares
// answers a service offer with the code trial instead of declining it, and
// thanks a goods supplier for the listing instead of declining them.
describe('partnership stance: prove-first', () => {
  it('answers a service offer with the code trial, never a decline, and thanks a goods supplier', () => {
    expect(PARTNERSHIP_STANCE).not.toMatch(/do not mention the affiliate programme/i);
    expect(PARTNERSHIP_STANCE).not.toMatch(/is declined/i);
    expect(PARTNERSHIP_STANCE).toContain('starts with their own affiliate discount code');
    expect(PARTNERSHIP_STANCE).toContain('GOODS SUPPLIERS');
    expect(PARTNERSHIP_STANCE).toContain('on file for reference');
    expect(PARTNERSHIP_STANCE).toContain('never granted');
  });

  // Fix round 1 (2026-09-27): warehousing, fulfilment and logistics suppliers
  // do not dropship goods themselves, so the dropshipping question is scoped
  // to goods and packaging suppliers only, matching src/inbox/agents/supplier.ts
  // and the reviser text in draft-quality.ts.
  it('scopes the dropshipping question to goods or packaging suppliers only', () => {
    expect(PARTNERSHIP_STANCE).toContain('for goods or packaging only');
  });
});

describe('detectVolumePitch', () => {
  it('fires on commission negotiated against promised volume', () => {
    expect(detectVolumePitch('We want 15% commission if we can sell 300 units monthly')).toBe(true);
    expect(detectVolumePitch('Give me 10% per sale and I will guarantee 50 sales a week')).toBe(true);
    expect(detectVolumePitch('Our team can move 1,000 pieces per month for a 12% revenue share')).toBe(true);
  });

  it('does NOT fire on ordinary creator pitches or plain commission questions', () => {
    expect(detectVolumePitch('I run a dog IG and would love to promote you for commission')).toBe(false);
    expect(detectVolumePitch('What commission do you offer?')).toBe(false);
    expect(detectVolumePitch('Does my 5% discount code still work?')).toBe(false);
    expect(detectVolumePitch('I would love to feature your products to my 40k followers')).toBe(false);
  });
});

describe('detectServicePitch', () => {
  it('fires on vendor offers: speed, SEO, listings, design', () => {
    expect(detectServicePitch('We can improve your site loading speed and Core Web Vitals')).toBe(true);
    expect(detectServicePitch('Our agency offers product listing services for Shopify stores')).toBe(true);
    expect(detectServicePitch('I am a freelance SEO specialist and I offer search engine optimization')).toBe(true);
    expect(detectServicePitch('Our team specializes in store redesign and web development')).toBe(true);
  });

  it('stands down on ANY creator signal, and never fires on customers or plain pitches', () => {
    expect(detectServicePitch('I review pet products on my blog and also know SEO')).toBe(false); // creator wins
    expect(detectServicePitch('I want to promote your products to my audience')).toBe(false);
    expect(detectServicePitch('Your product page is loading slowly on my phone')).toBe(false); // customer complaint
    expect(detectServicePitch('I run a dog IG, want to promote you for commission')).toBe(false);
  });
});

describe('detectOffPlatformRequest', () => {
  it('fires on a request to switch channel or take it to a call', () => {
    expect(detectOffPlatformRequest('Can we continue our conversation through WhatsApp?')).toBe(true); // the Adamray case
    expect(detectOffPlatformRequest("Let's move to Telegram")).toBe(true);
    expect(detectOffPlatformRequest('Kindly drop ur Whatsapp if u are interested')).toBe(true);
    expect(detectOffPlatformRequest('Reach me on Signal instead')).toBe(true);
    expect(detectOffPlatformRequest('Just WhatsApp me when you can')).toBe(true);
    expect(detectOffPlatformRequest('give me a call or text me on this number')).toBe(true);
  });

  it('does NOT fire on a bare mention alongside real content (substance must still be read)', () => {
    expect(detectOffPlatformRequest('My audience is mostly on WhatsApp and Instagram groups')).toBe(false);
    expect(detectOffPlatformRequest('I can help you grow on WhatsApp marketing')).toBe(false);
    expect(detectOffPlatformRequest('Here are my answers to your questions')).toBe(false);
    expect(detectOffPlatformRequest('Okay, sounds good')).toBe(false);
  });
});

describe('buildQualifyingEmail earned-tier terms', () => {
  it('appends the ladder (numbers from the exported constants) only when asked', () => {
    const withTiers = buildQualifyingEmail('Sam', 'voucher', { volumePitch: true });
    expect(withTiers).toContain(`${STANDARD_COMMISSION_PCT}% of the goods value`);
    expect(withTiers).toContain(`${TIER_REVIEW_ORDERS} tracked orders`);
    expect(withTiers).toContain(`up to ${TIER_MAX_PCT}%`);
    expect(withTiers).toContain('No rush'); // paragraph anchored BEFORE the sign-off, not appended blindly
    expect(withTiers).toMatch(/where would you promote/i); // the questions are still there

    const plain = buildQualifyingEmail('Sam', 'voucher');
    expect(plain).not.toContain('tracked orders');
    // The link variant carries the same ladder when asked (wording is variant-agnostic).
    expect(buildQualifyingEmail('Sam', 'link', { volumePitch: true })).toContain(`${TIER_REVIEW_ORDERS} tracked orders`);
  });
});

describe('maybePartnershipDraft pitch routing (live default funnel_voucher)', () => {
  it('volume pitch first touch -> qualifying email WITH the earned ladder, applicant screen_sent', async () => {
    const { s, tid } = await seedFirstTouch('vol.myshopify.com', 'We want 15% commission if we can sell 300 units monthly of your pet products.');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false); // qualifying emails are ALWAYS HITL
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect(draft!.body_text).toContain(`${TIER_REVIEW_ORDERS} tracked orders`);
    expect(draft!.body_text).toContain('do the negotiating');
    expect((await s.getApplicantByThread(tid))!.stage).toBe('screen_sent');
  });

  it('ordinary creator pitch -> qualifying email WITHOUT the ladder', async () => {
    const { s, tid } = await seedFirstTouch('crt.myshopify.com', 'I run a dog IG, want to promote you for commission');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect(draft!.body_text).not.toContain('tracked orders');
  });

  // Owner rule 2026-09-17: the service pitch is answered with the prove-first
  // filter (everyone starts with a tracked code), and the vendor is staged like
  // any invited applicant so their next reply rides the applicant ladder
  // (shorter reminder, then the friendly final decline) instead of falling to
  // the generic drafter as a declined thread.
  it('service pitch first touch -> prove-first answer (HITL), applicant passed_to_form, no qualifying questions', async () => {
    const { s, tid } = await seedFirstTouch('svc.myshopify.com', 'Our agency offers product listing services and can improve your site loading speed.');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false); // HITL
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/who can actually deliver/i);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).not.toMatch(/in-house|settled policy/i);
    expect(draft!.body_text).not.toMatch(/where would you promote/i);
    expect(draft!.body_text).not.toMatch(/not a fit for our affiliate programme/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('a service vendor replying after the decline falls through to the generic drafter', async () => {
    const { s, tid } = await seedFirstTouch('svr.myshopify.com', 'Our agency offers product listing services.');
    await s.upsertApplicant({ threadId: tid, contactEmail: 'p@x.com', stage: 'declined' });
    const got = (await s.getThreadWithMessages(tid))!;
    expect(await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch)).toBeNull();
  });

  it('creator who also mentions SEO gets the funnel, never the service decline', async () => {
    const { s, tid } = await seedFirstTouch('mix.myshopify.com', 'I have 20k followers on my pet blog and I also do SEO on the side. I want to promote your products.');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('screen_sent');
  });
});

// Owner rule 2026-09-17: after the prove-first answer the vendor is a
// passed_to_form applicant. A vendor who accepts the filter and asks how to
// proceed has NOT touched the form (partner pool state 'none'), so the holding
// ack ("we are reviewing the fit") would be false for them: the right reply is
// the shorter form reminder. Someone already queued for a code (form
// submitted, owner yet to issue) still gets the holding ack, which is accurate.
describe('prove-first follow-ups', () => {
  const SVC_PITCH = 'Our agency offers product listing services and can improve your site loading speed.';
  async function seedAfterProveFirst(shop: string, reply: string) {
    const { s, tid } = await seedFirstTouch(shop, SVC_PITCH);
    const got = (await s.getThreadWithMessages(tid))!;
    await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
    await s.insertOutboundMessage({ threadId: tid, messageId: `<pf1@${shop}>`, from: 'sales@activepaw.co.uk', to: 'p@x.com', subject: 'Re: Partnership', bodyText: buildServiceProveFirst('Sam'), bodyHtml: '<p>x</p>', sentAt: '2026-07-05T11:00:00Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<pf2@${shop}>`, inReplyTo: `<pf1@${shop}>`, references: [], from: 'p@x.com', to: 'sales@activepaw.co.uk', subject: 'Re: Partnership', bodyText: reply, bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-06T09:00:00Z' });
    return { s, tid };
  }

  it('a vendor who accepts the filter and asks how to proceed gets the shorter form reminder, not the holding ack', async () => {
    const { s, tid } = await seedAfterProveFirst('pf1.myshopify.com', 'Sounds fair. How do I get my discount code?');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).toMatch(/next step is the application form/i);
    expect(draft!.body_text).not.toMatch(/reviewing the fit|taking a look/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('a vendor who is already queued for a code still gets the holding ack', async () => {
    const { s, tid } = await seedAfterProveFirst('pf2.myshopify.com', 'I have applied through the page. Any update?');
    expect(await s.queueAffiliatePartner({ contactEmail: 'p@x.com', name: 'Sam' })).toBe('queued');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/reviewing the fit|taking a look/i);
    expect(draft!.body_text).not.toContain(AFFILIATE_APPLY_URL);
  });
});

// Owner follow-up 2026-09-17: "some of them need access to the admin/sub-admin
// account, which I will never approve." An access ask is answered on its own
// terms (never granted, trial needs none of it), never with the form reminder.
describe('access requests', () => {
  const SVC_PITCH = 'Our agency offers product listing services and can improve your site loading speed.';
  async function seedProveFirstSent(shop: string) {
    const { s, tid } = await seedFirstTouch(shop, SVC_PITCH);
    const got = (await s.getThreadWithMessages(tid))!;
    await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    await s.insertOutboundMessage({ threadId: tid, messageId: `<pf1@${shop}>`, from: 'sales@activepaw.co.uk', to: 'p@x.com', subject: 'Re: Partnership', bodyText: buildServiceProveFirst('Sam'), bodyHtml: '<p>x</p>', sentAt: '2026-07-05T11:00:00Z' });
    return { s, tid };
  }
  async function inbound(s: TenantStore, tid: string, shop: string, id: string, text: string, at: string) {
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<${id}@${shop}>`, inReplyTo: null, references: [], from: 'p@x.com', to: 'sales@activepaw.co.uk', subject: 'Re: Partnership', bodyText: text, bodyHtml: null, headersJson: '{}', receivedAt: at });
  }

  it('an in-flight applicant asking for collaborator access gets the access decline, stage unchanged', async () => {
    const shop = 'ac1.myshopify.com';
    const { s, tid } = await seedProveFirstSent(shop);
    await inbound(s, tid, shop, 'a1', 'Sure, but I need collaborator access to the store to make the changes.', '2026-07-06T09:00:00Z');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/do not give store, admin, collaborator or staff access/i);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).not.toMatch(/next step is the application form|reviewing the fit/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('a second access ask after the access decline lands on the friendly final decline', async () => {
    const shop = 'ac2.myshopify.com';
    const { s, tid } = await seedProveFirstSent(shop);
    await s.insertOutboundMessage({ threadId: tid, messageId: `<ad1@${shop}>`, from: 'sales@activepaw.co.uk', to: 'p@x.com', subject: 'Re: Partnership', bodyText: buildAccessDecline('Sam'), bodyHtml: '<p>x</p>', sentAt: '2026-07-06T11:00:00Z' });
    await inbound(s, tid, shop, 'a2', 'I still need admin access, otherwise I cannot start.', '2026-07-07T09:00:00Z');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/do not skip the trial for anyone/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
  });

  it('a first touch that only asks for access gets the access decline and is staged passed_to_form', async () => {
    const { s, tid } = await seedColdPitch('ac3.myshopify.com', 'Hi, please add me as a collaborator on your Shopify store so I can get started on the improvements we discussed.');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/do not give store, admin, collaborator or staff access/i);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('a first touch that pitches a service AND asks for access gets the prove-first answer, which carries the boundary', async () => {
    const { s, tid } = await seedFirstTouch('ac4.myshopify.com', 'Our agency offers SEO and store optimisation; just add me as a staff account and we can begin.');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/who can actually deliver/i);
    expect(draft!.body_text).toMatch(/do not give store, admin, collaborator or staff access/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('a customer locked out of their own account never enters the funnel', async () => {
    const { s, tid } = await seedBaitOpener('ac5.myshopify.com', 'Do you ship to the UK?', 'I cannot access my account to see my order, can you help?');
    const got = (await s.getThreadWithMessages(tid))!;
    expect(await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch)).toBeNull();
    expect(await s.getApplicantByThread(tid)).toBeNull();
  });
});

describe('live pitch shapes (condensed from the 2026-07-05 pending threads)', () => {
  it('detectVolumePitch catches the 3%-commission, pay-me-per-week, and marketing-method shapes', () => {
    expect(detectVolumePitch(OLATUNJI_PITCH)).toBe(true);   // percent + commission
    expect(detectVolumePitch(SAMLARRY_PITCH)).toBe(true);   // volume + paying me
    expect(detectVolumePitch(AMJAD_PITCH)).toBe(true);      // volume + marketing method
  });

  it('detectServicePitch catches the freelancer revenue-trajectory shape', () => {
    expect(detectServicePitch(SALMAN_PITCH)).toBe(true);
    expect(detectVolumePitch('Okay')).toBe(false);
    expect(detectServicePitch('Okay')).toBe(false);
  });
});

describe('pitch on-ramp (contact@ + category other, after a bait opener)', () => {
  it('a volume pitch in the follow-up pulls the thread into the funnel with the earned ladder', async () => {
    const { s, tid } = await seedBaitOpener('ola.myshopify.com', 'Do you ship to the UK?', OLATUNJI_PITCH);
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull(); // category 'other' + contact@ no longer hides the pitch
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect(draft!.body_text).toContain(`${TIER_REVIEW_ORDERS} tracked orders`);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('screen_sent');
  });

  it('a service pitch in the follow-up gets the prove-first answer and is staged passed_to_form', async () => {
    const { s, tid } = await seedBaitOpener('sal.myshopify.com', 'Can I speak with the owner of this brand?', SALMAN_PITCH);
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false); // HITL
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/who can actually deliver/i);
    expect(draft!.body_text).not.toMatch(/in-house/i);
    expect(draft!.body_text).not.toMatch(/where would you promote/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('a bare "Okay" after our decline does NOT re-open the thread (latest-text grounding)', async () => {
    // Samlarry shape: the pitch is DEEPER in the thread, we declined, they said Okay.
    const { s, tid } = await seedBaitOpener('sml.myshopify.com', SAMLARRY_PITCH, 'Okay');
    const got = (await s.getThreadWithMessages(tid))!;
    expect(await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch)).toBeNull();
    expect(await s.getApplicantByThread(tid)).toBeNull(); // never entered the funnel
  });

  it('an ordinary customer follow-up never trips the on-ramp', async () => {
    const { s, tid } = await seedBaitOpener('cus.myshopify.com', 'Do you ship to the UK?', 'Great, thanks! How long does delivery usually take?');
    const got = (await s.getThreadWithMessages(tid))!;
    expect(await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch)).toBeNull();
  });

  it('an existing applicant keeps the thread in the funnel even when classified other', async () => {
    const { s, tid } = await seedBaitOpener('app.myshopify.com', 'Do you ship to the UK?', 'Here are my answers to your questions.');
    await s.upsertApplicant({ threadId: tid, contactEmail: 'p@x.com', stage: 'passed_to_form' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull(); // holding ack, never the generic drafter
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/reviewing|taking a look/i);
  });

  it('an in-flight applicant asking to move to WhatsApp gets keep-to-email, not the holding ack', async () => {
    const { s, tid } = await seedBaitOpener('wamove.myshopify.com', 'Do you ship to the UK?', 'Can we continue our conversation through WhatsApp?');
    await s.upsertApplicant({ threadId: tid, contactEmail: 'p@x.com', stage: 'passed_to_form' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false); // HITL - the owner reviews before it goes out
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/keep all of our conversations here on email/i);
    expect(draft!.body_text).not.toMatch(/reviewing|taking a look/i); // NOT the content-blind holding ack
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form'); // neutral: not declined, not advanced
  });
});

// --- Ishola regression (2026-07-06): the live thread that exposed two gaps -
// Regenerate bypassing the funnel (fixed in routes.ts) and the premature-
// scoring guard counting ANY outbound as "questions asked". ---

const ISHOLA_PITCH = 'Hello. Thank you for confirming.\n\nIf I could help your business generate 20 additional orders within the next week, would you be open to a performance-based partnership where my compensation is just 3% of the additional revenue generated?\n\nIf that is something you would consider, I would be happy to explain exactly how the strategy works.';

describe('Ishola-shape pitch (bait opener answered, then a 3%-for-orders pitch)', () => {
  it('detectVolumePitch fires on the live text (percent + volume promise)', () => {
    expect(detectVolumePitch(ISHOLA_PITCH)).toBe(true);
  });

  it('the marker sentence is present in BOTH qualifying variants (the askedAlready probe depends on it)', () => {
    expect(buildQualifyingEmail('Sam', 'link')).toContain(QUALIFYING_MARKER);
    expect(buildQualifyingEmail('Sam', 'voucher')).toContain(QUALIFYING_MARKER);
  });

  it('on-ramps to the qualifying email with the earned ladder, despite the earlier ordinary reply', async () => {
    const { s, tid } = await seedBaitOpener('ish.myshopify.com', 'Am I in chat with Activepaw??', ISHOLA_PITCH);
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false);
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i);
    expect(draft!.body_text).toContain(`${TIER_REVIEW_ORDERS} tracked orders`);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('screen_sent');
  });

  it('re-running BEFORE the questions were sent re-issues them - the opener reply must not count as asked', async () => {
    const { s, tid } = await seedBaitOpener('ish2.myshopify.com', 'Am I in chat with Activepaw??', ISHOLA_PITCH);
    let got = (await s.getThreadWithMessages(tid))!;
    const first = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(first).not.toBeNull();
    // The qualifying draft is superseded (regenerate / a follow-up ingest) before
    // anyone approves it: the thread has an outbound (the opener answer) but the
    // questions were never actually sent.
    await s.setDraftStatus(first!.draftId, 'discarded');
    got = (await s.getThreadWithMessages(tid))!;
    const second = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(second).not.toBeNull();
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/where would you promote/i); // re-asked, NOT scored into a decline
  });
});

// --- Yusuf regression (2026-08-02, live thread e157259b) ---------------------
// A cold commission pitch at contact@ that NO detector caught, so it fell to the
// generic 'other' agent and got a three-line brush-off signed "Active Paw
// Customer Support" - wrong substance and the wrong desk. Scored 1/4 on the old
// detectVolumePitch (only the percentage): it promises no VOLUME and names no
// METHOD, because the whole offer IS the risk-free framing.
// Byte-exact from D1, including the U+00EB in "agrëe" (deliberate spam-filter
// evasion), the newline inside "no ads\nbudget" (ordinary email wrapping), and
// the trailing U+200E.
const YUSUF_PITCH =
  'Can we agrëe on 3% to grow your store with no upfront payment no ads\nbudget, can we discuss further on telegram or WhatsApp?\n‎';

describe('Yusuf-shape pitch (risk-free framing, no volume promise, cold at contact@)', () => {
  it('detectVolumePitch fires on the live text (percent + pay-on-results)', () => {
    expect(detectVolumePitch(YUSUF_PITCH)).toBe(true);
  });

  it('the pay-on-results signal survives an email line-wrap mid-phrase', () => {
    // "no ads\nbudget" is how it actually arrived; a literal-space regex misses it.
    expect(detectVolumePitch('We take 4% and there is no ads\nbudget needed')).toBe(true);
    expect(detectVolumePitch('Just 2% commission, no upfront\ncost at all')).toBe(true);
  });

  it('detectOffPlatformRequest fires on "discuss further on telegram"', () => {
    expect(detectOffPlatformRequest(YUSUF_PITCH)).toBe(true);
    expect(detectOffPlatformRequest('Can we discuss this on WhatsApp?')).toBe(true);
    expect(detectOffPlatformRequest('hit me up on Telegram')).toBe(true);
  });

  it('detectServicePitch STAYS false on it - the wrong lane would skip the answers this message needs', () => {
    // Its `service` clause already matches "grow your store"; only `offer` holds
    // it back. If someone loosens `offer`, this pitch starts getting
    // SERVICE_PROVE_FIRST_BODY, which never answers the rate counter-offer or
    // the channel-switch ask that the signup invite handles inline. This
    // assertion is the tripwire.
    expect(detectServicePitch(YUSUF_PITCH)).toBe(false);
  });

  it('pay-on-results does NOT fire on ordinary customer questions', () => {
    expect(detectVolumePitch('Do I only pay once, or is the 5% off applied each time?')).toBe(false);
    expect(detectVolumePitch('Is there no upfront payment for a return?')).toBe(false);
    expect(detectVolumePitch('Your 10% welcome code did not work')).toBe(false);
  });

  it('routes a COLD first touch into the funnel and answers BOTH asks (signup_page)', async () => {
    const { s, tid } = await seedColdPitch('yus.myshopify.com', YUSUF_PITCH);
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch, 'signup_page');
    expect(r).not.toBeNull();            // no longer falls through to the generic drafter
    expect(r!.send).toBe(false);         // HITL
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toContain(AFFILIATE_APPLY_URL);
    expect(draft!.body_text).toMatch(/we do not negotiate commission against promised orders or sales/i);
    expect(draft!.body_text).toMatch(/not able to use WhatsApp or Telegram/i);
    // Signed by the partnerships desk, not Customer Support.
    expect(draft!.body_text).toContain('Active Paw Partnerships');
    // 2026-08-07 REVERSAL: this line used to assert `not.toMatch(/\d{1,2}%/)`,
    // because signup_page kept every figure on the application page. The owner
    // ruled the rate must be communicated, so the invite now states it.
    expect(draft!.body_text).toContain(`${STANDARD_COMMISSION_PCT}%`);
    expect(draft!.body_text).toContain(`${TIER_MAX_PCT}%`);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('buildSignupInvite adds nothing by default and anchors extras before the sign-off', () => {
    const plain = buildSignupInvite('Yusuf');
    expect(plain).not.toMatch(/rate you suggested/i);
    expect(plain).not.toMatch(/WhatsApp/i);

    const both = buildSignupInvite('Yusuf', { rateAbove: true, offPlatform: true });
    expect(both.indexOf('rate you suggested')).toBeLessThan(both.indexOf('We look forward'));
    expect(both.indexOf('WhatsApp')).toBeLessThan(both.indexOf('We look forward'));
    expect(both.trimEnd().endsWith('Active Paw Partnerships')).toBe(true);
    expect(both).toContain(AFFILIATE_APPLY_URL);
  });
});

// --- Owner ruling 2026-09-29: "On the rate you suggested" goes out only when
// the sender names a percentage above our starting rate. The three live pitches
// below all got it on 2026-09-29, and the owner cut it by hand from the third:
// two asked for our own 2%, and Funsho named no rate at all. Verbatim except
// that an em dash is written as a hyphen and curly apostrophes as straight ones. ---
const KEHINDE_PITCH = "GreetingActivepaw could you give me 2% commission if I manage to bring in 30 to 35 orders in 2 days? what's the best Whatsapp number to discuss this?";
const AFOLEX_PITCH = 'If i bring 30k - 40k/USD in new revenue to your store in october,would you be Open to 2% commission? If yes! Kindly drop your Whatsapp';
const FUNSHO_PITCH = "I'm Funsho. I came across Activepaw and wanted to reach out with a commission-only partnership idea. There's no cost to get started - you only pay when results come in. Open to hearing how it could help your store grow? Activepaw, are you open to a collaboration where my payment is directly linked to the sales I help you generate? If yes, drop your WhatsApp number for better communication.";

describe('the rate paragraph answers only a rate above ours (owner 2026-09-29)', () => {
  it.each([['Kehinde', KEHINDE_PITCH], ['Afolex', AFOLEX_PITCH], ['Funsho', FUNSHO_PITCH]])(
    '%s gets the invite and the email-only answer, but no "rate you suggested"', async (who, pitch) => {
      const { s, tid } = await seedColdPitch(`${who.toLowerCase()}.myshopify.com`, pitch);
      const got = (await s.getThreadWithMessages(tid))!;
      await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch, 'signup_page');
      const body = (await s.getPendingDraft(tid))!.body_text;
      expect(body).toContain(AFFILIATE_APPLY_URL);
      expect(body).toMatch(/not able to use WhatsApp or Telegram/i);
      expect(body).not.toMatch(/rate you suggested/i);
    });

  it('a named rate at or below ours, or no rate at all, is not a counter-offer', () => {
    expect(STANDARD_COMMISSION_PCT).toBe(2); // the fixtures below are written against 2%
    expect(detectRateAboveStandard(KEHINDE_PITCH)).toBe(false);
    expect(detectRateAboveStandard(AFOLEX_PITCH)).toBe(false);
    expect(detectRateAboveStandard(FUNSHO_PITCH)).toBe(false);
  });

  it('a percentage that is not a commission is not a rate', () => {
    expect(detectRateAboveStandard('I will grow your sales by 30%, and I work commission-only.')).toBe(false);
    expect(detectRateAboveStandard('I can share a 20% discount code with my followers.')).toBe(false);
    expect(detectRateAboveStandard('I can increase your conversion rate by 25% with commission-only work.')).toBe(false);
  });

  it('a commission above ours is a counter-offer, however it is written', () => {
    expect(detectRateAboveStandard(YUSUF_PITCH)).toBe(true); // "agrëe on 3%", accent and all
    expect(detectRateAboveStandard('Can we agree 5%?')).toBe(true);
    expect(detectRateAboveStandard('In return, I would receive a 3% commission on every sale.')).toBe(true);
    expect(detectRateAboveStandard('my compensation is just 3% of the additional revenue generated')).toBe(true);
    expect(detectRateAboveStandard('I want 10% of every sale I bring.')).toBe(true);
    expect(detectRateAboveStandard('My rate is 8 percent per sale.')).toBe(true);
  });
});

// --- Owner ruling 2026-08-07: state the commission, and never imply we have no
// programme. Reverses the 2026-08-02 "answer the rate without quoting one"
// design after the owner reviewed the live inbox. ---

describe('the commission percentage is communicated, not withheld', () => {
  it('EVERY signup invite carries the actual figures, not just the page link', () => {
    const plain = buildSignupInvite('Sam');
    expect(plain).toContain(`${STANDARD_COMMISSION_PCT}%`);
    expect(plain).toContain(`${TIER_MAX_PCT}%`);
    expect(plain).toContain(`${TIER_REVIEW_ORDERS} tracked orders`);
    expect(plain).toContain(AFFILIATE_APPLY_URL);
  });

  it('says the affiliate programme is the ONLY partnership, rather than merely omitting others', () => {
    // "We are not taking partnerships" was being INFERRED from a reply that
    // simply failed to mention one.
    expect(buildSignupInvite('Sam')).toMatch(/only partnership we run/i);
  });

  it('PARTNERSHIP_STANCE states the figures and forbids negotiating them', () => {
    expect(PARTNERSHIP_STANCE).toContain(`${STANDARD_COMMISSION_PCT}%`);
    expect(PARTNERSHIP_STANCE).toContain(`${TIER_MAX_PCT}%`);
    expect(PARTNERSHIP_STANCE).toContain(AFFILIATE_APPLY_URL);
    expect(PARTNERSHIP_STANCE).toMatch(/only partnership/i);
    expect(PARTNERSHIP_STANCE).toMatch(/never negotiate/i);
    // The flow instruction the owner asked for.
    expect(PARTNERSHIP_STANCE).toMatch(/do not simply repeat the earlier decline/i);
  });

  it('is carried by every agent a partnership approach can actually land on', () => {
    // 9412f18d and 33fed54f were both 'other'; a97e308b was 'affiliate'; a trade
    // buyer asking about commission lands on wholesale-b2b because it is
    // excluded from PARTNERSHIP_CATEGORIES; brand-interest lands on lead.
    for (const a of [otherAgent, affiliateAgent, leadAgent, wholesaleAgent]) {
      expect(a.promptFragment({} as any)).toContain(PARTNERSHIP_STANCE);
    }
  });

  it('the affiliate agent no longer forbids stating a rate', () => {
    // The exact instruction that produced "we do not have a percentage offer".
    expect(affiliateAgent.promptFragment({} as any)).not.toMatch(/never commit in email to any commission rate/i);
  });

  it('does NOT leak the standard rate into the ACCEPTED-partner path', () => {
    // An already-approved partner may sit on bespoke terms: issueVoucher takes a
    // commissionPct and draftAcceptedPartnerReply grounds on that voucher's own
    // commission_pct. Telling them they earn the standard rate would be wrong
    // for them specifically, so partnerSupportAgent deliberately does not carry
    // PARTNERSHIP_STANCE. This pins the LLM-failure fallback, which is the part
    // reachable without a live model.
    expect(buildAcceptedPartnerAck('Sam')).not.toMatch(/\b\d{1,2}%/);
    expect(buildAcceptedPartnerAck('Sam')).not.toContain(AFFILIATE_APPLY_URL);
  });
});

describe('detectVolumePitch on the 2026-08-06 live shapes', () => {
  // "If I bring extra orders to Activepaw store this month, what percentage
  // would you offer?" - drew "We do not have a percentage offer available".
  const SANKO = 'If I bring extra orders to Activepaw store this month, what percentage would you offer?';
  // "If I firstly pull in 13 orders this week ... No service fee upfront ...
  // What's the best WhatsApp number to reach you on?"
  const ALI = 'If I firstly pull in 13 orders this week, approximately 2 orders daily for a start. No service fee upfront. Until 13 Orders are achieved.';

  it('catches the unnumbered volume promise paired with a bare percentage ask', () => {
    expect(detectVolumePitch(SANKO)).toBe(true);
  });

  it('catches "pull in 13 orders" and the trailing-upfront fee wording', () => {
    expect(detectVolumePitch(ALI)).toBe(true);
  });

  it('still does NOT fire on the pre-existing negatives (commissionTopic must not double-count)', () => {
    // A bare commission question belongs in the normal funnel. Merging the two
    // money signals is what keeps this at 1.
    expect(detectVolumePitch('What commission do you offer?')).toBe(false);
    expect(detectVolumePitch('Does my 5% discount code still work?')).toBe(false);
    expect(detectVolumePitch('I run a dog IG and would love to promote you for commission')).toBe(false);
    expect(detectVolumePitch('I would love to feature your products to my 40k followers')).toBe(false);
    // Ordinary customer phrasing that brushes the new unnumbered-volume clause.
    expect(detectVolumePitch('Can I add more items to my order before it ships?')).toBe(false);
  });

  it('detectOffPlatformRequest catches a channel named BEFORE the verb', () => {
    expect(detectOffPlatformRequest("What's the best WhatsApp number to reach you on?")).toBe(true);
    expect(detectOffPlatformRequest('My audience is mostly on WhatsApp and Instagram groups')).toBe(false);
  });
});

// Rose thread (2026-09-05/06): a sender with a pasted product link asked whether
// items arrive as shown, then bumped the thread. The classifier called the bump
// 'affiliate' ("still open to recommending your store") and the category ALONE
// opened the funnel, which drafted the full signup invite to someone who never
// asked to partner. The owner's rule: every reply is grounded in what the
// sender wrote, and a category is a guess, not a request. The funnel now needs
// the sender's own words to ask for a partnership before it sends its canned
// first touch; otherwise the thread goes to the grounded drafter untouched.
describe('classifier category alone does not open the funnel', () => {
  const ROSE_1 = 'https://activepaw.co.uk/products/portable-dog-water-bowl-bottle-attachment\n\nI came across your store and I am considering recommending it to a few people who are looking for products in this category. Before I do, I wanted to ask do the products normally arrive exactly as shown and described on the website?';
  const ROSE_2 = 'just checking back in. I think our conversation got a little buried. I am still open to recommending your store, but I wanted to make sure I can reach you directly if anyone has questions before ordering. Whenever you get a chance, I would love to hear back from you';

  async function seedRose(shop: string) {
    const s = new TenantStore(env.DB, shop);
    await s.upsertContact({ email: 'rose@x.com', name: 'Rose', phone: null });
    const tid = await s.createThread({ contactEmail: 'rose@x.com', subject: 'Quick question', subjectNorm: 'quick question', receivedAt: '2026-09-05T14:44:00Z', initialStatus: 'needs_reply' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<rose1@${shop}>`, inReplyTo: null, references: [], from: 'rose@x.com', to: 'contact@activepaw.co.uk', subject: 'Quick question', bodyText: ROSE_1, bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-05T14:44:00Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<rose2@${shop}>`, inReplyTo: `<rose1@${shop}>`, references: [], from: 'rose@x.com', to: 'contact@activepaw.co.uk', subject: 'Re: Quick question', bodyText: ROSE_2, bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-06T04:07:00Z' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 20, summary: null, classifiedAt: '2026-09-06T04:15:00Z' });
    return { s, tid };
  }

  it("an 'affiliate'-classified thread whose messages never ask to partner stays out of the funnel and gets no applicant row", async () => {
    const { s, tid } = await seedRose('rose-a.myshopify.com');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, { ...CFG, inbox: { ...CFG.inbox, affiliateMode: 'signup_page' } }, got.thread, got, noFetch);
    expect(r).toBeNull();
    expect(await s.getApplicantByThread(tid)).toBeNull();
    expect(await s.getPendingDraft(tid)).toBeNull();
  });

  it("the same category WITH a real ask in the message still gets the first touch", async () => {
    const s = new TenantStore(env.DB, 'rose-b.myshopify.com');
    await s.upsertContact({ email: 'cre@x.com', name: 'Cree', phone: null });
    const tid = await s.createThread({ contactEmail: 'cre@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-09-05T14:44:00Z', initialStatus: 'needs_reply' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<cre1@b>', inReplyTo: null, references: [], from: 'cre@x.com', to: 'contact@activepaw.co.uk', subject: 'Hi', bodyText: 'I run a dog account with 40k followers. Do you have an affiliate programme I could join?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-05T14:44:00Z' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 20, summary: null, classifiedAt: '2026-09-05T14:45:00Z' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, { ...CFG, inbox: { ...CFG.inbox, affiliateMode: 'signup_page' } }, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    const d = await s.getDraft(r!.draftId);
    expect(d?.body_text).toContain(AFFILIATE_APPLY_URL);
    expect((await s.getApplicantByThread(tid))?.stage).toBe('passed_to_form');
  });
});

// aramid llm-review 2026-09-06 (finding ab7ce5d8): the lane gate read every
// inbound message on the thread, so an ask we had ALREADY answered kept the
// thread in the funnel and a later, unrelated follow-up got the signup invite.
// Only what the sender has written since our last reply drives the gate now
// (the same rule the drafter uses); a thread with an applicant row stays in
// the funnel through its own check, as before.
describe('an already-answered partnership ask does not keep the funnel open', () => {
  it("affiliate category, ask before our reply, unrelated follow-up after it: no first touch, no applicant row", async () => {
    const s = new TenantStore(env.DB, 'answered.myshopify.com');
    await s.upsertContact({ email: 'cre@x.com', name: 'Cree', phone: null });
    const tid = await s.createThread({ contactEmail: 'cre@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-09-05T10:00:00Z', initialStatus: 'needs_reply' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<ans1@x>', inReplyTo: null, references: [], from: 'cre@x.com', to: 'contact@activepaw.co.uk', subject: 'Hi', bodyText: 'Do you have an affiliate programme I could join?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-05T10:00:00Z' });
    await s.insertOutboundMessage({ threadId: tid, messageId: '<ans-r1@x>', from: 'contact@activepaw.co.uk', to: 'cre@x.com', subject: 'Re: Hi', bodyText: 'Hi Cree,\n\nYes, the programme is open to anyone; the application is on our website.\n\nBest Regards,\nActive Paw Partnerships', bodyHtml: '<p>Yes</p>', sentAt: '2026-09-05T11:00:00Z' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<ans2@x>', inReplyTo: '<ans-r1@x>', references: [], from: 'cre@x.com', to: 'contact@activepaw.co.uk', subject: 'Re: Hi', bodyText: 'Thanks. Separate question: how long does delivery to Spain take?', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-06T09:00:00Z' });
    await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 20, summary: null, classifiedAt: '2026-09-06T09:01:00Z' });
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, { ...CFG, inbox: { ...CFG.inbox, affiliateMode: 'signup_page' } }, got.thread, got, noFetch);
    expect(r).toBeNull();
    expect(await s.getApplicantByThread(tid)).toBeNull();
  });
});
