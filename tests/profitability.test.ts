import { describe, it, expect } from 'vitest';
import { netAfterAdsGbp, productNetAfterAds, profitVerdict, competitorCacheKey } from '../src/profitability';
import { DEFAULT_PROFIT, type Pricing, type ProfitConfig } from '../src/types';

// Live pricing rule (2.2x, GBP0.78 FX, +2% buffer, GBP30 margin cap).
const PRICING: Pricing = { multiplier: 2.2, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2, maxMarginGbp: 30 };

describe('netAfterAdsGbp', () => {
  it('charges ad cost on GROSS retail (advisor: 0.33 x gross, the ROAS-3 base)', () => {
    const n = netAfterAdsGbp(10, 0, PRICING, DEFAULT_PROFIT);
    expect(n.retailGbp).toBeGreaterThan(0);
    expect(n.adCostGbp).toBeCloseTo(DEFAULT_PROFIT.adShareOfRevenue * n.retailGbp, 2);
  });

  it('follows the cost-stack identity: net = exVAT - COGS - ad - payments - refund (to the penny)', () => {
    const p = DEFAULT_PROFIT;
    const n = netAfterAdsGbp(10, 0, PRICING, p);
    const exVat = n.retailGbp / (1 + p.vatRate);
    const expected = exVat - n.cogsGbp - p.adShareOfRevenue * n.retailGbp - p.paymentsFeeRate * n.retailGbp - p.refundReserveRate * exVat;
    expect(n.netGbp).toBeCloseTo(expected, 1); // within a penny of the raw formula (components are rounded)
  });

  it('a thin-but-positive low-ticket item clears the GBP0 money-loser floor', () => {
    const n = netAfterAdsGbp(10, 0, PRICING, DEFAULT_PROFIT);
    expect(n.netGbp).toBeGreaterThan(0);
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
