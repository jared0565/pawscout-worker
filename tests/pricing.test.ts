import { describe, it, expect } from 'vitest';
import { retailPriceGbp, landedCostGbp, costPlusPriceGbp, affiliateEligible, affiliateContributionGbp } from '../src/pricing';
import { DEFAULT_PRICING } from '../src/types';

describe('costPlusPriceGbp (GBP-native defensible markup on a live landed cost)', () => {
  it('applies the multiplier to the GBP cost and rounds up to .99', () => {
    // 10 GBP cost x 2.5 = 25 -> 25.99
    expect(costPlusPriceGbp(10, DEFAULT_PRICING)).toBe(25.99);
  });

  it('enforces the absolute minimum margin on low-ticket items', () => {
    // 1 GBP cost x 2.5 = 2.5 (margin 1.5 < 6) -> 1 + 6 = 7 -> 7.99
    expect(costPlusPriceGbp(1, DEFAULT_PRICING)).toBe(7.99);
  });

  it('caps the absolute margin when maxMarginGbp is set', () => {
    // 100 GBP cost x 2.5 = 250 (margin 150 > 30) -> 100 + 30 = 130 -> 130.99
    expect(costPlusPriceGbp(100, { ...DEFAULT_PRICING, maxMarginGbp: 30 })).toBe(130.99);
  });

  it('returns 0 (no defensible price) for a non-positive cost', () => {
    expect(costPlusPriceGbp(0, DEFAULT_PRICING)).toBe(0);
    expect(costPlusPriceGbp(-5, DEFAULT_PRICING)).toBe(0);
  });
});

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

  // 2026-07-04 owner decision: optional margin CAP (maxMarginGbp) - the mirror of
  // the £6 minimum. Above the crossover cost the effective multiplier glides down
  // hyperbolically (1 + cap/cost): a smooth taper with no band edges. Absent = off
  // (exact pre-cap behaviour). Motivation: 2.5x prices big-ticket branded items
  // far above their visible street price (180cm PawHut tree: cost £49 -> £122.99
  // vs the brand's own £52.99).
  describe('margin cap (maxMarginGbp smooth taper)', () => {
    const CAPPED = { ...DEFAULT_PRICING, maxMarginGbp: 30 };

    it('caps the margin on high-cost items', () => {
      // 62 USD -> cost £49.3272, x2.5 = £123.318 (margin £73.99 > £30)
      // -> capped at 49.3272 + 30 = £79.3272 -> 79.99 (was 123.99 uncapped)
      expect(retailPriceGbp(62, CAPPED)).toBe(79.99);
      expect(retailPriceGbp(62, DEFAULT_PRICING)).toBe(123.99);
    });

    it('leaves items below the crossover untouched', () => {
      // 10 USD: margin £11.93 < £30 -> identical to the uncapped sticker
      expect(retailPriceGbp(10, CAPPED)).toBe(retailPriceGbp(10, DEFAULT_PRICING));
    });

    it('freight still passes through on top of the capped margin', () => {
      // 62 USD + 5 USD freight: capped = cost 49.3272 + freight 3.978 + 30 = £83.3052 -> 83.99
      expect(retailPriceGbp(62, CAPPED, 5)).toBe(83.99);
    });

    it('does not interfere with the minimum-margin clause on cheap items', () => {
      expect(retailPriceGbp(1, CAPPED)).toBe(retailPriceGbp(1, DEFAULT_PRICING));
    });

    it('is continuous at the crossover and keeps retail monotone in cost', () => {
      // clean numbers: fx 1, no buffer, no min margin. crossover at cost $20
      // (20 x 1.5 = 30): formula 20x2.5 = 50 == cap 20+30 = 50 -> same sticker.
      const p = { multiplier: 2.5, floor: 1, minMarginGbp: 0, fxUsdToGbp: 1, fxBufferPct: 0, maxMarginGbp: 30 };
      expect(retailPriceGbp(20, p)).toBe(retailPriceGbp(20, { ...p, maxMarginGbp: undefined }));
      const retails = [10, 15, 20, 25, 30, 40, 80].map((c) => retailPriceGbp(c, p));
      for (let i = 1; i < retails.length; i++) expect(retails[i]).toBeGreaterThanOrEqual(retails[i - 1]);
    });

    it('ignores a nonsense stored cap (zero/negative) instead of inverting the rule', () => {
      expect(retailPriceGbp(62, { ...DEFAULT_PRICING, maxMarginGbp: 0 })).toBe(123.99);
      expect(retailPriceGbp(62, { ...DEFAULT_PRICING, maxMarginGbp: -5 })).toBe(123.99);
    });
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
