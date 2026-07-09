// src/profitability.ts
//
// The profitability engine: is a product there to make REAL net profit? One
// deterministic core (net after ALL costs incl. ads, at the live pricing rule)
// plus a soft LLM+web competitor signal, combined into a pass/review/reject
// verdict. Two consumers use it: the import gate (preventive, in confirmAndImport)
// and the nightly audit agent (continuous, observe-first). Ships DORMANT - every
// entry point no-ops unless cfg.profit.enabled. See docs/superpowers/specs/
// 2026-07-09-profitability-engine-design.md.

import { retailPriceGbp, landedCostGbp } from './pricing';
import { LlmClient } from './llm';
import { resolveChain } from './llm-resolve';
import type { TenantStore } from './tenant-store';
import type { CjDetail } from './cj';
import type { Pricing, ProfitConfig, TenantConfig } from './types';
import { DEFAULT_PROFIT } from './types';

function round2(x: number): number { return Math.round(x * 100) / 100; }

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
  const netGbp = round2(exVatRevenue - cogsGbp - adCostGbp - paymentsFee - refundReserve);
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
export type Verdict = 'pass' | 'review' | 'reject';

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
      'You are a UK retail price researcher for a pet-care shop. Using live web search, find the typical UK retail price (GBP, including VAT) that comparable products sell for RIGHT NOW at mainstream UK retailers (Amazon.co.uk, Pets at Home, eBay UK, B&M, Argos, etc.). ' +
      'Respond with ONLY a JSON object: {"estimateGbp": <typical UK street price incl VAT for a comparable product, or 0 if you truly cannot find one>, "confidence": <"high" when several mainstream UK listings agree, "medium" when few agree, "low" when guessing or comparables are weak>, "sources": [<up to 3 short retailer or domain names>]}.',
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

/**
 * Combine the deterministic net + the (soft) competitor signal into a verdict.
 * REJECT only on the deterministic floor breach OR a HIGH-confidence competitor
 * undercut beyond tolerance. A medium/low-confidence undercut is REVIEW. Else PASS.
 */
export function profitVerdict(arg: { net: ProductNet; competitor: CompetitorSignal | null; profit: ProfitConfig }): { verdict: Verdict; reason: string } {
  const { net, competitor, profit } = arg;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (net.belowFloor) {
    return { verdict: 'reject', reason: `net after ads GBP ${net.worstNetGbp.toFixed(2)} (${pct(net.worstNetPct)}) below floor GBP ${profit.minNetAfterAdsGbp} / ${pct(profit.minNetMarginPct)}` };
  }
  if (competitor && competitor.estimateGbp > 0) {
    const ceiling = competitor.estimateGbp * (1 + profit.competitionTolerancePct);
    if (net.fromRetailGbp > ceiling) {
      if (competitor.confidence === 'high') {
        return { verdict: 'reject', reason: `priced GBP ${net.fromRetailGbp.toFixed(2)} vs UK street ~GBP ${competitor.estimateGbp.toFixed(2)} (over ${pct(profit.competitionTolerancePct)}), will not sell` };
      }
      return { verdict: 'review', reason: `may exceed UK street ~GBP ${competitor.estimateGbp.toFixed(2)} (${competitor.confidence} confidence)` };
    }
  }
  return { verdict: 'pass', reason: `net GBP ${net.worstNetGbp.toFixed(2)} (${pct(net.worstNetPct)})` };
}

// --- Audit agent (observe-first; never archives) ---

/**
 * OBSERVE-first audit: walk imported products in a batch, compute the
 * deterministic net + the (cached) competitor signal, and write a verdict per
 * product. NEVER archives - the console surfaces flagged products for the owner
 * to confirm. No-ops when profit is disabled. Rolling: returns `next` for the
 * cron to checkpoint against its deadline.
 */
export async function auditProfitability(
  store: TenantStore, llm: LlmClient, cfg: TenantConfig, opts: { offset?: number; limit?: number } = {}
): Promise<{ scanned: number; flagged: number; total: number; next: number | null }> {
  const profit = cfg.profit;
  if (!profit?.enabled) return { scanned: 0, flagged: 0, total: 0, next: null };
  const offset = Math.max(0, opts.offset ?? 0);
  // Small batch: each product may make ONE sequential web-search competitor call
  // (cached after) with no mid-batch deadline. Match the codebase's limit-8 cap
  // for LLM-bearing sweeps (reconcileHeroImages/Descriptions) - web search is
  // slower than their vision/text calls, so never exceed it here.
  const limit = opts.limit ?? 8;
  const all = (await store.listImportedLinks(500)).filter((l) => l.shopify_product_id);
  const total = all.length;
  const links = all.slice(offset, offset + limit);
  let scanned = 0, flagged = 0;
  for (const link of links) {
    scanned++;
    try {
      const wh = await store.getWarehouseProduct(link.cj_pid);
      if (!wh) continue;
      let detail: CjDetail;
      try { detail = JSON.parse(wh.detail) as CjDetail; } catch { continue; }
      const net = productNetAfterAds(detail.variants, cfg.pricing, detail.freightUsd, profit);
      if (!net) continue;
      const competitor = await competitorSignal(llm, store, cfg, { pid: link.cj_pid, title: detail.nameEn, ourRetailGbp: net.fromRetailGbp });
      const { verdict, reason } = profitVerdict({ net, competitor, profit });
      if (verdict !== 'pass') flagged++;
      await store.upsertProfitVerdict({
        cjPid: link.cj_pid, verdict, netGbp: net.worstNetGbp, netPct: net.worstNetPct, ourRetailGbp: net.fromRetailGbp,
        competitorGbp: competitor?.estimateGbp ?? null, competitorConfidence: competitor?.confidence ?? null,
        competitorSources: competitor?.sources ?? null, reason,
      });
    } catch (e) { console.warn(`profit audit failed for ${link.cj_pid}: ${(e as Error).message}`); }
  }
  return { scanned, flagged, total, next: offset + limit < total ? offset + limit : null };
}
