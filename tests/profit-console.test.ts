import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { saveProfitFlags, clearProfitDecisions, MAX_AD_SHARE } from '../src/profit-console';
import { DEFAULT_PROFIT } from '../src/types';
import { TenantStore } from '../src/tenant-store';

function fakeStore() {
  const saved: Array<Record<string, unknown>> = [];
  return { saved, saveProfit: async (p: Record<string, unknown>) => { saved.push(p); } } as any;
}
const cfgWith = (profit: Record<string, unknown>) => ({ profit: { ...DEFAULT_PROFIT, ...profit } }) as any;

describe('saveProfitFlags (console profit config)', () => {
  it('sets a valid ad share (stored as a fraction of revenue)', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({ adShareOfRevenue: 0.33 }), { adShareOfRevenue: 0.15 });
    expect(store.saved[0].adShareOfRevenue).toBe(0.15);
  });

  it('clamps an out-of-range ad share to MAX_AD_SHARE (never past where net stops rising with price)', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({}), { adShareOfRevenue: 0.9 });
    expect(store.saved[0].adShareOfRevenue).toBe(MAX_AD_SHARE);
  });

  it('ignores a non-numeric ad share (keeps the current value)', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({ adShareOfRevenue: 0.2 }), { adShareOfRevenue: 'oops' });
    expect(store.saved[0].adShareOfRevenue).toBe(0.2);
  });

  it('first enable FORCES dryRun:true (preview) even if the saved config had it false', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({ enabled: false, dryRun: false }), { enabled: true });
    expect(store.saved[0].enabled).toBe(true);
    expect(store.saved[0].dryRun).toBe(true); // going full-auto is never a side effect of enabling
  });

  it('honors an explicit dryRun flip once already enabled (owner going full-auto)', async () => {
    const store = fakeStore();
    await saveProfitFlags(store, cfgWith({ enabled: true, dryRun: true }), { dryRun: false });
    expect(store.saved[0].dryRun).toBe(false);
  });
});

describe('clearProfitDecisions (clear list & re-judge)', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
  const SHOP = 'a.myshopify.com';

  it('wipes the standing decisions AND the comp: cache, keeps other caches and the ledger', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertProfitVerdict({ cjPid: 'p1', verdict: 'review', netGbp: -1.5, netPct: null, ourRetailGbp: 9.99, competitorGbp: 12, competitorConfidence: 'medium', competitorSources: ['amazon'], reason: 'old judgment', action: 'flag', fromGbp: null, toGbp: null, dryRun: false });
    await s.upsertProfitVerdict({ cjPid: 'p2', verdict: 'pass', netGbp: 4.2, netPct: 0.2, ourRetailGbp: 19.99, competitorGbp: null, competitorConfidence: null, competitorSources: null, reason: 'ok', action: 'keep', fromGbp: null, toGbp: null, dryRun: false });
    await s.logProfitAction({ cjPid: 'p1', action: 'reprice', fromGbp: 9.99, toGbp: 11.99, competitorGbp: 12, competitorConfidence: 'medium', reason: 'x', dryRun: false });
    await s.putSearchCache('comp:p1', JSON.stringify({ estimateGbp: 12 }), 14);
    await s.putSearchCache('comp:p2', JSON.stringify({ estimateGbp: 9 }), 14);
    await s.putSearchCache('pid:p1', '{"pid":"p1"}', 30); // NOT a competitor signal - must survive

    const r = await clearProfitDecisions(s);
    expect(r).toEqual({ ok: true, cleared: 2, cacheCleared: 2 });
    expect(await s.listProfitVerdicts(10)).toEqual([]);              // list empty - agent repopulates
    expect(await s.getSearchCache('comp:p1')).toBeNull();            // market estimates re-researched
    expect(await s.getSearchCache('pid:p1')).not.toBeNull();         // detail cache untouched
    expect((await s.listProfitActions(10)).length).toBe(1);          // history kept
  });

  it('is idempotent: clearing an empty state reports zeros', async () => {
    const s = new TenantStore(env.DB, SHOP);
    expect(await clearProfitDecisions(s)).toEqual({ ok: true, cleared: 0, cacheCleared: 0 });
  });
});

describe('recalibration store methods (2026-07-12 median recalibration)', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
  const SHOP = 'a.myshopify.com';
  const drop = (cjPid: string, dryRun: boolean) =>
    ({ cjPid, action: 'drop', fromGbp: null, toGbp: null, competitorGbp: 10, competitorConfidence: 'high', reason: 'x', dryRun });

  it('listArchivedDroppedPids: distinct archived links with a LIVE drop action only', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.putLink({ cjPid: 'A', shopifyProductId: 'gid://A', state: 'archived' });
    await s.putLink({ cjPid: 'B', shopifyProductId: 'gid://B', state: 'archived' });
    await s.putLink({ cjPid: 'C', shopifyProductId: 'gid://C', state: 'imported' });  // rescued/live again - not a candidate
    await s.putLink({ cjPid: 'D', shopifyProductId: 'gid://D', state: 'archived' }); // archived but never agent-dropped (owner Archive)
    await s.logProfitAction(drop('A', false));
    await s.logProfitAction(drop('A', false)); // second live drop -> still one candidate (DISTINCT)
    await s.logProfitAction(drop('B', false));
    await s.logProfitAction(drop('C', false));
    await s.logProfitAction(drop('E', true));  // preview-only drop, and no archived link
    expect(await s.listArchivedDroppedPids()).toEqual(['A', 'B']);
  });

  it('clearCompetitorCacheExceptOwner wipes market signals but keeps owner Wrong-match markers + other caches', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.putSearchCache('comp:p1', JSON.stringify({ estimateGbp: 12, confidence: 'high', sources: ['ebay.co.uk (3 matches)'] }), 14);
    await s.putSearchCache('comp:p2', JSON.stringify({ estimateGbp: 0, confidence: 'low', sources: ['owner: competitor item is not the same product'] }), 90);
    await s.putSearchCache('pid:p1', '{"pid":"p1"}', 30); // NOT a competitor signal - must survive
    expect(await s.clearCompetitorCacheExceptOwner()).toBe(1);
    expect(await s.getSearchCache('comp:p1')).toBeNull();     // re-researched under the new rules
    expect(await s.getSearchCache('comp:p2')).not.toBeNull(); // the owner's call outlives a recalibration
    expect(await s.getSearchCache('pid:p1')).not.toBeNull();
  });

  it('listProfitVerdicts omits verdicts for archived AND failed links (dead products are not reviewable)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const verdict = (cjPid: string) => s.upsertProfitVerdict({
      cjPid, verdict: 'reject', netGbp: -1, netPct: -10, ourRetailGbp: 9.99,
      competitorGbp: 5, competitorConfidence: 'high', competitorSources: ['ebay.co.uk (3 matches)'], reason: 'x'
    });
    await s.putLink({ cjPid: 'LIVE', shopifyProductId: 'gid://L', state: 'imported' });
    await s.putLink({ cjPid: 'DEAD', shopifyProductId: 'gid://D', state: 'failed' });
    await s.putLink({ cjPid: 'GONE', shopifyProductId: 'gid://G', state: 'archived' });
    await verdict('LIVE'); await verdict('DEAD'); await verdict('GONE');
    const pids = (await s.listProfitVerdicts(50)).map((r) => r.cj_pid);
    expect(pids).toEqual(['LIVE']);
  });

  it('both clears also purge UNKNOWN seller-country lookups (ebayseller:* = ?) but keep resolved countries', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.putSearchCache('ebayseller:v1|1|0', '?', 30);   // unknown - possibly a failed read; must retry
    await s.putSearchCache('ebayseller:v1|2|0', 'CN', 30);  // resolved fact - keeps its TTL
    await s.clearCompetitorCacheExceptOwner();
    expect(await s.getSearchCache('ebayseller:v1|1|0')).toBeNull();
    expect(await s.getSearchCache('ebayseller:v1|2|0')).toBe('CN');
    await s.putSearchCache('ebayseller:v1|3|0', '?', 30);
    await s.clearCompetitorCache();
    expect(await s.getSearchCache('ebayseller:v1|3|0')).toBeNull();
    expect(await s.getSearchCache('ebayseller:v1|2|0')).toBe('CN');
  });
});
