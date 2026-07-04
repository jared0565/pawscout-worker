import { describe, it, expect } from 'vitest';
import { scoreScreen } from '../src/inbox/partnership';
import type { ScreenFacts } from '../src/inbox/types';

// A clean, high-quality applicant; override per-case.
const base: ScreenFacts = {
  channelUrls: ['https://tiktok.com/@dogmum'],
  disqualifier: 'none',
  audienceRelevance: 'pet_uk',
  acceptsTerms: 'yes',
  engagement: 'plausible',
  evidence: 'concrete',
  experience: 'some',
  method: 'content',
  specificity: 'specific',
};
const f = (o: Partial<ScreenFacts> = {}): ScreenFacts => ({ ...base, ...o });

describe('scoreScreen - hard gates (any one → decline)', () => {
  it('G1: no channel URL', () => {
    const v = scoreScreen(f({ channelUrls: [] }));
    expect(v.decision).toBe('decline'); expect(v.gate).toBe('G1'); expect(v.score).toBeNull();
  });
  it('G2: coupon/cashback type, or brand-bidding', () => {
    expect(scoreScreen(f({ disqualifier: 'coupon_cashback' })).gate).toBe('G2');
    expect(scoreScreen(f({ disqualifier: 'brand_bidding' })).gate).toBe('G2');
  });
  it('G3: audience not pet/UK relevant', () => {
    expect(scoreScreen(f({ audienceRelevance: 'off' })).gate).toBe('G3');
  });
  it('G4: rejects terms/disclosure', () => {
    expect(scoreScreen(f({ acceptsTerms: 'no' })).gate).toBe('G4');
  });
  it('G5: prohibited tactics', () => {
    expect(scoreScreen(f({ disqualifier: 'prohibited_tactics' })).gate).toBe('G5');
  });
});

describe('scoreScreen - bands (no hard gate)', () => {
  it('strong applicant scores high → form', () => {
    const v = scoreScreen(f());
    expect(v.gate).toBeNull();
    expect(v.score).toBeGreaterThanOrEqual(8);
    expect(v.decision).toBe('form');
  });
  it('weak-but-not-disqualified → escalate, never declined (auto-decline-low OFF)', () => {
    const v = scoreScreen(f({ audienceRelevance: 'partial', engagement: 'unclear', evidence: 'none', experience: 'none', method: 'mixed', specificity: 'vague' }));
    expect(v.gate).toBeNull();
    expect(v.score).toBeLessThan(8);
    expect(v.decision).toBe('escalate');
  });
  it('auto-decline-low dial ON declines score <= 3', () => {
    const weak: Partial<ScreenFacts> = { audienceRelevance: 'partial', engagement: 'implausible', evidence: 'none', experience: 'none', method: 'discount', specificity: 'vague' };
    expect(scoreScreen(f(weak), { autoDeclineLow: false }).decision).toBe('escalate');
    const v = scoreScreen(f(weak), { autoDeclineLow: true });
    expect(v.decision).toBe('decline'); expect(v.gate).toBe('LOW');
  });
  it('boundary: exactly the pass threshold passes', () => {
    // partial(1)+unclear(1)+vague(1)+some(1)+content(2)+specific(2) = 8 → form
    const v = scoreScreen(f({ audienceRelevance: 'partial', engagement: 'unclear', evidence: 'vague', experience: 'some', method: 'content', specificity: 'specific' }));
    expect(v.score).toBe(8); expect(v.decision).toBe('form');
  });
});

// Voucher variant (2026-07-04): a discount-code push on the applicant's OWN
// channel is the trial's mechanic, so METHOD weights soften (discount 0→1,
// mixed 1→2); every hard gate is variant-independent.
describe('scoreScreen - voucher variant METHOD weights', () => {
  it('scores method=discount 1 under voucher (vs 0 under the default link variant)', () => {
    const link = scoreScreen(f({ method: 'discount' }));
    const voucher = scoreScreen(f({ method: 'discount' }), { variant: 'voucher' });
    expect(voucher.score! - link.score!).toBe(1);
    expect(voucher.signals.S5_method).toBe(1);
  });

  it('scores method=mixed 2 under voucher (vs 1 under link)', () => {
    const voucher = scoreScreen(f({ method: 'mixed' }), { variant: 'voucher' });
    expect(voucher.signals.S5_method).toBe(2);
  });

  it('keeps the coupon/deal-site hard gate in both variants', () => {
    expect(scoreScreen(f({ disqualifier: 'coupon_cashback' }), { variant: 'voucher' }).gate).toBe('G2');
    expect(scoreScreen(f({ disqualifier: 'coupon_cashback' }), { variant: 'link' }).gate).toBe('G2');
  });

  it('explicit variant "link" matches the default weights exactly', () => {
    for (const method of ['content', 'mixed', 'discount', 'unknown'] as const) {
      expect(scoreScreen(f({ method }), { variant: 'link' }).score).toBe(scoreScreen(f({ method })).score);
    }
  });
});
