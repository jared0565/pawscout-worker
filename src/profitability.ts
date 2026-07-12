// src/profitability.ts
//
// The profitability engine: is a product there to make REAL net profit? One
// deterministic core (net after ALL costs incl. ads) plus a soft LLM+web
// competitor signal. Consumers: the import gate (preventive, in confirmAndImport)
// and the ACTIVE agent `runProfitAgent` (continuous, on the 15-min cron) which
// values each product on its LIVE Shopify price+cost and adjusts-or-drops per the
// owner's rule (decideProfitAction). Ships DORMANT - every entry point no-ops
// unless cfg.profit.enabled. Specs: 2026-07-09-profitability-agent-active.md
// (active) supersedes 2026-07-09-profitability-engine-design.md (observe-first).

import { retailPriceGbp, landedCostGbp, costPlusPriceGbp } from './pricing';
import { LlmClient } from './llm';
import { resolveChain } from './llm-resolve';
import type { TenantStore } from './tenant-store';
import type { CjDetail } from './cj';
import type { AdminGraphql } from './shopify-admin';
import { productInventoryItems, updateVariantPrices, archiveProduct } from './proxy/inventory';
import type { Pricing, ProfitConfig, TenantConfig } from './types';
import { DEFAULT_PROFIT } from './types';
import { buildMarketQuery, matchCandidates, credibleMinGbp } from './market';
import type { MarketSource, MarketCandidate } from './market';

function round2(x: number): number { return Math.round(x * 100) / 100; }

/**
 * Blended affiliate commission per unit: commission is only paid on the SHARE of
 * sales that come through an affiliate link, so it is a fractional expense like
 * ad spend. commission on ex-VAT revenue + platform fee on gross, scaled by the
 * affiliate sales share. Matches the affiliate-eligibility floor's rate model.
 */
function affiliateCostGbp(priceGbp: number, exVatGbp: number, p: ProfitConfig): number {
  return p.affiliateSalesShare * (p.affiliateCommissionRate * exVatGbp + p.affiliatePlatformFeeRate * priceGbp);
}

// --- Deterministic net-after-ads (no LLM) ---

export interface NetAfterAds {
  retailGbp: number; cogsGbp: number; adCostGbp: number; netGbp: number; netPct: number;
}

/**
 * Per-unit net profit after ALL costs at the product's rule price. Ad spend is
 * 0.33 x GROSS retail (ROAS 3 - the sizing the pricing multiplier assumes);
 * payments on gross, refund reserve on ex-VAT revenue. Uses the LIVE pricing
 * rule passed in, NEVER a default. Purely deterministic.
 */
export function netAfterAdsGbp(landedUsd: number, freightUsd: number, pricing: Pricing, profit: ProfitConfig): NetAfterAds {
  const retailGbp = retailPriceGbp(landedUsd, pricing, freightUsd);
  const cogsGbp = landedCostGbp(landedUsd, pricing, freightUsd); // already 2dp
  const exVatRevenue = retailGbp / (1 + profit.vatRate);
  // Round each cost component so the console breakdown reconciles to net.
  const adCostGbp = round2(profit.adShareOfRevenue * retailGbp);
  const paymentsFee = round2(profit.paymentsFeeRate * retailGbp);
  const refundReserve = round2(profit.refundReserveRate * exVatRevenue);
  const affiliateFee = round2(affiliateCostGbp(retailGbp, exVatRevenue, profit));
  const discountCost = round2(profit.expectedDiscountRate * retailGbp);
  const overhead = round2(profit.fixedOverheadRate * retailGbp);
  const netGbp = round2(exVatRevenue - cogsGbp - adCostGbp - paymentsFee - refundReserve - affiliateFee - discountCost - overhead);
  return {
    retailGbp,
    cogsGbp,
    adCostGbp,
    netGbp,
    netPct: exVatRevenue > 0 ? netGbp / exVatRevenue : 0,
  };
}

export interface ProductNet {
  worstNetGbp: number;   // net of the WORST sellable variant (the pass/fail decider)
  worstNetPct: number;
  belowFloor: boolean;   // worst variant fails the GBP OR the % floor
  fromRetailGbp: number; // min sticker across variants (the card price; competitor compares to this)
}

/**
 * Product-level input to the verdict, mirroring productAffiliateEligible's
 * variant policy: EVERY sellable variant is evaluated and the product is judged
 * on its WORST one ("one thin variant disqualifies the whole product"). Returns
 * null when no variant has a usable cost.
 */
export function productNetAfterAds(
  variants: { sellPriceUsd: number }[], pricing: Pricing, freightUsd: number | undefined, profit: ProfitConfig
): ProductNet | null {
  const sellable = variants.filter((v) => Number.isFinite(v.sellPriceUsd) && v.sellPriceUsd > 0);
  if (!sellable.length) return null;
  const freight = freightUsd ?? 0;
  let worst: NetAfterAds | null = null;
  let fromRetail = Infinity;
  for (const v of sellable) {
    const n = netAfterAdsGbp(v.sellPriceUsd, freight, pricing, profit);
    if (!worst || n.netGbp < worst.netGbp) worst = n;
    if (n.retailGbp < fromRetail) fromRetail = n.retailGbp;
  }
  const belowFloor = worst!.netGbp < profit.minNetAfterAdsGbp || worst!.netPct < profit.minNetMarginPct;
  return { worstNetGbp: worst!.netGbp, worstNetPct: worst!.netPct, belowFloor, fromRetailGbp: round2(fromRetail) };
}

// --- Competitor signal (LLM + web search, cached, hermetic-safe) ---

export interface CompetitorSignal { estimateGbp: number; confidence: 'high' | 'medium' | 'low'; sources: string[] }

export function competitorCacheKey(pid: string): string { return `comp:${pid}`; }

/**
 * Tiny LLM title-classifier for AMBIGUOUS structured shortlists: which of these
 * eBay titles are the same kind of product as ours? ~1k tokens of TITLES, never
 * page content. Returns the confirmed candidates ([] on any failure).
 */
async function classifyShortlist(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  ourTitle: string, shortlist: MarketCandidate[]
): Promise<MarketCandidate[]> {
  if (!llm.available || !cfg.llm.enabled) return [];
  const chain = resolveChain(cfg, 'text');
  const r = await llm.jsonChain<{ indices: number[] }>({
    chain, maxTokens: 120,
    system:
      'You match retail listings. Given OUR product title and a numbered list of marketplace listing titles with delivered prices, ' +
      'return the indices of listings that are genuinely the SAME KIND of product a shopper would consider interchangeable with ours (same product type, compatible size/quantity). ' +
      'Exclude parts, accessories-for, multipacks of a different count, and different product types. ' +
      'Respond with ONLY JSON: {"indices": [<0-based indices, may be empty>]}.',
    user: JSON.stringify({ ours: ourTitle, listings: shortlist.map((c, i) => ({ i, title: c.title, deliveredGbp: c.deliveredGbp })) }),
    validate: (v) => {
      const arr = (v as { indices?: unknown })?.indices;
      if (!Array.isArray(arr)) return null;
      const idx = [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < shortlist.length))];
      return { indices: idx };
    }
  });
  if (!r.ok) { console.warn(`market shortlist classify failed: ${r.error}`); return []; }
  await store.logLlmUsage('profit-competition-match', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  return r.value.indices.map((i) => shortlist[i]);
}

/**
 * Competitor DELIVERED-price signal, hybrid (2026-07-10):
 *   1. cache (14d)
 *   2. STRUCTURED: eBay Browse candidates + deterministic matching - zero LLM
 *   3. ambiguous shortlist -> tiny LLM title-classifier (~1k tokens)
 *   4. eBay answered "nothing comparable" -> null (the agent's cost-plus
 *      market-of-one branch; the console Deep check button exists for a manual
 *      full web read)
 *   5. no market source configured, or the source ERRORED -> legacy LLM+web
 *      path (web results capped at 3; `deep` raises it to 6 and skips the
 *      cache read - the manual Deep check)
 * Hermetic-safe: any failure returns null. Only a usable (estimateGbp > 0)
 * result is cached.
 */
export async function competitorSignal(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  arg: { pid: string; title: string; ourRetailGbp: number; market?: MarketSource | null; deep?: boolean }
): Promise<CompetitorSignal | null> {
  const profit = cfg.profit ?? DEFAULT_PROFIT;
  if (!arg.deep) {
    const cached = await store.getSearchCache(competitorCacheKey(arg.pid));
    if (cached) { try { return JSON.parse(cached) as CompetitorSignal; } catch { /* corrupt - re-fetch */ } }
  }

  if (arg.market && !arg.deep) {
    const candidates = await arg.market.search(buildMarketQuery(arg.title));
    if (candidates !== null) {
      const m = matchCandidates(arg.title, arg.ourRetailGbp, candidates);
      if (m.kind === 'match') {
        const signal: CompetitorSignal = {
          estimateGbp: m.estimateGbp, confidence: m.confidence,
          sources: [`${arg.market.name} (${m.matched} matches)`]
        };
        await store.putSearchCache(competitorCacheKey(arg.pid), JSON.stringify(signal), profit.cacheTtlDays);
        return signal;
      }
      if (m.kind === 'ambiguous') {
        const confirmed = await classifyShortlist(llm, store, cfg, arg.title, m.shortlist);
        if (confirmed.length >= 2) {
          const signal: CompetitorSignal = {
            estimateGbp: Math.round(credibleMinGbp(confirmed.map((c) => c.deliveredGbp)) * 100) / 100,
            confidence: 'medium', // classifier-assisted never claims high
            sources: [`${arg.market.name} (llm-matched ${confirmed.length})`]
          };
          await store.putSearchCache(competitorCacheKey(arg.pid), JSON.stringify(signal), profit.cacheTtlDays);
          return signal;
        }
      }
      // The source ANSWERED and nothing comparable survived: no market data.
      // Deliberately no legacy fallback here - that path costs ~200k tokens and
      // the agent's no-market branch (cost-plus) is the owner-approved behavior.
      return null;
    }
    // candidates === null: the SOURCE failed (auth/network) - fall through to legacy.
  }

  if (!llm.available || !cfg.llm.enabled) return null;
  const chain = resolveChain(cfg, 'text');
  const r = await llm.jsonChain<CompetitorSignal>({
    chain, maxTokens: 500, web: { maxResults: arg.deep ? 6 : 3 },
    system:
      'You are a UK retail price researcher for a pet-care shop. Using live web search, find the typical UK DELIVERED price a normal shopper pays RIGHT NOW for a comparable product at mainstream UK retailers (Amazon.co.uk, Pets at Home, eBay UK, B&M, Argos, etc.). ' +
      'Work in two parts so delivery is never missed: FIRST the ITEM price of the closest comparable current listing, THEN that same listing\'s actual DELIVERY charge for a standard (non-member) buyer. Membership-only free shipping does NOT count (e.g. Amazon free next-day is Prime-only; a normal buyer pays the postage shown below the price). Report delivery 0 only when the listing is genuinely free-delivery for every buyer. ' +
      'Respond with ONLY a JSON object: {"itemGbp": <item price incl VAT of the closest comparable listing, or 0 if you truly cannot find one>, "deliveryGbp": <that listing\'s delivery charge for a standard buyer, 0 only when free for everyone>, "estimateGbp": <itemGbp + deliveryGbp>, "confidence": <"high" when several mainstream UK listings agree, "medium" when few agree, "low" when guessing or comparables are weak>, "sources": [<up to 3 short retailer or domain names>]}.',
    user: JSON.stringify({ product: arg.title, ourPriceGbp: arg.ourRetailGbp }),
    validate: (v) => {
      const o = v as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return null;
      // The split fields are the primary signal: summing item + delivery forces
      // the model to price postage explicitly (the 2026-07-10 audit's under-read
      // failure mode was a missed delivery line: GBP 14.99 stored vs GBP 17.98
      // real delivered). estimateGbp alone remains the fallback.
      const item = Number(o.itemGbp);
      const delivery = Number(o.deliveryGbp);
      let est = Number(o.estimateGbp);
      if (Number.isFinite(item) && item > 0 && Number.isFinite(delivery) && delivery >= 0) est = item + delivery;
      if (!Number.isFinite(est) || est < 0) return null;
      const confidence = (['high', 'medium', 'low'].includes(o.confidence as string) ? o.confidence : 'low') as CompetitorSignal['confidence'];
      const sources = Array.isArray(o.sources) ? o.sources.filter((s): s is string => typeof s === 'string').slice(0, 3) : [];
      return { estimateGbp: Math.round(est * 100) / 100, confidence, sources };
    }
  });
  if (!r.ok) { console.warn(`competitor signal failed for ${arg.pid}: ${r.error}`); return null; }
  await store.logLlmUsage('profit-competition', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  // Provenance guard (2026-07-09 outage lesson): the web plugin exists only on
  // the OpenRouter tier. When the OpenAI floor served this call, the "market"
  // is model priors, not live search - cap confidence at low, which the
  // decision policy already treats as NO market data (cost-plus pricing, never
  // a market-driven drop). The floor must never archive a product on a
  // remembered price.
  const value: CompetitorSignal = r.usage.provider === 'openai' ? { ...r.value, confidence: 'low' } : r.value;
  if (value.estimateGbp > 0) await store.putSearchCache(competitorCacheKey(arg.pid), JSON.stringify(value), profit.cacheTtlDays);
  return value;
}


// --- Active agent decision (adjust-or-drop) on LIVE Shopify numbers ---

/** One sellable variant valued at its ACTUAL live Shopify price + landed cost (GBP).
 *  `rulePriceGbp` is our defensible cost-plus shelf price (costPlusPriceGbp on the
 *  live cost) - the "market of one" the agent reprices to when NO competitor exists.
 *  Optional so the decision stays pure/testable; the runner always supplies it. */
export interface LiveVariant { variantId: string; priceGbp: number; costGbp: number; rulePriceGbp?: number }

/** What the agent decides to do with a product. `reprice` only ever LOWERS. */
export type ProfitAction =
  | { kind: 'keep'; reason: string }
  | { kind: 'reprice'; updates: { variantId: string; toGbp: number }[]; reason: string }
  | { kind: 'drop'; reason: string }
  | { kind: 'flag'; reason: string };

/** Per-unit net after ads at a GIVEN live price + cost (no rule price - real numbers). */
export function liveNetGbp(priceGbp: number, costGbp: number, p: ProfitConfig): number {
  const exVat = priceGbp / (1 + p.vatRate);
  return exVat - costGbp - p.adShareOfRevenue * priceGbp - p.paymentsFeeRate * priceGbp - p.refundReserveRate * exVat - affiliateCostGbp(priceGbp, exVat, p) - p.expectedDiscountRate * priceGbp - p.fixedOverheadRate * priceGbp;
}

/** Nearest .99 ending at or BELOW x, so a competitive reprice never lands above the market. */
export function round99Down(x: number): number {
  const up = Math.ceil(x) - 0.01;
  const cand = up <= x + 1e-9 ? up : Math.floor(x) - 0.01;
  return Math.max(0.99, Math.round(cand * 100) / 100);
}

/**
 * The price to aim for below a competitor's DELIVERED price: undercut by
 * `undercutPct` (so we win as the cheaper newcomer, not by a penny), rounded to
 * the nearest .99, and CLAMPED to always sit strictly below the competitor.
 * e.g. GBP25 competitor at 5% -> GBP23.99.
 */
export function undercutTarget(competitorGbp: number, undercutPct: number): number {
  const raw = competitorGbp * (1 - Math.max(0, undercutPct));
  let t = Math.round((raw - 0.99) ) + 0.99;      // nearest .99 to the undercut price
  t = Math.round(t * 100) / 100;
  if (t >= competitorGbp) t = round99Down(competitorGbp); // never at/above the market
  return Math.max(0.99, t);
}

const REPRICE_DEADBAND_GBP = 0.5; // ignore churny sub-50p moves on the from-price

/**
 * The owner's governing rule as a pure function (2026-07-09): every kept product
 * must net >= the floor (GBP2), with NO upper cap; price it as HIGH as possible
 * while staying strictly below the competitor's DELIVERED price (item + shipping)
 * so we are the cheapest AND make the most margin - so it auto-RAISES as readily
 * as it lowers. If it cannot clear the floor even at the best sub-market price ->
 * drop. All from defensible values (live cost, live price, real competitor price).
 * Judged on the WORST sellable variant; competitor counts only at high/medium
 * confidence (low = no market data). See 2026-07-09-profitability-agent-active.md.
 */
export function decideProfitAction(input: {
  variants: LiveVariant[];
  competitor: { estimateGbp: number; confidence: 'high' | 'medium' | 'low' } | null;
  profit: ProfitConfig;
}): ProfitAction {
  const p = input.profit;
  const floor = p.minNetAfterAdsGbp;
  const sellable = input.variants.filter((v) => v.priceGbp > 0 && v.costGbp > 0);
  if (!sellable.length) return { kind: 'keep', reason: 'no live price/cost data to judge' };

  const fromPrice = Math.min(...sellable.map((v) => v.priceGbp));
  const worstNow = Math.min(...sellable.map((v) => liveNetGbp(v.priceGbp, v.costGbp, p)));
  // Low-confidence market estimate is noise: treat it as no data (owner's rule).
  const comp = input.competitor && input.competitor.estimateGbp > 0
    && (input.competitor.confidence === 'high' || input.competitor.confidence === 'medium')
    ? input.competitor : null;
  const worstAt = (scale: number) => Math.min(...sellable.map((v) => liveNetGbp(v.priceGbp * scale, v.costGbp, p)));

  if (comp) {
    // Undercut the competitor's delivered price by undercutPct (win as the cheaper
    // newcomer, not by a penny). Scale the whole product so the from-price hits
    // that target (raises when we are below the market, lowers when above).
    const target = undercutTarget(comp.estimateGbp, p.undercutPct);
    const scale = target / fromPrice;
    const netAtBest = worstAt(scale); // net at the best (highest) price we can hold below the market
    if (netAtBest >= floor) {
      const updates = sellable.map((v) => ({ variantId: v.variantId, toGbp: round99Down(v.priceGbp * scale) }));
      if (!updates.some((u, i) => Math.abs(u.toGbp - sellable[i].priceGbp) >= REPRICE_DEADBAND_GBP)) {
        return { kind: 'keep', reason: `already at the best price below the market (~GBP ${comp.estimateGbp.toFixed(2)} delivered), net >= GBP ${floor}` };
      }
      const dir = target > fromPrice ? 'raise' : 'lower';
      return { kind: 'reprice', updates, reason: `${dir} to GBP ${target.toFixed(2)} (just under the market ~GBP ${comp.estimateGbp.toFixed(2)} delivered), net >= GBP ${floor}/unit` };
    }
    // Cannot clear the floor even at the best price below the market. Drop (archive)
    // is the most destructive, least reversible action, so it is reserved for a
    // defensible LOSS, never a merely thin margin: a product that still makes money,
    // just under the floor, is a money-maker we must not auto-destroy (owner's rule).
    //
    // The two branches deliberately use DIFFERENT loss tests. HERE a real competitor
    // bounds the price, so "loss" is the FULL-STACK net (liveNetGbp, ad share
    // included) going negative: a high-confidence market this low means we cannot
    // sit under it without selling below our all-in cost. The no-competitor branch
    // below has no market to lean on and cannot assume the tunable ad share, so it
    // uses the assumption-free below-landed-cost test instead. (Raising ad share
    // pushes more products into net < 0 here, widening the auto-drop set - the
    // console re-preview is the safety valve before going live.)
    if (netAtBest < 0) {
      // To sit under the market we would have to sell at a loss - the owner's drop
      // trigger. Only a HIGH-confidence market auto-archives; a medium-confidence
      // loss is the owner's call (a reprice is recoverable, an archive is not).
      if (comp.confidence === 'high') {
        return { kind: 'drop', reason: `to price under the market (~GBP ${comp.estimateGbp.toFixed(2)} delivered) we would sell at a loss (net ~GBP ${netAtBest.toFixed(2)}/unit) - a clear loss` };
      }
      return { kind: 'flag', reason: `would sell at a loss to sit under the market (~GBP ${comp.estimateGbp.toFixed(2)} delivered, ${comp.confidence} confidence) - your call before archiving` };
    }
    // Profitable but under the floor at its best price below the market: it still
    // MAKES money, just not the full GBP ${floor}, so it is never auto-archived. Flag
    // it for the owner. The reason carries BOTH the current net and the best-price
    // net so it reconciles with the current-price net shown on the row.
    return { kind: 'flag', reason: `currently nets ~GBP ${worstNow.toFixed(2)}/unit; at its best price below the market (~GBP ${comp.estimateGbp.toFixed(2)} delivered) ~GBP ${netAtBest.toFixed(2)}/unit, under the GBP ${floor} target - your call` };
  }

  // No defensible market price. A DROP here must be a defensible loss that does NOT
  // depend on the tunable ad-share assumption: the item sells BELOW LANDED COST
  // (revenue ex-VAT < cost), i.e. the shop loses money on the product itself.
  const worstGrossExVat = Math.min(...sellable.map((v) => v.priceGbp / (1 + p.vatRate) - v.costGbp));
  if (worstGrossExVat < 0) return { kind: 'drop', reason: 'sells below landed cost (loses money on the item itself) and there is no market data to reprice from' };

  // Already profitable at its current price -> KEEP. We do not lower a working price
  // with no evidence it is above market ("no competitor found" is ambiguous - it can
  // mean we are the only seller as easily as an unmatched search), and we never
  // speculate a raise above the current price when it is already clearing the floor.
  if (worstNow >= floor) return { kind: 'keep', reason: `net >= GBP ${floor}/unit at its current price (no market data)` };

  // Thin (below the floor) with no market price. Price it to our DEFENSIBLE cost-plus
  // rule (the "market of one" = our standard markup on the real live cost) and keep it
  // live - the owner's rule: with no competitor, compute the defensible shelf price
  // rather than freezing or flagging. The raise is CAPPED at the rule (never speculate
  // a premium above our own markup without a competitor signal the market bears more).
  // Because net rises monotonically with price, clearing the floor at the rule means
  // the rule sits above the current thin price, so this only ever RAISES.
  const rules = sellable.map((v) => v.rulePriceGbp);
  if (rules.every((r) => typeof r === 'number' && (r as number) > 0)) {
    const worstAtRule = Math.min(...sellable.map((v) => liveNetGbp(v.rulePriceGbp as number, v.costGbp, p)));
    if (worstAtRule >= floor) {
      const updates = sellable.map((v) => ({ variantId: v.variantId, toGbp: v.rulePriceGbp as number }));
      if (!updates.some((u, i) => Math.abs(u.toGbp - sellable[i].priceGbp) >= REPRICE_DEADBAND_GBP)) {
        return { kind: 'keep', reason: `already at our cost-plus price, net >= GBP ${floor}/unit (no market data)` };
      }
      const target = Math.min(...updates.map((u) => u.toGbp));
      return { kind: 'reprice', updates, reason: `raise to our cost-plus price GBP ${target.toFixed(2)} (no market data - our standard markup on real cost), net >= GBP ${floor}/unit` };
    }
  }

  // Even our standard markup cannot lift it to the floor (or no cost-plus price is
  // available): a genuine human call, never an auto-archive on soft/no data.
  return { kind: 'flag', reason: `below the GBP ${floor} net target and even our standard markup can't clear it - your call` };
}

// --- Active agent (adjust-or-drop on LIVE Shopify numbers) ---

/**
 * The ACTIVE profitability agent (2026-07-09). Walk imported products, value each
 * on its LIVE Shopify price + landed cost (`productInventoryItems`, not a stale
 * admission cost or the rule price), research the market (cached competitor
 * DELIVERED price), and ACT per `decideProfitAction`: raise/lower to just under the
 * market, or drop a clear loss - executing on defensible data, no approval gate.
 *
 * `dryRun` (default true on first enable) computes and RECORDS every intended
 * action WITHOUT touching prices/listings, so the owner previews full-auto. It is
 * the SOLE writer of product_profit (supersedes the observe audit) and the ledger.
 * Rolling: returns `next` for the 15-min cron to checkpoint. No-ops when disabled.
 * Never throws out of the per-product loop (one bad product can't stall the sweep).
 */
/**
 * Judge and (unless dryRun) act on ONE imported link - the agent loop's body,
 * extracted so the console's per-product Deep check can re-judge immediately
 * instead of waiting for the sweep to come round. `signalOverride` skips the
 * market lookup and judges against the given signal (the deep path researches
 * first, then judges once). Throws on Shopify/API errors (callers catch).
 */
export async function judgeImportedLink(
  store: TenantStore, admin: AdminGraphql, llm: LlmClient, cfg: TenantConfig,
  link: { cj_pid: string; shopify_product_id: string; profit_keep?: number | null }, dryRun: boolean,
  opts: { market?: MarketSource | null; signalOverride?: CompetitorSignal | null } = {}
): Promise<{ action: 'keep' | 'reprice' | 'drop' | 'flag'; reason: string; signal: CompetitorSignal | null }> {
  const profit = cfg.profit as ProfitConfig;
  const pid = link.shopify_product_id;

  // Snapshot the stored state BEFORE any write, so the ledger can skip
  // re-logging an identical mutation on every tick (dry-run re-previews the
  // same reprice each pass; steady-state repeats the same target).
  const prev = await store.getProfitVerdict(link.cj_pid);

  // Owner "Keep" override (2026-07-12): the owner has reviewed this product and
  // wants it left exactly as it is. Short-circuit BEFORE any Shopify read or
  // market spend - verdict pass, action keep, the prior economics carried
  // through so the row still shows its numbers. Released rows re-judge normally.
  if ((link.profit_keep ?? 0) === 1) {
    const reason = 'kept by owner - the agent will not reprice, flag or drop this product (Release on the row resumes judging)';
    let prevSources: string[] | null = null;
    if (prev?.competitor_sources) {
      try { const a = JSON.parse(prev.competitor_sources); if (Array.isArray(a)) prevSources = a.map(String); } catch { /* keep null */ }
    }
    await store.upsertProfitVerdict({
      cjPid: link.cj_pid, verdict: 'pass', netGbp: prev?.net_gbp ?? null, netPct: prev?.net_pct ?? null,
      ourRetailGbp: prev?.our_retail_gbp ?? null, competitorGbp: prev?.competitor_gbp ?? null,
      competitorConfidence: prev?.competitor_confidence ?? null, competitorSources: prevSources,
      reason, action: 'keep', fromGbp: null, toGbp: null, dryRun,
    });
    return { action: 'keep', reason, signal: null };
  }

  const inv = await productInventoryItems(admin, pid);
  const sellable = inv
    .map((v) => ({ variantId: v.variantId, priceGbp: Number(v.price), costGbp: Number(v.cost) }))
    .filter((v) => Number.isFinite(v.priceGbp) && v.priceGbp > 0 && Number.isFinite(v.costGbp) && v.costGbp > 0)
    // Defensible cost-plus price from the LIVE cost - the reprice target when no
    // competitor is found (decideProfitAction's no-market-data branch).
    .map((v) => ({ ...v, rulePriceGbp: costPlusPriceGbp(v.costGbp, cfg.pricing) }));

  if (!sellable.length) {
    // Nothing sellable + costed to judge - record it was seen, act on nothing.
    await store.upsertProfitVerdict({
      cjPid: link.cj_pid, verdict: 'pass', netGbp: null, netPct: null, ourRetailGbp: null,
      competitorGbp: null, competitorConfidence: null, competitorSources: null,
      reason: 'no live price/cost to judge', action: 'keep', fromGbp: null, toGbp: null, dryRun,
    });
    return { action: 'keep', reason: 'no live price/cost to judge', signal: null };
  }

  const fromPrice = Math.min(...sellable.map((v) => v.priceGbp));
  const costByVid = new Map(sellable.map((v) => [v.variantId, v.costGbp]));

  // Title for the market lookup (competitorSignal ignores it on a cache hit).
  let title = link.cj_pid;
  try {
    const wh = await store.getWarehouseProduct(link.cj_pid);
    if (wh) { const d = JSON.parse(wh.detail) as CjDetail; if (d.nameEn) title = d.nameEn; }
  } catch { /* fall back to the pid */ }

  const signal = opts.signalOverride !== undefined
    ? opts.signalOverride
    : await competitorSignal(llm, store, cfg, { pid: link.cj_pid, title, ourRetailGbp: fromPrice, market: opts.market });
  const competitor = signal && signal.estimateGbp > 0 ? { estimateGbp: signal.estimateGbp, confidence: signal.confidence } : null;
  const action = decideProfitAction({ variants: sellable, competitor, profit });

  // Reported net + our price + verdict, from the decided action.
  let toGbp: number | null = null;
  let reportNet = Math.min(...sellable.map((v) => liveNetGbp(v.priceGbp, v.costGbp, profit)));
  if (action.kind === 'reprice') {
    toGbp = Math.min(...action.updates.map((u) => u.toGbp));
    reportNet = Math.min(...action.updates.map((u) => liveNetGbp(u.toGbp, costByVid.get(u.variantId) ?? 0, profit)));
  }
  const ourPrice = action.kind === 'reprice' ? (toGbp as number) : fromPrice;
  const exVat = ourPrice / (1 + profit.vatRate);
  const verdict = action.kind === 'drop' ? 'reject' : action.kind === 'flag' ? 'review' : 'pass';

  // EXECUTE (live only). Dry-run still counts what it WOULD do.
  if (action.kind === 'reprice') {
    if (!dryRun) await updateVariantPrices(admin, pid, action.updates.map((u) => ({ id: u.variantId, price: u.toGbp.toFixed(2) })));
  } else if (action.kind === 'drop') {
    if (!dryRun) { await archiveProduct(admin, pid); await store.putLink({ cjPid: link.cj_pid, state: 'archived' }); }
  }

  // Persist current state (always).
  await store.upsertProfitVerdict({
    cjPid: link.cj_pid, verdict, netGbp: round2(reportNet), netPct: exVat > 0 ? round2(reportNet / exVat) : null,
    ourRetailGbp: round2(ourPrice), competitorGbp: signal?.estimateGbp ?? null, competitorConfidence: signal?.confidence ?? null,
    competitorSources: signal?.sources ?? null, reason: action.reason, action: action.kind,
    fromGbp: action.kind === 'reprice' ? round2(fromPrice) : null, toGbp: toGbp === null ? null : round2(toGbp), dryRun,
  });

  // Ledger: record only real mutations (reprice/drop), deduped against the
  // pre-write snapshot so a re-preview / steady-state repeat is not re-logged.
  if (action.kind === 'reprice' || action.kind === 'drop') {
    const sig = (a: string | null | undefined, to: number | null | undefined, dr: number | null | undefined) =>
      `${a ?? ''}|${to == null ? '' : Number(to).toFixed(2)}|${dr ?? ''}`;
    const cur = sig(action.kind, toGbp, dryRun ? 1 : 0);
    const before = prev ? sig(prev.action, prev.to_gbp, prev.dry_run) : '';
    if (cur !== before) {
      await store.logProfitAction({
        cjPid: link.cj_pid, action: action.kind, fromGbp: action.kind === 'reprice' ? round2(fromPrice) : null,
        toGbp: toGbp === null ? null : round2(toGbp), competitorGbp: signal?.estimateGbp ?? null,
        competitorConfidence: signal?.confidence ?? null, reason: action.reason, dryRun,
      });
    }
  }

  return { action: action.kind, reason: action.reason, signal };
}

export async function runProfitAgent(
  store: TenantStore, admin: AdminGraphql, llm: LlmClient, cfg: TenantConfig,
  opts: { offset?: number; limit?: number; market?: MarketSource | null } = {}
): Promise<{ scanned: number; acted: number; repriced: number; dropped: number; flagged: number; total: number; next: number | null; dryRun: boolean }> {
  const profit = cfg.profit;
  const dryRun = profit?.dryRun !== false; // preview unless explicitly cleared to false
  if (!profit?.enabled) return { scanned: 0, acted: 0, repriced: 0, dropped: 0, flagged: 0, total: 0, next: null, dryRun };
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = opts.limit ?? 8;
  const all = (await store.listImportedLinks(500)).filter((l) => l.shopify_product_id);
  const total = all.length;
  const links = all.slice(offset, offset + limit);
  let scanned = 0, repriced = 0, dropped = 0, flagged = 0;

  for (const link of links) {
    scanned++;
    try {
      const r = await judgeImportedLink(
        store, admin, llm, cfg,
        { cj_pid: link.cj_pid, shopify_product_id: link.shopify_product_id as string, profit_keep: link.profit_keep },
        dryRun, { market: opts.market }
      );
      if (r.action === 'reprice') repriced++;
      else if (r.action === 'drop') dropped++;
      else if (r.action === 'flag') flagged++;
    } catch (e) { console.warn(`profit agent failed for ${link.cj_pid}: ${(e as Error).message}`); }
  }

  return { scanned, acted: repriced + dropped, repriced, dropped, flagged, total, next: offset + limit < total ? offset + limit : null, dryRun };
}
