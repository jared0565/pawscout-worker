import { describe, it, expect } from 'vitest';
import { retailPriceGbp, landedCostGbp, affiliateEligible, affiliateContributionGbp } from '../src/pricing';
import { DEFAULT_PRICING } from '../src/types';

describe('retailPriceGbp', () => {
  it('applies multiplier, FX and buffer, then rounds up to .99', () => {
    // 10 USD → cost 10×0.78×1.02 = 7.956 → ×2.5 = 19.89 → 19.99
    expect(retailPriceGbp(10, DEFAULT_PRICING)).toBe(19.99);
  });

  it('enforces the absolute minimum margin on low-ticket items', () => {
    // 1 USD → cost ~0.80, ×2.5 ≈ 1.99 margin ~1.19 < £6 → cost + 6 ≈ 6.80 → 6.99
    expect(retailPriceGbp(1, DEFAULT_PRICING)).toBe(6.99);
  });

  it('the floor wins when the multiplier is set below it', () => {
    const p = { ...DEFAULT_PRICING, multiplier: 1.5, floor: 2.2, minMarginGbp: 0 };
    // cost 7.956 × 2.2 = 17.50 → 17.99
    expect(retailPriceGbp(10, p)).toBe(17.99);
  });

  it('never rounds below the computed price', () => {
    const p = { ...DEFAULT_PRICING, fxUsdToGbp: 1, fxBufferPct: 0, multiplier: 2.5, minMarginGbp: 0 };
    // 10 × 2.5 = exactly 25.00 → 24.99 would undercut → 25.99
    expect(retailPriceGbp(10, p)).toBe(25.99);
  });

  // 2026-07-03 owner decision (free-UK-delivery cutover): freight is BAKED INTO the
  // sticker (added after the multiplier) so UK checkout shipping can be £0 storewide
  // without eating margin. Reverses the 2026-06-12 "freight disciplines the floor,
  // never the sticker" rule - that rule plus a separate checkout charge double-charged
  // freight on min-margin items.
  it('bakes freight into the sticker (added after the multiplier, not multiplied)', () => {
    // fx = 0.78×1.02 = 0.7956. 30 USD cost, 5 USD freight:
    // cost £23.868 ×2.5 = £59.67 + freight £3.978 = £63.648 → 63.99
    expect(retailPriceGbp(30, DEFAULT_PRICING, 5)).toBe(63.99);
    // the same item without freight stays on the old sticker → 59.99
    expect(retailPriceGbp(30, DEFAULT_PRICING)).toBe(59.99);
    // typical CN mid-ticket item: 10 USD cost, 5.02 USD freight → 19.89 + 3.99 = 23.99
    expect(retailPriceGbp(10, DEFAULT_PRICING, 5.02)).toBe(23.99);
  });

  it('domestic (zero-freight) items keep their sticker unchanged', () => {
    expect(retailPriceGbp(30, DEFAULT_PRICING, 0)).toBe(retailPriceGbp(30, DEFAULT_PRICING));
    expect(retailPriceGbp(10, DEFAULT_PRICING, 0)).toBe(19.99);
  });

  it('the minimum-margin clause still guarantees cost + freight + margin on cheap items', () => {
    // cheap+heavy: 2 USD cost, 10 USD freight. sticker 1.59×2.5 + 7.96 = £11.93;
    // margin 11.93 - (1.59 + 7.96) = £2.39 < £6 → floor = 1.59 + 7.96 + 6 = £15.55 → 15.99
    expect(retailPriceGbp(2, DEFAULT_PRICING, 10)).toBe(15.99);
    // same item without freight knowledge degrades to the product-cost-only rule → 7.99
    expect(retailPriceGbp(2, DEFAULT_PRICING)).toBe(7.99);
  });

  it('rejects non-positive landed costs', () => {
    expect(() => retailPriceGbp(0, DEFAULT_PRICING)).toThrow();
    expect(() => retailPriceGbp(NaN, DEFAULT_PRICING)).toThrow();
  });
});

describe('landedCostGbp (honest COGS, raw FX)', () => {
  it('converts product cost at the raw FX rate - no buffer', () => {
    // 10 USD × 0.78 = 7.80 (the retail path would use 0.78×1.02 = 0.7956)
    expect(landedCostGbp(10, DEFAULT_PRICING)).toBe(7.8);
  });

  it('adds freight to the landed cost', () => {
    // (2 + 10) × 0.78 = 9.36
    expect(landedCostGbp(2, DEFAULT_PRICING, 10)).toBe(9.36);
  });

  it('is strictly below the buffered cost basis used for retail', () => {
    // honest cost must never exceed what the (padded) retail rule assumes as cost
    const honest = landedCostGbp(10, DEFAULT_PRICING);
    const buffered = 10 * DEFAULT_PRICING.fxUsdToGbp * (1 + DEFAULT_PRICING.fxBufferPct / 100);
    expect(honest).toBeLessThan(buffered);
  });

  it('ignores unknown/zero freight', () => {
    expect(landedCostGbp(10, DEFAULT_PRICING, 0)).toBe(landedCostGbp(10, DEFAULT_PRICING));
  });

  it('rejects non-positive landed costs', () => {
    expect(() => landedCostGbp(0, DEFAULT_PRICING)).toThrow();
    expect(() => landedCostGbp(NaN, DEFAULT_PRICING)).toThrow();
  });
});

describe('affiliateEligible (£6 floor)', () => {
  it('passes a healthy SKU: ex-VAT contribution clears £6 after commission + fee', () => {
    // $10 → retail 19.99, COGS 7.80. net rev 16.66, contribution 8.86,
    // −8% comm (1.33) −2% fee (0.40) = 7.13 ≥ 6 → eligible
    const retail = retailPriceGbp(10, DEFAULT_PRICING);
    const cogs = landedCostGbp(10, DEFAULT_PRICING);
    expect(affiliateContributionGbp(retail, cogs)).toBeGreaterThan(6);
    expect(affiliateEligible(retail, cogs)).toBe(true);
  });

  it('fails a thin SKU: the floor pricing leaves < £6 after the affiliate cut', () => {
    // $3 → retail 8.99 (min-margin floored), COGS 2.34. surviving ≈ 4.37 < 6
    const retail = retailPriceGbp(3, DEFAULT_PRICING);
    const cogs = landedCostGbp(3, DEFAULT_PRICING);
    expect(affiliateContributionGbp(retail, cogs)).toBeLessThan(6);
    expect(affiliateEligible(retail, cogs)).toBe(false);
  });

  it('honours an override floor', () => {
    const retail = retailPriceGbp(10, DEFAULT_PRICING);
    const cogs = landedCostGbp(10, DEFAULT_PRICING);
    // raise the bar to £8 → the 7.13 survivor no longer clears it
    expect(affiliateEligible(retail, cogs, { vatRate: 0.2, commissionRate: 0.08, platformFeeRate: 0.02, floorGbp: 8 })).toBe(false);
  });

  it('rejects non-finite / non-positive inputs', () => {
    expect(affiliateEligible(0, 5)).toBe(false);
    expect(affiliateEligible(20, 0)).toBe(false);
    expect(affiliateEligible(NaN, 5)).toBe(false);
  });
});
