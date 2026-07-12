// src/profit-console.ts
//
// Console-facing data + owner actions for the Profitability view. Read side
// summarises the observe audit's verdicts; the write side is the two dormancy
// flips (saveProfit) and a SINGLE owner-confirmed archive (never automatic -
// competition-aware-catalog policy: archive not delete, owner confirms).

import type { AdminGraphql } from './shopify-admin';
import type { TenantStore } from './tenant-store';
import type { LlmClient } from './llm';
import type { MarketSource } from './market';
import type { TenantConfig } from './types';
import { DEFAULT_PROFIT } from './types';
import { judgeImportedLink, competitorCacheKey } from './profitability';

export interface ProfitConsoleRow {
  cjPid: string;
  sku: string | null;            // CJ variant SKU (first variant) for the review table
  name: string | null;           // CJ product name (readable short name; wraps, unlike the handle)
  cjPriceGbp: number | null;      // CJ item price (sellPriceUsd x FX) at import - NOT the landed cost behind net
  handle: string | null;
  productId: string | null;
  linkState: string | null;      // imported | draft | archived | ...
  verdict: string;               // pass | review | reject
  netGbp: number | null;
  netPct: number | null;
  ourRetailGbp: number | null;
  competitorGbp: number | null;
  competitorConfidence: string | null;
  sources: string[];
  reason: string;
  checkedAt: string;
  // The active agent's latest action on this product (nullable until it acts).
  action: string | null;         // reprice | drop | flag | keep
  fromGbp: number | null;        // from-price of the latest reprice
  toGbp: number | null;          // target of the latest reprice
  dryRun: number | null;         // 1 = previewed only, 0 = executed live
  profitKeep: number;            // 1 = owner Keep override (the agent must not act)
}

export interface ProfitActionView {
  cjPid: string;
  action: string;                // reprice | drop
  fromGbp: number | null;
  toGbp: number | null;
  competitorGbp: number | null;
  competitorConfidence: string | null;
  reason: string;
  dryRun: number;                // 1 = previewed only, 0 = executed live
  createdAt: string;
}

export interface ProfitConsole {
  ok: true;
  config: {
    enabled: boolean; dryRun: boolean; hardBlock: boolean; competitionCheckOnImport: boolean;
    adShareOfRevenue: number; minNetAfterAdsGbp: number; minNetMarginPct: number; competitionTolerancePct: number;
  };
  summary: { total: number; reject: number; review: number; pass: number; lastCheckedAt: string | null };
  rows: ProfitConsoleRow[];
  recentActions: ProfitActionView[];
}

function parseSources(json: string | null): string[] {
  if (!json) return [];
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(String).slice(0, 3) : []; } catch { return []; }
}

/** The Profitability view payload: the two flips, a verdict roll-up, and the
 *  verdict rows worst-first. */
export async function getProfitConsole(store: TenantStore, cfg: TenantConfig | null): Promise<ProfitConsole> {
  const p = cfg?.profit ?? DEFAULT_PROFIT;
  const fx = cfg?.pricing?.fxUsdToGbp && cfg.pricing.fxUsdToGbp > 0 ? cfg.pricing.fxUsdToGbp : 0.78;
  const rows = await store.listProfitVerdicts(500);
  const actions = await store.listProfitActions(50);
  const summary = { total: rows.length, reject: 0, review: 0, pass: 0, lastCheckedAt: null as string | null };
  for (const r of rows) {
    if (r.verdict === 'reject') summary.reject++;
    else if (r.verdict === 'review') summary.review++;
    else summary.pass++;
    if (!summary.lastCheckedAt || r.checked_at > summary.lastCheckedAt) summary.lastCheckedAt = r.checked_at;
  }
  return {
    ok: true,
    config: {
      enabled: p.enabled, dryRun: p.dryRun, hardBlock: p.hardBlock, competitionCheckOnImport: p.competitionCheckOnImport,
      adShareOfRevenue: p.adShareOfRevenue, minNetAfterAdsGbp: p.minNetAfterAdsGbp, minNetMarginPct: p.minNetMarginPct,
      competitionTolerancePct: p.competitionTolerancePct,
    },
    summary,
    rows: rows.map((r) => ({
      cjPid: r.cj_pid, sku: r.sku ?? null,
      name: r.name ?? null,
      cjPriceGbp: typeof r.cj_price_usd === 'number' && Number.isFinite(r.cj_price_usd) ? Math.round(r.cj_price_usd * fx * 100) / 100 : null,
      handle: r.handle ?? null, productId: r.shopify_product_id ?? null, linkState: r.link_state ?? null,
      verdict: r.verdict, netGbp: r.net_gbp, netPct: r.net_pct, ourRetailGbp: r.our_retail_gbp,
      competitorGbp: r.competitor_gbp, competitorConfidence: r.competitor_confidence, sources: parseSources(r.competitor_sources),
      reason: r.reason, checkedAt: r.checked_at,
      action: r.action ?? null, fromGbp: r.from_gbp ?? null, toGbp: r.to_gbp ?? null, dryRun: r.dry_run ?? null,
      profitKeep: r.profit_keep ?? 0,
    })),
    recentActions: actions.map((a) => ({
      cjPid: a.cj_pid, action: a.action, fromGbp: a.from_gbp, toGbp: a.to_gbp,
      competitorGbp: a.competitor_gbp, competitorConfidence: a.competitor_confidence,
      reason: a.reason, dryRun: a.dry_run, createdAt: a.created_at,
    })),
  };
}

/** Highest ad share the console will accept. Above ~0.70 the per-unit net stops
 *  rising with price (the price coefficient in liveNetGbp goes negative), which
 *  would invert the agent's reprice logic - so cap the settable value well below it. */
export const MAX_AD_SHARE = 0.6;

/** Merge the owner's console edits onto the current profit config and persist.
 *  Settable from the console: enabled / dryRun (preview) / hardBlock (enforce imports)
 *  and adShareOfRevenue (the key tuning lever - the blended fraction of revenue spent
 *  on ads); the rest of the numeric thresholds are tuned in tenant_config directly.
 *  SAFETY: on the FIRST enable we force dryRun:true so the agent can only preview
 *  until the owner deliberately clears it - going full-auto is never a side effect of
 *  turning the agent on. adShareOfRevenue is clamped to [0, MAX_AD_SHARE]. */
export async function saveProfitFlags(
  store: TenantStore, cfg: TenantConfig | null,
  flags: { enabled?: unknown; dryRun?: unknown; hardBlock?: unknown; competitionCheckOnImport?: unknown; adShareOfRevenue?: unknown }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!cfg) return { ok: false, error: 'no config' };
  const base = cfg.profit ?? DEFAULT_PROFIT;
  const bool = (v: unknown, cur: boolean) => (typeof v === 'boolean' ? v : cur);
  const enabling = flags.enabled === true && base.enabled === false; // off -> on this flip
  // Numeric lever: accept a finite number, clamp to a safe range; ignore anything else.
  const adShare = typeof flags.adShareOfRevenue === 'number' && Number.isFinite(flags.adShareOfRevenue)
    ? Math.min(Math.max(flags.adShareOfRevenue, 0), MAX_AD_SHARE)
    : base.adShareOfRevenue;
  await store.saveProfit({
    ...base,
    enabled: bool(flags.enabled, base.enabled),
    // First enable always starts in preview; otherwise honor an explicit dryRun flip.
    dryRun: enabling ? true : bool(flags.dryRun, base.dryRun ?? true),
    hardBlock: bool(flags.hardBlock, base.hardBlock),
    competitionCheckOnImport: bool(flags.competitionCheckOnImport, base.competitionCheckOnImport),
    adShareOfRevenue: adShare,
  });
  return { ok: true };
}

/** Owner-confirmed "clear list & re-judge" (2026-07-10): wipe the standing
 *  decisions AND the cached competitor signals so the continuous agent rebuilds
 *  the Products list from scratch - fresh market research, live costs, current
 *  pricing knobs. The action ledger is deliberately KEPT (history), and nothing
 *  is archived or repriced by clearing: the next sweep re-decides every product
 *  on live numbers exactly as it always does. */
export async function clearProfitDecisions(
  store: TenantStore
): Promise<{ ok: true; cleared: number; cacheCleared: number }> {
  const cleared = await store.clearProfitVerdicts();
  const cacheCleared = await store.clearCompetitorCache();
  return { ok: true, cleared, cacheCleared };
}

/** Owner Keep/Release on ONE product (2026-07-12). Keep = a durable "do not act"
 *  override on the link row (the judge short-circuits on it); Release = resume
 *  normal judging. Both re-judge immediately so the console row updates in place
 *  instead of waiting for the sweep - note a Release in live mode can execute the
 *  resulting action straight away (that is what releasing means). */
export async function setProfitKeepAction(
  store: TenantStore, admin: AdminGraphql, llm: LlmClient, cfg: TenantConfig,
  cjPid: unknown, keep: unknown, market?: MarketSource | null
): Promise<{ ok: true; keep: boolean; action: string; reason: string } | { ok: false; error: string }> {
  if (typeof cjPid !== 'string' || !cjPid.trim()) return { ok: false, error: 'cjPid required' };
  if (typeof keep !== 'boolean') return { ok: false, error: 'keep must be true or false' };
  const link = await store.getLink(cjPid);
  if (!link || !link.shopify_product_id) return { ok: false, error: 'No Shopify product for that item' };
  if (link.state === 'archived') return { ok: false, error: 'Already archived' };
  await store.setProfitKeep(cjPid, keep);
  const dryRun = cfg.profit?.dryRun !== false;
  try {
    const judged = await judgeImportedLink(store, admin, llm, cfg,
      { cj_pid: cjPid, shopify_product_id: link.shopify_product_id, profit_keep: keep ? 1 : 0 },
      dryRun, { market: market ?? null });
    return { ok: true, keep, action: judged.action, reason: judged.reason };
  } catch (e) {
    // The flag IS set; only the immediate re-judge failed (the sweep will catch up).
    return { ok: true, keep, action: keep ? 'keep' : 'pending', reason: `saved; immediate re-judge failed (${(e as Error).message}) - the next sweep applies it` };
  }
}

/** The competitor listing is NOT the same product (owner's call, 2026-07-12).
 *  Writes an owner marker over the cached signal for 90 days - so the cheap
 *  structured market sweep cannot re-adopt the same wrong match when the cache
 *  would have expired - then re-judges immediately WITHOUT a market signal
 *  (the cost-plus no-market rules apply). Deep check remains the way to
 *  research a better comparable and overwrite the marker. */
export async function rejectProfitMatch(
  store: TenantStore, admin: AdminGraphql, llm: LlmClient, cfg: TenantConfig, cjPid: unknown
): Promise<{ ok: true; action: string; reason: string } | { ok: false; error: string }> {
  if (typeof cjPid !== 'string' || !cjPid.trim()) return { ok: false, error: 'cjPid required' };
  const link = await store.getLink(cjPid);
  if (!link || !link.shopify_product_id) return { ok: false, error: 'No Shopify product for that item' };
  if (link.state === 'archived') return { ok: false, error: 'Already archived' };
  const marker = { estimateGbp: 0, confidence: 'low', sources: ['owner: competitor item is not the same product'] };
  await store.putSearchCache(competitorCacheKey(cjPid), JSON.stringify(marker), 90);
  const dryRun = cfg.profit?.dryRun !== false;
  try {
    const judged = await judgeImportedLink(store, admin, llm, cfg,
      { cj_pid: cjPid, shopify_product_id: link.shopify_product_id, profit_keep: link.profit_keep },
      dryRun, { signalOverride: null });
    return { ok: true, action: judged.action, reason: judged.reason };
  } catch (e) {
    // The marker IS stored; only the immediate re-judge failed (the sweep catches up).
    return { ok: true, action: 'pending', reason: `match discarded; immediate re-judge failed (${(e as Error).message}) - the next sweep re-judges it` };
  }
}

const ARCHIVE_PRODUCT = `mutation pawscoutProfitArchive($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

/** Owner-confirmed archive of ONE flagged product (never automatic). Sets the
 *  Shopify product to ARCHIVED and marks the link archived, mirroring the cull
 *  path. Refuses a pid with no live product or one already archived. */
export async function archiveProfitProduct(
  store: TenantStore, admin: AdminGraphql, cjPid: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof cjPid !== 'string' || !cjPid.trim()) return { ok: false, error: 'cjPid required' };
  const link = await store.getLink(cjPid);
  if (!link || !link.shopify_product_id) return { ok: false, error: 'No Shopify product for that item' };
  if (link.state === 'archived') return { ok: false, error: 'Already archived' };
  const data = await admin(ARCHIVE_PRODUCT, { input: { id: link.shopify_product_id, status: 'ARCHIVED' } });
  const errs = (data.productUpdate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join('; ') };
  await store.putLink({ cjPid, state: 'archived' });
  return { ok: true };
}
