import { describe, it, expect } from 'vitest';
import { retailPriceGbp } from '../src/pricing';
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

  it('freight disciplines the floor, never the multiplier sticker', () => {
    // cheap+heavy: 2 USD cost, 10 USD freight. fx = 0.78×1.02 = 0.7956
    // cost £1.59, ×2.5 = £3.98; floor = 1.59 + 7.96 + 6 = £15.55 → 15.99
    expect(retailPriceGbp(2, DEFAULT_PRICING, 10)).toBe(15.99);
    // same item without freight knowledge degrades to the old rule → 7.99
    expect(retailPriceGbp(2, DEFAULT_PRICING)).toBe(7.99);
    // expensive item: multiplier already clears cost+freight+margin — sticker unchanged
    expect(retailPriceGbp(30, DEFAULT_PRICING, 5)).toBe(retailPriceGbp(30, DEFAULT_PRICING));
  });

  it('rejects non-positive landed costs', () => {
    expect(() => retailPriceGbp(0, DEFAULT_PRICING)).toThrow();
    expect(() => retailPriceGbp(NaN, DEFAULT_PRICING)).toThrow();
  });
});
