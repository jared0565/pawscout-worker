import { describe, it, expect } from 'vitest';
import { netAfterAdsGbp, productNetAfterAds, profitVerdict, competitorCacheKey, decideProfitAction, liveNetGbp, round99Down, undercutTarget } from '../src/profitability';
import { DEFAULT_PROFIT, type Pricing, type ProfitConfig } from '../src/types';

// Live pricing rule (2.2x, GBP0.78 FX, +2% buffer, GBP30 margin cap).
const PRICING: Pricing = { multiplier: 2.2, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2, maxMarginGbp: 30 };

describe('netAfterAdsGbp', () => {
  it('charges ad cost on GROSS retail (advisor: 0.33 x gross, the ROAS-3 base)', () => {
    const n = netAfterAdsGbp(10, 0, PRICING, DEFAULT_PROFIT);
    expect(n.retailGbp).toBeGreaterThan(0);
    expect(n.adCostGbp).toBeCloseTo(DEFAULT_PROFIT.adShareOfRevenue * n.retailGbp, 2);
  });

  it('follows the cost-stack identity: net = exVAT - COGS - ad - payments - refund - affiliate (to the penny)', () => {
    const p = DEFAULT_PROFIT;
    const n = netAfterAdsGbp(10, 0, PRICING, p);
    const exVat = n.retailGbp / (1 + p.vatRate);
    const affiliate = p.affiliateSalesShare * (p.affiliateCommissionRate * exVat + p.affiliatePlatformFeeRate * n.retailGbp);
    const discount = p.expectedDiscountRate * n.retailGbp;
    const overhead = p.fixedOverheadRate * n.retailGbp;
    const expected = exVat - n.cogsGbp - p.adShareOfRevenue * n.retailGbp - p.paymentsFeeRate * n.retailGbp - p.refundReserveRate * exVat - affiliate - discount - overhead;
    expect(n.netGbp).toBeCloseTo(expected, 1); // within a penny of the raw formula (components are rounded)
  });

  it('at a realistic ad share a low-ticket item clears the floor; at the worst-case default it does not', () => {
    // The full cost stack (ads+payments+refunds+affiliate+discount) sinks a
    // GBP10-cost item at the worst-case 33% ad share, but clears at a realistic
    // blended ad share. That gap IS the tuning lever the owner sets.
    expect(netAfterAdsGbp(10, 0, PRICING, { ...DEFAULT_PROFIT, adShareOfRevenue: 0.15 }).netGbp).toBeGreaterThan(0);
    expect(netAfterAdsGbp(10, 0, PRICING, DEFAULT_PROFIT).netGbp).toBeLessThan(0);
  });

  it('goes NEGATIVE on the high cost+freight, margin-capped class (the auto-feeder)', () => {
    // ~$112 product + $30 freight: the GBP30 margin cap caps revenue but ads
    // (33% of gross) exceed it, so the unit loses money. This is exactly what
    // the deterministic floor must catch.
    const n = netAfterAdsGbp(112, 30, PRICING, DEFAULT_PROFIT);
    expect(n.netGbp).toBeLessThan(0);
  });

  it('lowering the ad share strictly raises net (monotonic in ad cost)', () => {
    const hi = netAfterAdsGbp(10, 0, PRICING, { ...DEFAULT_PROFIT, adShareOfRevenue: 0.33 });
    const lo = netAfterAdsGbp(10, 0, PRICING, { ...DEFAULT_PROFIT, adShareOfRevenue: 0.15 });
    expect(lo.netGbp).toBeGreaterThan(hi.netGbp);
  });
});

describe('productNetAfterAds (worst-variant policy, mirrors productAffiliateEligible)', () => {
  it('judges the product on its WORST sellable variant', () => {
    const a = netAfterAdsGbp(10, 0, PRICING, DEFAULT_PROFIT).netGbp;
    const b = netAfterAdsGbp(112, 0, PRICING, DEFAULT_PROFIT).netGbp;
    const p = productNetAfterAds([{ sellPriceUsd: 10 }, { sellPriceUsd: 112 }], PRICING, 0, DEFAULT_PROFIT)!;
    expect(p.worstNetGbp).toBe(Math.min(a, b)); // the $112 variant is worst
    expect(p.worstNetGbp).toBeLessThan(a);
    expect(p.belowFloor).toBe(true); // worst variant is negative -> below the GBP0 floor
  });

  it('reports fromRetailGbp as the MIN sticker (the card price for the competitor compare)', () => {
    const cheapRetail = netAfterAdsGbp(10, 0, PRICING, DEFAULT_PROFIT).retailGbp;
    const p = productNetAfterAds([{ sellPriceUsd: 10 }, { sellPriceUsd: 112 }], PRICING, 0, DEFAULT_PROFIT)!;
    expect(p.fromRetailGbp).toBe(cheapRetail);
  });

  it('returns null when no variant has a usable cost', () => {
    expect(productNetAfterAds([{ sellPriceUsd: 0 }], PRICING, 0, DEFAULT_PROFIT)).toBeNull();
  });
});

describe('profitVerdict', () => {
  const healthy = { worstNetGbp: 8, worstNetPct: 0.2, belowFloor: false, fromRetailGbp: 20 };

  it('REJECTS when below the deterministic floor', () => {
    const v = profitVerdict({ net: { ...healthy, belowFloor: true, worstNetGbp: -3 }, competitor: null, profit: DEFAULT_PROFIT });
    expect(v.verdict).toBe('reject');
  });

  it('REJECTS on a HIGH-confidence competitor undercut beyond tolerance', () => {
    const v = profitVerdict({ net: healthy, competitor: { estimateGbp: 12, confidence: 'high', sources: ['amazon.co.uk'] }, profit: DEFAULT_PROFIT });
    expect(v.verdict).toBe('reject'); // GBP20 > GBP12 * 1.15
  });

  it('only REVIEWS on a low-confidence undercut (never hard-blocks a noisy signal)', () => {
    const v = profitVerdict({ net: healthy, competitor: { estimateGbp: 12, confidence: 'low', sources: [] }, profit: DEFAULT_PROFIT });
    expect(v.verdict).toBe('review');
  });

  it('PASSES when priced at/under the competitor', () => {
    const v = profitVerdict({ net: healthy, competitor: { estimateGbp: 25, confidence: 'high', sources: [] }, profit: DEFAULT_PROFIT });
    expect(v.verdict).toBe('pass');
  });

  it('PASSES when there is no competitor signal (no signal is not a failure)', () => {
    expect(profitVerdict({ net: healthy, competitor: null, profit: DEFAULT_PROFIT }).verdict).toBe('pass');
  });
});

describe('competitorCacheKey', () => {
  it('namespaces by pid', () => { expect(competitorCacheKey('ABC')).toBe('comp:ABC'); });
});

describe('round99Down', () => {
  it('rounds to a .99 ending at or below x (never above the market)', () => {
    expect(round99Down(13.5)).toBe(12.99);
    expect(round99Down(13.99)).toBe(13.99);
    expect(round99Down(14)).toBe(13.99);
    expect(round99Down(0.4)).toBe(0.99); // floor guard
  });
});

describe('decideProfitAction (owner rule: net >= GBP2, price just under the competitor delivered price)', () => {
  // Realistic ad share; floor GBP2 comes from DEFAULT_PROFIT. liveNet ~= 0.57*price - cost.
  const P: ProfitConfig = { ...DEFAULT_PROFIT, adShareOfRevenue: 0.15 };
  const hi = (estimateGbp: number) => ({ estimateGbp, confidence: 'high' as const });

  it('KEEPS (never acts blind) when there is no live price/cost', () => {
    expect(decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 0, costGbp: 0 }], competitor: null, profit: P }).kind).toBe('keep');
  });

  it('DROPS a clear loss: loses money at its current price with no market data', () => {
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 10, costGbp: 8 }], competitor: null, profit: P });
    expect(a.kind).toBe('drop');
  });

  it('AUTO-RAISES toward just under the competitor when there is headroom', () => {
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 15, costGbp: 5 }], competitor: hi(25), profit: P });
    expect(a.kind).toBe('reprice');
    if (a.kind === 'reprice') {
      expect(a.updates[0].toGbp).toBeGreaterThan(15);          // raised
      expect(a.updates[0].toGbp).toBeLessThan(25);             // still under the market
      expect(a.reason).toContain('raise');
    }
  });

  it('AUTO-LOWERS to just under the competitor when we are priced above it', () => {
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 30, costGbp: 5 }], competitor: hi(20), profit: P });
    expect(a.kind).toBe('reprice');
    if (a.kind === 'reprice') { expect(a.updates[0].toGbp).toBeLessThan(30); expect(a.updates[0].toGbp).toBeLessThan(20); }
  });

  it('DROPS when it cannot clear GBP2 net even at the best price below the market', () => {
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 30, costGbp: 12 }], competitor: hi(15), profit: P });
    expect(a.kind).toBe('drop');
  });

  it('KEEPS (deadband) when already at the undercut target below the market', () => {
    // Undercut target for a GBP25 competitor is ~GBP23.99, so a product already there stays put.
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 23.99, costGbp: 5 }], competitor: hi(25), profit: P });
    expect(a.kind).toBe('keep');
  });

  it('treats a LOW-confidence competitor as no market data (keeps a >= GBP2 item, no reprice)', () => {
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 30, costGbp: 5 }], competitor: { estimateGbp: 20, confidence: 'low' }, profit: P });
    expect(a.kind).toBe('keep');
  });

  it('FLAGS a sub-GBP2 item when there is no market price to safely reprice from', () => {
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 12, costGbp: 6 }], competitor: null, profit: P });
    expect(a.kind).toBe('flag'); // net ~0.84: positive but under the GBP2 target, no data to raise
  });

  it('reprices EVERY variant, judged on the worst', () => {
    const a = decideProfitAction({
      variants: [{ variantId: 'v1', priceGbp: 40, costGbp: 5 }, { variantId: 'v2', priceGbp: 60, costGbp: 10 }],
      competitor: hi(30), profit: P
    });
    expect(a.kind).toBe('reprice');
    if (a.kind === 'reprice') expect(a.updates.map((u) => u.variantId)).toEqual(['v1', 'v2']);
  });

  it('liveNetGbp is revenue-ex-VAT minus cost, ads, fees, affiliate and discount', () => {
    const n = liveNetGbp(20, 8, P);
    const exVat = 20 / 1.2;
    const affiliate = P.affiliateSalesShare * (P.affiliateCommissionRate * exVat + P.affiliatePlatformFeeRate * 20);
    const discount = P.expectedDiscountRate * 20;
    const overhead = P.fixedOverheadRate * 20;
    expect(n).toBeCloseTo(exVat - 8 - P.adShareOfRevenue * 20 - P.paymentsFeeRate * 20 - P.refundReserveRate * exVat - affiliate - discount - overhead, 6);
  });

  it('undercutTarget lands meaningfully below the competitor, on a .99 (GBP25 -> GBP23.99 at 5%)', () => {
    expect(undercutTarget(25, 0.05)).toBe(23.99);
    expect(undercutTarget(20, 0.05)).toBe(18.99);
    expect(undercutTarget(25, 0.05)).toBeLessThan(25); // always strictly under the market
  });
});
