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

import { retailPriceGbp, landedCostGbp } from './pricing';
import { LlmClient } from './llm';
import { resolveChain } from './llm-resolve';
import type { TenantStore } from './tenant-store';
import type { CjDetail } from './cj';
import type { AdminGraphql } from './shopify-admin';
import { productInventoryItems, updateVariantPrices, archiveProduct } from './proxy/inventory';
import type { Pricing, ProfitConfig, TenantConfig } from './types';
import { DEFAULT_PROFIT } from './types';

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
 * LLM + web-search estimate of the typical UK street price for a comparable
 * product. Cached per pid in search_cache. Hermetic-safe: no LLM / any failure
 * returns null (no signal is NOT a profitability failure). Only a usable
 * (estimateGbp > 0) result is cached.
 */
export async function competitorSignal(
  llm: LlmClient, store: TenantStore, cfg: TenantConfig,
  arg: { pid: string; title: string; ourRetailGbp: number }
): Promise<CompetitorSignal | null> {
  const profit = cfg.profit ?? DEFAULT_PROFIT;
  const cached = await store.getSearchCache(competitorCacheKey(arg.pid));
  if (cached) { try { return JSON.parse(cached) as CompetitorSignal; } catch { /* corrupt - re-fetch */ } }
  if (!llm.available || !cfg.llm.enabled) return null;
  const chain = resolveChain(cfg, 'text');
  const r = await llm.jsonChain<CompetitorSignal>({
    chain, maxTokens: 500, web: { maxResults: 5 },
    system:
      'You are a UK retail price researcher for a pet-care shop. Using live web search, find the typical UK DELIVERED price a normal shopper pays RIGHT NOW for a comparable product at mainstream UK retailers (Amazon.co.uk, Pets at Home, eBay UK, B&M, Argos, etc.). ' +
      'CRITICAL: the estimate must be the TOTAL a standard (non-member) buyer pays including VAT AND delivery. Only add-on membership tiers get free shipping (e.g. Amazon free next-day is Prime-only); a normal buyer usually pays postage, so add typical delivery cost to the item price. If a listing is genuinely free-delivery for everyone, use the item price alone. ' +
      'Respond with ONLY a JSON object: {"estimateGbp": <typical UK DELIVERED price incl VAT + shipping for a comparable product, or 0 if you truly cannot find one>, "confidence": <"high" when several mainstream UK listings agree, "medium" when few agree, "low" when guessing or comparables are weak>, "sources": [<up to 3 short retailer or domain names>]}.',
    user: JSON.stringify({ product: arg.title, ourPriceGbp: arg.ourRetailGbp }),
    validate: (v) => {
      const o = v as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) return null;
      const est = Number(o.estimateGbp);
      if (!Number.isFinite(est) || est < 0) return null;
      const confidence = (['high', 'medium', 'low'].includes(o.confidence as string) ? o.confidence : 'low') as CompetitorSignal['confidence'];
      const sources = Array.isArray(o.sources) ? o.sources.filter((s): s is string => typeof s === 'string').slice(0, 3) : [];
      return { estimateGbp: Math.round(est * 100) / 100, confidence, sources };
    }
  });
  if (!r.ok) { console.warn(`competitor signal failed for ${arg.pid}: ${r.error}`); return null; }
  await store.logLlmUsage('profit-competition', r.usage.model, r.usage.promptTokens, r.usage.completionTokens, r.usage.costUsd);
  if (r.value.estimateGbp > 0) await store.putSearchCache(competitorCacheKey(arg.pid), JSON.stringify(r.value), profit.cacheTtlDays);
  return r.value;
}


// --- Active agent decision (adjust-or-drop) on LIVE Shopify numbers ---

/** One sellable variant valued at its ACTUAL live Shopify price + landed cost (GBP). */
export interface LiveVariant { variantId: string; priceGbp: number; costGbp: number }

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
    if (worstAt(scale) >= floor) {
      const updates = sellable.map((v) => ({ variantId: v.variantId, toGbp: round99Down(v.priceGbp * scale) }));
      if (!updates.some((u, i) => Math.abs(u.toGbp - sellable[i].priceGbp) >= REPRICE_DEADBAND_GBP)) {
        return { kind: 'keep', reason: `already at the best price below the market (~GBP ${comp.estimateGbp.toFixed(2)} delivered), net >= GBP ${floor}` };
      }
      const dir = target > fromPrice ? 'raise' : 'lower';
      return { kind: 'reprice', updates, reason: `${dir} to GBP ${target.toFixed(2)} (just under the market ~GBP ${comp.estimateGbp.toFixed(2)} delivered), net >= GBP ${floor}/unit` };
    }
    // Can't clear the floor even at the best price below the market. Archiving is
    // the most destructive action and the competitor price is the softest input, so
    // auto-drop needs HARD evidence: only a HIGH-confidence market triggers it. A
    // medium-confidence low estimate is flagged for the owner, never auto-archived
    // (a reprice above is recoverable; an archive effectively is not).
    if (comp.confidence === 'high') {
      return { kind: 'drop', reason: `cannot clear GBP ${floor} net even at the best price below the market (~GBP ${comp.estimateGbp.toFixed(2)} delivered)` };
    }
    return { kind: 'flag', reason: `cannot clear GBP ${floor} net below the market (~GBP ${comp.estimateGbp.toFixed(2)} delivered, ${comp.confidence} confidence) - your call before archiving` };
  }

  // No defensible market price -> cannot safely reprice (never guess a price).
  if (worstNow < 0) return { kind: 'drop', reason: 'loses money at its current price and there is no market data to reprice from' };
  if (worstNow < floor) return { kind: 'flag', reason: `below the GBP ${floor} net target and no market price to safely reprice - your call` };
  return { kind: 'keep', reason: `net >= GBP ${floor}/unit at its current price` };
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
export async function runProfitAgent(
  store: TenantStore, admin: AdminGraphql, llm: LlmClient, cfg: TenantConfig,
  opts: { offset?: number; limit?: number } = {}
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
    const pid = link.shopify_product_id as string;
    try {
      // Snapshot the stored state BEFORE any write, so the ledger can skip
      // re-logging an identical mutation on every tick (dry-run re-previews the
      // same reprice each pass; steady-state repeats the same target).
      const prev = await store.getProfitVerdict(link.cj_pid);

      const inv = await productInventoryItems(admin, pid);
      const sellable = inv
        .map((v) => ({ variantId: v.variantId, priceGbp: Number(v.price), costGbp: Number(v.cost) }))
        .filter((v) => Number.isFinite(v.priceGbp) && v.priceGbp > 0 && Number.isFinite(v.costGbp) && v.costGbp > 0);

      if (!sellable.length) {
        // Nothing sellable + costed to judge - record it was seen, act on nothing.
        await store.upsertProfitVerdict({
          cjPid: link.cj_pid, verdict: 'pass', netGbp: null, netPct: null, ourRetailGbp: null,
          competitorGbp: null, competitorConfidence: null, competitorSources: null,
          reason: 'no live price/cost to judge', action: 'keep', fromGbp: null, toGbp: null, dryRun,
        });
        continue;
      }

      const fromPrice = Math.min(...sellable.map((v) => v.priceGbp));
      const costByVid = new Map(sellable.map((v) => [v.variantId, v.costGbp]));

      // Title for the market lookup (competitorSignal ignores it on a cache hit).
      let title = link.cj_pid;
      try {
        const wh = await store.getWarehouseProduct(link.cj_pid);
        if (wh) { const d = JSON.parse(wh.detail) as CjDetail; if (d.nameEn) title = d.nameEn; }
      } catch { /* fall back to the pid */ }

      const signal = await competitorSignal(llm, store, cfg, { pid: link.cj_pid, title, ourRetailGbp: fromPrice });
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
        repriced++;
      } else if (action.kind === 'drop') {
        if (!dryRun) { await archiveProduct(admin, pid); await store.putLink({ cjPid: link.cj_pid, state: 'archived' }); }
        dropped++;
      } else if (action.kind === 'flag') {
        flagged++;
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
    } catch (e) { console.warn(`profit agent failed for ${link.cj_pid}: ${(e as Error).message}`); }
  }

  return { scanned, acted: repriced + dropped, repriced, dropped, flagged, total, next: offset + limit < total ? offset + limit : null, dryRun };
}
