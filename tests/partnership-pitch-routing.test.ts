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
