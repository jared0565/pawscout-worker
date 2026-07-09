// src/profit-console.ts
//
// Console-facing data + owner actions for the Profitability view. Read side
// summarises the observe audit's verdicts; the write side is the two dormancy
// flips (saveProfit) and a SINGLE owner-confirmed archive (never automatic -
// competition-aware-catalog policy: archive not delete, owner confirms).

import type { AdminGraphql } from './shopify-admin';
import type { TenantStore } from './tenant-store';
import type { TenantConfig } from './types';
import { DEFAULT_PROFIT } from './types';

export interface ProfitConsoleRow {
  cjPid: string;
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
      cjPid: r.cj_pid, handle: r.handle ?? null, productId: r.shopify_product_id ?? null, linkState: r.link_state ?? null,
      verdict: r.verdict, netGbp: r.net_gbp, netPct: r.net_pct, ourRetailGbp: r.our_retail_gbp,
      competitorGbp: r.competitor_gbp, competitorConfidence: r.competitor_confidence, sources: parseSources(r.competitor_sources),
      reason: r.reason, checkedAt: r.checked_at,
      action: r.action ?? null, fromGbp: r.from_gbp ?? null, toGbp: r.to_gbp ?? null, dryRun: r.dry_run ?? null,
    })),
    recentActions: actions.map((a) => ({
      cjPid: a.cj_pid, action: a.action, fromGbp: a.from_gbp, toGbp: a.to_gbp,
      competitorGbp: a.competitor_gbp, competitorConfidence: a.competitor_confidence,
      reason: a.reason, dryRun: a.dry_run, createdAt: a.created_at,
    })),
  };
}

/** Merge the owner's console flips onto the current profit config and persist.
 *  The booleans settable from the console are enabled / dryRun (preview) / hardBlock
 *  (enforce imports); the numeric thresholds are tuned in tenant_config directly
 *  (documented in the view). SAFETY: on the FIRST enable we force dryRun:true so the
 *  agent can only preview until the owner deliberately clears it - going full-auto is
 *  never a side effect of turning the agent on. */
export async function saveProfitFlags(
  store: TenantStore, cfg: TenantConfig | null,
  flags: { enabled?: unknown; dryRun?: unknown; hardBlock?: unknown; competitionCheckOnImport?: unknown }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!cfg) return { ok: false, error: 'no config' };
  const base = cfg.profit ?? DEFAULT_PROFIT;
  const bool = (v: unknown, cur: boolean) => (typeof v === 'boolean' ? v : cur);
  const enabling = flags.enabled === true && base.enabled === false; // off -> on this flip
  await store.saveProfit({
    ...base,
    enabled: bool(flags.enabled, base.enabled),
    // First enable always starts in preview; otherwise honor an explicit dryRun flip.
    dryRun: enabling ? true : bool(flags.dryRun, base.dryRun ?? true),
    hardBlock: bool(flags.hardBlock, base.hardBlock),
    competitionCheckOnImport: bool(flags.competitionCheckOnImport, base.competitionCheckOnImport),
  });
  return { ok: true };
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
