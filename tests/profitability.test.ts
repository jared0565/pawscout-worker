import { describe, it, expect } from 'vitest';
import { netAfterAdsGbp, productNetAfterAds, competitorCacheKey, competitorSignal, decideProfitAction, liveNetGbp, round99Down, undercutTarget, type CompetitorSignal } from '../src/profitability';
import { DEFAULT_PROFIT, type Pricing, type ProfitConfig, type TenantConfig } from '../src/types';
import type { TenantStore } from '../src/tenant-store';
import type { LlmClient } from '../src/llm';

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
  const med = (estimateGbp: number) => ({ estimateGbp, confidence: 'medium' as const });

  it('KEEPS (never acts blind) when there is no live price/cost', () => {
    expect(decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 0, costGbp: 0 }], competitor: null, profit: P }).kind).toBe('keep');
  });

  it('DROPS a clear loss with no market data ONLY when it sells below landed cost', () => {
    // price 10 / cost 9: revenue ex-VAT (8.33) is below cost, so the shop loses
    // money on the item itself - a defensible drop that does not depend on any
    // tunable assumption.
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 10, costGbp: 9 }], competitor: null, profit: P });
    expect(a.kind).toBe('drop');
  });

  it('RAISES a thin no-competitor item to our cost-plus price (keeps it live; never auto-drops healthy stock on the placeholder ad share)', () => {
    // price 12 / cost 5 is 58% gross margin (profitable), but full-stack net is
    // negative at the WORST-CASE default ad share (0.33) - thin. With a defensible
    // cost-plus price that clears the floor, the agent RAISES to it and keeps the
    // product live (the owner's "market of one"), never archiving healthy stock.
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 12, costGbp: 5, rulePriceGbp: 24.99 }], competitor: null, profit: DEFAULT_PROFIT });
    expect(a.kind).toBe('reprice');
    if (a.kind === 'reprice') { expect(a.updates[0].toGbp).toBe(24.99); expect(a.updates[0].toGbp).toBeGreaterThan(12); expect(a.reason).toContain('cost-plus'); }
  });

  it('KEEPS a healthy no-competitor item at its current price (does not lower a working price without market evidence)', () => {
    // net well above the floor at 30, no competitor - we neither lower it (no evidence
    // it is above market) nor touch it. "No competitor found" can mean we are the only
    // seller as easily as an unmatched search, so a working price is left alone.
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 30, costGbp: 5, rulePriceGbp: 12.99 }], competitor: null, profit: P });
    expect(a.kind).toBe('keep');
  });

  it('FLAGS a thin no-competitor item when even our cost-plus price cannot clear the floor', () => {
    // gross-positive (not below cost) but structurally thin: our standard markup still
    // nets under the floor. No auto-drop on no market data - a human decides.
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 14, costGbp: 10, rulePriceGbp: 15 }], competitor: null, profit: DEFAULT_PROFIT });
    expect(a.kind).toBe('flag');
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

  it('DROPS on a clear LOSS: even priced just under a HIGH-confidence market it sells below all-in cost', () => {
    // price 30 / cost 12 vs a GBP15 market: the best price we can hold under the
    // market (~GBP13.99) nets NEGATIVE (revenue ex-VAT < cost), so to compete we
    // would have to sell at a loss. A high-confidence market makes that a defensible drop.
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 30, costGbp: 12 }], competitor: hi(15), profit: P });
    expect(a.kind).toBe('drop');
  });

  it('FLAGS (never drops) a money-maker that is profitable-but-under-floor beneath a HIGH-confidence market', () => {
    // price 8 / cost 5 under a GBP11.99 market: the agent would raise toward ~GBP10.99,
    // netting ~GBP1 - real profit, just under the GBP2 floor. That is a money-maker, so
    // it must be flagged for the owner, NEVER auto-archived (the decision-1 softening).
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 8, costGbp: 5 }], competitor: hi(11.99), profit: P });
    expect(a.kind).toBe('flag');
    if (a.kind === 'flag') expect(a.reason).toContain('best price below the market');
  });

  it('FLAGS a profitable-but-under-floor item regardless of confidence (medium market, same money-maker)', () => {
    // Same money-maker under a MEDIUM-confidence market: still a flag. Profitable-thin
    // never auto-drops on ANY confidence; only an actual LOSS at high confidence does.
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 8, costGbp: 5 }], competitor: med(11.99), profit: P });
    expect(a.kind).toBe('flag');
  });

  it('FLAGS (never auto-archives) when it cannot clear the floor against only a MEDIUM-confidence market', () => {
    // The competitor price is the softest input; a medium-confidence low estimate
    // must not silently archive a possibly-profitable product. Reprice can run on
    // medium confidence (recoverable); an archive cannot, so it needs hard evidence.
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 30, costGbp: 12 }], competitor: med(15), profit: P });
    expect(a.kind).toBe('flag');
  });

  it('still REPRICES on a medium-confidence market when it CAN clear the floor (reprice is recoverable)', () => {
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 15, costGbp: 5 }], competitor: med(25), profit: P });
    expect(a.kind).toBe('reprice');
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

  it('FLAGS a thin no-competitor item when no cost-plus price is available (fallback)', () => {
    // No rulePriceGbp supplied (legacy / no cost source): the agent cannot compute a
    // defensible reprice target, so a thin item flags rather than guessing a price.
    const a = decideProfitAction({ variants: [{ variantId: 'v', priceGbp: 12, costGbp: 6 }], competitor: null, profit: P });
    expect(a.kind).toBe('flag'); // net ~0.6: positive but under the GBP2 target, no rule price to raise to
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

describe('competitorSignal (delivered price = item + delivery)', () => {
  // In-memory fakes: this file stays pure (no D1). The LLM fake feeds a raw JSON
  // object through the REAL validate, which is what these tests exercise.
  const CFG = { llm: { enabled: true, scoreThreshold: 60, models: {} }, profit: DEFAULT_PROFIT } as unknown as TenantConfig;
  const storeOf = (cached: string[]) => ({
    getSearchCache: async () => null,
    putSearchCache: async (key: string, value: string) => { cached.push(value); },
    logLlmUsage: async () => undefined
  } as unknown as TenantStore);
  const llmOf = (raw: unknown, provider: 'openrouter' | 'openai' = 'openrouter') => ({
    available: true,
    jsonChain: async (o: { validate: (v: unknown) => CompetitorSignal | null }) => {
      const value = o.validate(raw);
      return value
        ? { ok: true as const, value, usage: { provider, model: 'test', promptTokens: 0, completionTokens: 0, costUsd: 0 } }
        : { ok: false as const, error: 'invalid' };
    }
  } as unknown as LlmClient);

  it('sums the item and delivery parts - the missed-postage under-read fix (2026-07-10 audit)', async () => {
    // The nail-grinder failure: the model knew the GBP12.99 item but dropped the
    // GBP4.99 postage. Forcing the split and summing it beats a stale estimateGbp.
    const cached: string[] = [];
    const r = await competitorSignal(llmOf({ itemGbp: 12.99, deliveryGbp: 4.99, estimateGbp: 12.99, confidence: 'high', sources: ['amazon.co.uk'] }), storeOf(cached), CFG, { pid: 'p1', title: 'Dog Nail Grinder', ourRetailGbp: 11.99 });
    expect(r?.estimateGbp).toBe(17.98);
    expect(cached).toHaveLength(1); // usable signal cached for the agent's sweep
  });

  it('falls back to estimateGbp when the split fields are absent (older/partial shapes)', async () => {
    const r = await competitorSignal(llmOf({ estimateGbp: 14.99, confidence: 'medium', sources: [] }), storeOf([]), CFG, { pid: 'p2', title: 'X', ourRetailGbp: 9.99 });
    expect(r?.estimateGbp).toBe(14.99);
  });

  const mkCand = (title: string, deliveredGbp: number) => ({ title, itemGbp: deliveredGbp, deliveryGbp: 0, deliveredGbp });
  const marketOf = (candidates: ReturnType<typeof mkCand>[] | null) => ({ name: 'ebay.co.uk', search: async () => candidates });
  const neverLlm = { available: true, jsonChain: async () => { throw new Error('LLM must not be consulted on the zero-LLM path'); } } as unknown as LlmClient;

  it('ZERO-LLM path: strong structured matches produce a cached signal without any LLM call', async () => {
    const cached: string[] = [];
    const r = await competitorSignal(neverLlm, storeOf(cached), CFG, {
      pid: 'z1', title: '800ml Dog Water Bottle Portable Leakproof', ourRetailGbp: 12.99,
      market: marketOf([
        mkCand('Portable Dog Water Bottle 800ml Leakproof', 12.98),
        mkCand('Dog Water Bottle 800ml Portable Travel Leakproof', 11.49),
        mkCand('800ml Leakproof Portable Dog Water Bottle', 12.48)
      ])
    });
    expect(r).toEqual({ estimateGbp: 12.48, confidence: 'high', sources: ['ebay.co.uk (3 matches)'] }); // median of 12.98/11.49/12.48
    expect(cached).toHaveLength(1);
  });

  it('AMBIGUOUS shortlist -> tiny title-classifier confirms -> medium confidence (never high)', async () => {
    const classifier = llmOf({ indices: [0, 1] });
    const r = await competitorSignal(classifier, storeOf([]), CFG, {
      pid: 'z2', title: '800ml Dog Water Bottle Portable Leakproof', ourRetailGbp: 12.99,
      market: marketOf([mkCand('Dog Travel Bottle Water Dispenser', 10.99), mkCand('Pet Bottle Water Feeder for Dogs', 12.49)])
    });
    expect(r?.confidence).toBe('medium');
    expect(r?.estimateGbp).toBe(11.74); // median of the confirmed pair 10.99/12.49
    expect(r?.sources?.[0]).toMatch(/llm-matched 2/);
  });

  it('market answered NOTHING comparable -> null, and the expensive legacy path is NOT taken', async () => {
    const r = await competitorSignal(neverLlm, storeOf([]), CFG, {
      pid: 'z3', title: 'Cat Water Fountain Stainless 3.2L', ourRetailGbp: 39.99,
      market: marketOf([mkCand('Garden Hose Reel 30m', 35)])
    });
    expect(r).toBeNull(); // agent's cost-plus market-of-one branch applies
  });

  it('market SOURCE failure -> legacy LLM+web fallback with results capped at 3', async () => {
    let capturedWeb: any = null;
    const legacy = {
      available: true,
      jsonChain: async (o: any) => {
        capturedWeb = o.web;
        const value = o.validate({ itemGbp: 10.99, deliveryGbp: 2.0, estimateGbp: 12.99, confidence: 'medium', sources: ['amazon.co.uk'] });
        return { ok: true, value, usage: { provider: 'openrouter', model: 't', promptTokens: 0, completionTokens: 0, costUsd: 0 } };
      }
    } as unknown as LlmClient;
    const r = await competitorSignal(legacy, storeOf([]), CFG, { pid: 'z4', title: 'X', ourRetailGbp: 9.99, market: marketOf(null) });
    expect(r?.estimateGbp).toBe(12.99);
    expect(capturedWeb).toEqual({ maxResults: 3 });
  });

  it('DEEP check bypasses the cache and the market source, and raises web results to 6', async () => {
    let capturedWeb: any = null;
    const legacy = {
      available: true,
      jsonChain: async (o: any) => {
        capturedWeb = o.web;
        const value = o.validate({ itemGbp: 20, deliveryGbp: 0, estimateGbp: 20, confidence: 'high', sources: ['argos.co.uk'] });
        return { ok: true, value, usage: { provider: 'openrouter', model: 't', promptTokens: 0, completionTokens: 0, costUsd: 0 } };
      }
    } as unknown as LlmClient;
    const store = {
      getSearchCache: async () => { throw new Error('deep must not read the cache'); },
      putSearchCache: async () => undefined,
      logLlmUsage: async () => undefined
    } as unknown as TenantStore;
    const market = { name: 'ebay.co.uk', search: async () => { throw new Error('deep must not use the structured source'); } };
    const r = await competitorSignal(legacy, store, CFG, { pid: 'z5', title: 'X', ourRetailGbp: 15, market, deep: true });
    expect(r?.estimateGbp).toBe(20);
    expect(capturedWeb).toEqual({ maxResults: 6 });
  });

  it('caps confidence at LOW when the OpenAI floor served (no web plugin = priors, not live search), and caches the capped value', async () => {
    // 2026-07-09 outage: OpenRouter credits ran out, every call fell to the
    // floor tier, and prior-based "high confidence" markets drove real drops.
    // Low = "no market data" downstream, so the floor can never archive.
    const cached: string[] = [];
    const r = await competitorSignal(
      llmOf({ itemGbp: 9.99, deliveryGbp: 2.0, estimateGbp: 11.99, confidence: 'high', sources: ['amazon.co.uk'] }, 'openai'),
      storeOf(cached), CFG, { pid: 'p3', title: 'Dog Bottle', ourRetailGbp: 15.99 }
    );
    expect(r?.confidence).toBe('low');
    expect(JSON.parse(cached[0]).confidence).toBe('low'); // the cache carries the capped signal too
  });
});
