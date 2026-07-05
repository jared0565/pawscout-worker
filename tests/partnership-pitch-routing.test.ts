/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Pitch-pattern routing (owner-observed patterns, 2026-07-05):
 *  - commission-for-volume pitches get the SAME funnel plus the earned-tier
 *    terms (tiers earned through the attribution ledger, never negotiated
 *    against promises);
 *  - pure service pitches (site-speed/SEO/listing vendors) get a dedicated,
 *    polite, final decline - never the affiliate qualifying questions;
 *  - any creator signal stands the service detector down (when in doubt, the
 *    funnel; never a wrong decline - the standing grounded-reply rule).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  detectVolumePitch, detectServicePitch, buildQualifyingEmail, maybePartnershipDraft,
  STANDARD_COMMISSION_PCT, TIER_REVIEW_ORDERS, TIER_MAX_PCT
} from '../src/inbox/partnership';
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

/** Bait-opener shape from the live threads (2026-07-05): innocent question at
 * contact@ classified 'other', our answer, then the real pitch in a follow-up. */
async function seedBaitOpener(shop: string, opener: string, pitch: string) {
  const s = new TenantStore(env.DB, shop);
  await s.upsertContact({ email: 'p@x.com', name: 'Sam', phone: null });
  const tid = await s.createThread({ contactEmail: 'p@x.com', subject: '', subjectNorm: '', receivedAt: '2026-07-04T10:00:00Z', initialStatus: 'needs_reply' });
  await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'other', intentScore: 20, summary: null, classifiedAt: '2026-07-04T10:00:01Z' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<o1@${shop}>`, inReplyTo: null, references: [], from: 'p@x.com', to: 'contact@activepaw.co.uk', subject: '', bodyText: opener, bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-04T10:00:00Z' });
  await s.insertOutboundMessage({ threadId: tid, messageId: `<r1@${shop}>`, from: 'contact@activepaw.co.uk', to: 'p@x.com', subject: '', bodyText: 'Hi Sam,\n\nYes, we ship there.\n\nBest Regards,\nActive Paw Customer Service', bodyHtml: '<p>Yes</p>', sentAt: '2026-07-04T11:00:00Z' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<o2@${shop}>`, inReplyTo: `<r1@${shop}>`, references: [], from: 'p@x.com', to: 'contact@activepaw.co.uk', subject: '', bodyText: pitch, bodyHtml: null, headersJson: '{}', receivedAt: '2026-07-05T09:00:00Z' });
  return { s, tid };
}

// Condensed from the live pending threads (2026-07-05 realignment).
const OLATUNJI_PITCH = 'How are you doing? I have a strategy that can position your store to generate consistently 40 fulfilled orders and you only pay me 3% commissions.';
const AMJAD_PITCH = 'I would love the opportunity to demonstrate what I can bring to your store. If I can consistently generate 5-7 orders per day using my GSE marketing method, would you be willing to work with me long-term?';
const SALMAN_PITCH = 'I am reaching out as a freelancer because I see the vision behind what you are building. With my 3+ years experience in the e-commerce ecosystem, I know I can change the current trajectory of your brands revenue structure in under 3 months of consistent marketing and optimization. Let me know your availability for a meeting.';
const SAMLARRY_PITCH = 'Your store caught my attention because it can generate at least 25 sales per week. If I am able to consistently generate 15 sales per week for your store, would you be open to paying me a commission?';

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

describe('buildQualifyingEmail earned-tier terms', () => {
  it('appends the ladder (numbers from the exported constants) only when asked', () => {
    const withTiers = buildQualifyingEmail('Sam', 'voucher', { volumePitch: true });
    expect(withTiers).toContain(`${STANDARD_COMMISSION_PCT}% of the face value`);
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

  it('service pitch first touch -> dedicated decline (HITL), applicant declined, no qualifying questions', async () => {
    const { s, tid } = await seedFirstTouch('svc.myshopify.com', 'Our agency offers product listing services and can improve your site loading speed.');
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false); // new template: HITL until owner validates it live
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/in-house/i);
    expect(draft!.body_text).not.toMatch(/where would you promote/i);
    expect(draft!.body_text).not.toMatch(/not taking on new partnerships/i); // the service decline is its own wording
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
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

  it('a service pitch in the follow-up gets the dedicated decline', async () => {
    const { s, tid } = await seedBaitOpener('sal.myshopify.com', 'Can I speak with the owner of this brand?', SALMAN_PITCH);
    const got = (await s.getThreadWithMessages(tid))!;
    const r = await maybePartnershipDraft({ ...env } as any, s, CFG, got.thread, got, noFetch);
    expect(r).not.toBeNull();
    expect(r!.send).toBe(false); // HITL
    const draft = await s.getPendingDraft(tid);
    expect(draft!.body_text).toMatch(/in-house/i);
    expect(draft!.body_text).not.toMatch(/where would you promote/i);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('declined');
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
});
