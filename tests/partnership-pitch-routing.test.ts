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
  detectVolumePitch, detectServicePitch, detectOffPlatformRequest, buildQualifyingEmail, buildSignupInvite,
  maybePartnershipDraft, QUALIFYING_MARKER, AFFILIATE_APPLY_URL,
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

  it('detectServicePitch STAYS false on it - the wrong lane would hard-decline', () => {
    // Its `service` clause already matches "grow your store"; only `offer` holds
    // it back. If someone loosens `offer`, this pitch starts getting
    // SERVICE_DECLINE_BODY ("we keep development and marketing in-house"), which
    // is a hard decline in the wrong lane. This assertion is the tripwire.
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
    expect(draft!.body_text).toMatch(/do not agree commission rates against promised volume/i);
    expect(draft!.body_text).toMatch(/not able to use WhatsApp or Telegram/i);
    // Signed by the partnerships desk, not Customer Support.
    expect(draft!.body_text).toContain('Active Paw Partnerships');
    // The rate is ANSWERED without quoting a number - signup_page keeps every
    // figure on the application page as the single source of truth.
    expect(draft!.body_text).not.toMatch(/\b\d{1,2}%/);
    expect((await s.getApplicantByThread(tid))!.stage).toBe('passed_to_form');
  });

  it('buildSignupInvite adds nothing by default and anchors extras before the sign-off', () => {
    const plain = buildSignupInvite('Yusuf');
    expect(plain).not.toMatch(/promised volume/i);
    expect(plain).not.toMatch(/WhatsApp/i);

    const both = buildSignupInvite('Yusuf', { volumePitch: true, offPlatform: true });
    expect(both.indexOf('promised volume')).toBeLessThan(both.indexOf('We look forward'));
    expect(both.indexOf('WhatsApp')).toBeLessThan(both.indexOf('We look forward'));
    expect(both.trimEnd().endsWith('Active Paw Partnerships')).toBe(true);
    expect(both).toContain(AFFILIATE_APPLY_URL);
  });
});
