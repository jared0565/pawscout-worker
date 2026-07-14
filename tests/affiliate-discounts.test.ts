import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  resolveVoucherWindow, genVoucherCode, createVoucherDiscount, issueVoucher,
  fetchActiveOrderPromos, voucherDateLabel, TRIAL_DAYS_DEFAULT, type PromoWindow
} from '../src/affiliate-discounts';
import { scoreScreen, buildVoucherInviteWithCode } from '../src/inbox/partnership';
import { TenantStore } from '../src/tenant-store';
import type { ScreenFacts } from '../src/inbox/types';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const NOW = Date.parse('2026-07-05T12:00:00Z');
const DAY = 86_400_000;
const promo = (over: Partial<PromoWindow> = {}): PromoWindow => ({
  title: 'Welcome 10%', kind: 'Basic', source: 'automatic', percentage: 10, status: 'ACTIVE',
  startsAt: new Date(NOW - 10 * DAY).toISOString(), endsAt: new Date(NOW + 2 * DAY).toISOString(), code: null, ...over
});

describe('resolveVoucherWindow (event-aware timing)', () => {
  it('no promotions: starts now, runs the default trial length', () => {
    const w = resolveVoucherWindow([], { now: NOW });
    expect(w.ok && Date.parse(w.startsAt)).toBe(NOW);
    expect(w.ok && Date.parse(w.endsAt)).toBe(NOW + TRIAL_DAYS_DEFAULT * DAY);
    expect(w.ok && w.deferredBehind).toBeNull();
  });
  it('a running storewide event defers the code until just after it ends', () => {
    const w = resolveVoucherWindow([promo()], { now: NOW });
    expect(w.ok && Date.parse(w.startsAt)).toBe(NOW + 2 * DAY + 5 * 60_000);
    expect(w.ok && w.deferredBehind).toBe('Welcome 10%');
  });
  it('chained events push the start past the LAST one (fixed point)', () => {
    const later = promo({ title: 'Summer event', status: 'SCHEDULED', startsAt: new Date(NOW + 2 * DAY).toISOString(), endsAt: new Date(NOW + 9 * DAY).toISOString() });
    const w = resolveVoucherWindow([promo(), later], { now: NOW });
    expect(w.ok && w.deferredBehind).toBe('Summer event');
    expect(w.ok && Date.parse(w.startsAt)).toBe(NOW + 9 * DAY + 5 * 60_000);
  });
  it('an open-ended running event BLOCKS scheduling (owner decides, never a guess)', () => {
    const w = resolveVoucherWindow([promo({ endsAt: null })], { now: NOW });
    expect(w.ok).toBe(false);
    expect(!w.ok && w.blockedBy).toBe('Welcome 10%');
  });
  it('a far-future scheduled event outside the trial window does not defer', () => {
    const far = promo({ status: 'SCHEDULED', startsAt: new Date(NOW + 40 * DAY).toISOString(), endsAt: new Date(NOW + 45 * DAY).toISOString() });
    const w = resolveVoucherWindow([far], { now: NOW });
    expect(w.ok && Date.parse(w.startsAt)).toBe(NOW);
    expect(w.ok && w.deferredBehind).toBeNull();
  });
  // The 2026-07-05 live gap: WELCOME10 is a CODE discount, not an automatic one,
  // and it must defer a smaller partner code exactly like an automatic event.
  it('a bigger CODE event (WELCOME10 shape) defers a smaller voucher', () => {
    const w = resolveVoucherWindow([promo({ source: 'code', percentage: 10 })], { now: NOW, pctOff: 5 });
    expect(w.ok && w.deferredBehind).toBe('Welcome 10%');
  });
  it('an equal-or-smaller code promo does NOT defer (the voucher stays meaningful)', () => {
    expect(resolveVoucherWindow([promo({ source: 'code', percentage: 5 })], { now: NOW, pctOff: 5 })).toMatchObject({ deferredBehind: null });
    expect(resolveVoucherWindow([promo({ source: 'code', percentage: 3 })], { now: NOW, pctOff: 5 })).toMatchObject({ deferredBehind: null });
  });
  it('a fixed-amount/unknown-value code promo defers conservatively; automatics always defer', () => {
    expect(resolveVoucherWindow([promo({ source: 'code', percentage: null })], { now: NOW, pctOff: 5 })).toMatchObject({ deferredBehind: 'Welcome 10%' });
    expect(resolveVoucherWindow([promo({ source: 'automatic', percentage: 3 })], { now: NOW, pctOff: 5 })).toMatchObject({ deferredBehind: 'Welcome 10%' });
  });
});

describe('genVoucherCode', () => {
  it('builds ACTIVEPAW-<NAME><PCT> from the name, falling back to the email local part', () => {
    expect(genVoucherCode('Sam Larry!', 'x@y.com', 5)).toBe('ACTIVEPAW-SAMLARRY5');
    expect(genVoucherCode(null, 'olatunji@gmail.com', 5)).toBe('ACTIVEPAW-OLATUNJI5');
    expect(genVoucherCode('Sam', 'x@y.com', 5, '42')).toBe('ACTIVEPAW-SAM542');
  });
});

function fakeAdmin(opts: {
  promos?: PromoWindow[];
  createErrors?: string[][];       // userErrors message lists per create call (empty array = success)
  captured?: Record<string, unknown>[];
  throwOn?: RegExp;                // throw this on matching query (scope-denied simulation)
}): AdminGraphql {
  let createCall = 0;
  return (async (q: string, vars?: Record<string, unknown>) => {
    if (opts.throwOn?.test(q)) throw new Error('GraphQL error: ACCESS_DENIED - required access: write_discounts');
    if (q.includes('pawscoutActivePromos')) {
      const raw = (p: PromoWindow, prefix: string) => ({
        __typename: `${prefix}${p.kind}`, title: p.title, status: p.status, startsAt: p.startsAt, endsAt: p.endsAt,
        customerGets: p.percentage === null ? null : { value: { __typename: 'DiscountPercentage', percentage: p.percentage / 100 } }
      });
      const all = opts.promos ?? [];
      return {
        automaticDiscountNodes: { nodes: all.filter((p) => p.source === 'automatic').map((p) => ({ automaticDiscount: raw(p, 'DiscountAutomatic') })) },
        codeDiscountNodes: { nodes: all.filter((p) => p.source === 'code').map((p) => ({ codeDiscount: raw(p, 'DiscountCode') })) }
      };
    }
    if (q.includes('pawscoutVoucherCreate')) {
      opts.captured?.push(vars?.basicCodeDiscount as Record<string, unknown>);
      const errs = opts.createErrors?.[createCall++] ?? [];
      if (errs.length) return { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: errs.map((m) => ({ message: m })) } };
      return { discountCodeBasicCreate: { codeDiscountNode: { id: `gid://shopify/DiscountCodeNode/${createCall}` }, userErrors: [] } };
    }
    return {};
  }) as unknown as AdminGraphql;
}

describe('createVoucherDiscount', () => {
  it('creates a safely-bounded code: once per customer, combines with nothing, capped, dated', async () => {
    const captured: Record<string, unknown>[] = [];
    const r = await createVoucherDiscount(fakeAdmin({ captured }), {
      code: 'ACTIVEPAW-SAM5', pctOff: 5, startsAt: new Date(NOW).toISOString(), endsAt: new Date(NOW + 30 * DAY).toISOString(), usageLimit: 100
    });
    expect(r.ok).toBe(true);
    const input = captured[0] as { customerGets: { value: { percentage: number } }; appliesOncePerCustomer: boolean; combinesWith: Record<string, boolean>; usageLimit: number };
    expect(input.customerGets.value.percentage).toBe(0.05);
    expect(input.appliesOncePerCustomer).toBe(true);
    expect(input.combinesWith).toEqual({ orderDiscounts: false, productDiscounts: false, shippingDiscounts: false });
    expect(input.usageLimit).toBe(100);
  });
  it('surfaces a missing write_discounts grant as reconnectRequired', async () => {
    const r = await createVoucherDiscount(fakeAdmin({ throwOn: /pawscoutVoucherCreate/ }), {
      code: 'X', pctOff: 5, startsAt: new Date(NOW).toISOString(), endsAt: new Date(NOW + DAY).toISOString(), usageLimit: 100
    });
    expect(!r.ok && r.reconnectRequired).toBe(true);
  });
});

describe('issueVoucher (the one-move issue)', () => {
  it('defers behind a running event, mints the code, and registers the ledger row', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await issueVoucher(store, fakeAdmin({ promos: [promo()] }), {
      email: 'sam@x.com', name: 'Sam', pctOff: 5, commissionPct: 2, now: NOW
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toBe('ACTIVEPAW-SAM5');
    expect(r.deferredBehind).toBe('Welcome 10%');
    const rows = await store.listAffiliateVouchers();
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('ACTIVEPAW-SAM5');
    expect(Date.parse(rows[0].starts_at)).toBe(NOW + 2 * DAY + 5 * 60_000); // scheduled after the event
    expect(rows[0].contact_email).toBe('sam@x.com');
  });
  it('retries a code collision once with a salted code', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const captured: Record<string, unknown>[] = [];
    const r = await issueVoucher(store, fakeAdmin({ captured, createErrors: [['Code is already taken'], []] }), {
      email: 'sam@x.com', name: 'Sam', pctOff: 5, commissionPct: 2, now: NOW
    });
    expect(r.ok).toBe(true);
    expect(captured).toHaveLength(2);
    expect((captured[1] as { code: string }).code).not.toBe((captured[0] as { code: string }).code);
  });
  it('refuses to schedule around an open-ended promotion', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await issueVoucher(store, fakeAdmin({ promos: [promo({ endsAt: null })] }), {
      email: 'sam@x.com', pctOff: 5, commissionPct: 2, now: NOW
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('no end date');
    expect(await store.listAffiliateVouchers()).toHaveLength(0); // nothing minted, nothing registered
  });
});

describe('fetchActiveOrderPromos', () => {
  it('keeps ACTIVE and SCHEDULED order promos from BOTH sources, ignores everything else', async () => {
    const r = await fetchActiveOrderPromos(fakeAdmin({ promos: [
      promo(),
      promo({ title: 'WELCOME10 event', source: 'code', percentage: 10 }),
      promo({ title: 'Old', status: 'EXPIRED' })
    ] }));
    expect(r.ok && r.promos.map((p) => p.title).sort()).toEqual(['WELCOME10 event', 'Welcome 10%']);
    expect(r.ok && r.promos.find((p) => p.title === 'WELCOME10 event')?.percentage).toBe(10);
  });
  it('our own minted trials (Partner trial titles) are never conflicts', async () => {
    const r = await fetchActiveOrderPromos(fakeAdmin({ promos: [promo({ title: 'Partner trial ACTIVEPAW-SAM5', source: 'code', percentage: 5 })] }));
    expect(r.ok && r.promos).toEqual([]);
  });
  it('reports a scope denial as reconnectRequired', async () => {
    const r = await fetchActiveOrderPromos(fakeAdmin({ throwOn: /pawscoutActivePromos/ }));
    expect(!r.ok && r.reconnectRequired).toBe(true);
  });
});

// --- Trial-entry screening (owner policy 2026-07-05): the tracked trial is the
// test, so in the voucher variant only ABUSE gates decline. ---
describe('scoreScreen trial-entry mode (voucher variant)', () => {
  const facts = (over: Partial<ScreenFacts> = {}): ScreenFacts => ({
    channelUrls: ['https://instagram.com/x'], disqualifier: 'none', audienceRelevance: 'partial',
    acceptsTerms: 'unclear', engagement: 'unclear', evidence: 'vague', experience: 'some',
    method: 'unknown', specificity: 'partial', ...over
  });
  it('no channel passes to the trial (G1 no longer declines) - the Samlarry shape', () => {
    const v = scoreScreen(facts({ channelUrls: [] }), { variant: 'voucher' });
    expect(v.decision).toBe('form');
    expect(v.reasons[0]).toContain('Trial entry');
  });
  it('off-audience and low scores also pass to the trial', () => {
    expect(scoreScreen(facts({ audienceRelevance: 'off' }), { variant: 'voucher' }).decision).toBe('form');
    expect(scoreScreen(facts({ evidence: 'none', experience: 'none', specificity: 'vague', engagement: 'implausible' }), { variant: 'voucher' }).decision).toBe('form');
  });
  it('abuse gates still decline: coupon sites, brand bidding, refused terms, prohibited tactics', () => {
    expect(scoreScreen(facts({ disqualifier: 'coupon_cashback' }), { variant: 'voucher' }).gate).toBe('G2');
    expect(scoreScreen(facts({ disqualifier: 'brand_bidding' }), { variant: 'voucher' }).gate).toBe('G2');
    expect(scoreScreen(facts({ acceptsTerms: 'no' }), { variant: 'voucher' }).gate).toBe('G4');
    expect(scoreScreen(facts({ disqualifier: 'prohibited_tactics' }), { variant: 'voucher' }).gate).toBe('G5');
  });
  it('the LINK variant keeps the full original gates (G1/G3 decline)', () => {
    expect(scoreScreen(facts({ channelUrls: [] }), { variant: 'link' }).gate).toBe('G1');
    expect(scoreScreen(facts({ audienceRelevance: 'off' }), { variant: 'link' }).gate).toBe('G3');
  });
});

describe('buildVoucherInviteWithCode', () => {
  const v = { code: 'ACTIVEPAW-SAM5', pctOff: 5, commissionPct: 2, startsAtLabel: '8 August 2026', endsAtLabel: '7 September 2026', deferred: true };
  it('carries the code, terms, tier reminder and ground rules', () => {
    const body = buildVoucherInviteWithCode('Sam', v);
    expect(body.startsWith('Hi Sam,')).toBe(true);
    expect(body).toContain('ACTIVEPAW-SAM5');
    expect(body).toContain('5% off');
    expect(body).toContain('2% of the goods value');
    expect(body).toContain('25 tracked orders');
    // Clearance hold + monthly cadence (2026-07-14): the invite states when
    // commission is confirmed and paid, not just the rate.
    expect(body).toContain('cleared our returns window');
    expect(body).toContain('paid out monthly');
    expect(body).toContain('coupon or deal sites');
    expect(body).not.toMatch(/[—–]/);
  });
  it('explains event-deferred timing, or says live now', () => {
    expect(buildVoucherInviteWithCode('Sam', v)).toContain('goes live on 8 August 2026');
    expect(buildVoucherInviteWithCode('Sam', { ...v, deferred: false })).toContain('It is live now');
  });
});

describe('voucherDateLabel', () => {
  it('renders a stable UTC date', () => {
    expect(voucherDateLabel('2026-08-08T00:05:00Z')).toBe('8 August 2026');
  });
});
