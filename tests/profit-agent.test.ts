import { describe, it, expect } from 'vitest';
import { runProfitAgent } from '../src/profitability';
import { rejectProfitMatch, setProfitKeepAction } from '../src/profit-console';
import { DEFAULT_PROFIT, type Pricing } from '../src/types';

const PRICING: Pricing = { multiplier: 2.2, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2, maxMarginGbp: 30 };

type Prod = {
  variants: { variantId: string; price: string; cost: string }[];
  competitor?: { estimateGbp: number; confidence: 'high' | 'medium' | 'low' };
  nameEn?: string;
  profitKeep?: number; // owner Keep override on the link row
};

/** Stateful fakes: a product_profit map (so getProfitVerdict reflects prior
 *  upserts, exercising the ledger dedup) + recorders for every mutation. */
function makeFakes(products: Record<string, Prod>) {
  const links = Object.keys(products).map((pid) => ({ cj_pid: pid, shopify_product_id: `gid://${pid}`, handle: pid, state: 'imported', profit_keep: products[pid]?.profitKeep ?? 0 }));
  const productProfit = new Map<string, { action: string | null; to_gbp: number | null; dry_run: number | null; verdict: string; reason: string; competitorGbp: number | null }>();
  const ledger: { cjPid: string; action: string; fromGbp: number | null; toGbp: number | null; dryRun: boolean }[] = [];
  const priceCalls: { productId: string; updates: { id: string; price: string }[] }[] = [];
  const archiveCalls: string[] = [];
  const putLinkCalls: { cjPid: string; state: string }[] = [];
  const cacheWrites: { key: string; payload: string; ttlDays: number }[] = [];
  const keepCalls: { cjPid: string; keep: boolean }[] = [];

  const store = {
    listImportedLinks: async () => links,
    getLink: async (pid: string) => links.find((l) => l.cj_pid === pid) ?? null,
    setProfitKeep: async (pid: string, keep: boolean) => { keepCalls.push({ cjPid: pid, keep }); return true; },
    getWarehouseProduct: async (pid: string) => ({ detail: JSON.stringify({ nameEn: products[pid]?.nameEn ?? pid, variants: [] }) }),
    getSearchCache: async (key: string) => {
      const m = /^comp:(.+)$/.exec(key);
      if (m) { const c = products[m[1]]?.competitor; return c ? JSON.stringify({ estimateGbp: c.estimateGbp, confidence: c.confidence, sources: ['amazon.co.uk'] }) : null; }
      return null;
    },
    putSearchCache: async (key: string, payload: string, ttlDays: number) => { cacheWrites.push({ key, payload, ttlDays }); },
    logLlmUsage: async () => {},
    getProfitVerdict: async (pid: string) => productProfit.get(pid) ?? null,
    upsertProfitVerdict: async (rec: { cjPid: string; verdict: string; action?: string | null; toGbp?: number | null; dryRun?: boolean | null; reason: string; competitorGbp: number | null }) => {
      productProfit.set(rec.cjPid, { action: rec.action ?? null, to_gbp: rec.toGbp ?? null, dry_run: rec.dryRun == null ? null : (rec.dryRun ? 1 : 0), verdict: rec.verdict, reason: rec.reason, competitorGbp: rec.competitorGbp });
    },
    logProfitAction: async (rec: { cjPid: string; action: string; fromGbp: number | null; toGbp: number | null; dryRun: boolean }) => { ledger.push(rec); },
    putLink: async (rec: { cjPid: string; state: string }) => { putLinkCalls.push(rec); },
  } as any;

  const admin = (async (query: string, vars: any) => {
    if (query.includes('pawscoutVariants')) {
      const pid = String(vars.id).replace('gid://', '');
      const nodes = (products[pid]?.variants ?? []).map((v) => ({ id: v.variantId, sku: v.variantId, price: v.price, inventoryItem: { id: `inv-${v.variantId}`, tracked: true, unitCost: { amount: v.cost } } }));
      return { product: { variants: { nodes } } };
    }
    if (query.includes('pawscoutPrices')) { priceCalls.push({ productId: vars.productId, updates: vars.variants }); return { productVariantsBulkUpdate: { userErrors: [] } }; }
    if (query.includes('pawscoutArchiveOne')) { archiveCalls.push(vars.input.id); return { productUpdate: { userErrors: [] } }; }
    return {};
  }) as any;

  const llm = { available: false } as any;
  return { store, admin, llm, ledger, priceCalls, archiveCalls, putLinkCalls, productProfit, cacheWrites, keepCalls };
}

const cfg = (profit: Record<string, unknown>) =>
  ({ pricing: PRICING, llm: { enabled: false }, profit: { ...DEFAULT_PROFIT, enabled: true, dryRun: true, adShareOfRevenue: 0.15, ...profit } }) as any;

describe('runProfitAgent (active adjust-or-drop on live Shopify numbers)', () => {
  it('no-ops entirely when profit is disabled (dormant, zero admin calls)', async () => {
    const f = makeFakes({ P1: { variants: [{ variantId: 'v', price: '15.00', cost: '5.00' }] } });
    const r = await runProfitAgent(f.store, f.admin, f.llm, cfg({ enabled: false }), {});
    expect(r.scanned).toBe(0);
    expect(f.priceCalls.length).toBe(0);
    expect(f.archiveCalls.length).toBe(0);
  });

  it('DRY-RUN previews a reprice: records the action + ledger row but touches NO prices', async () => {
    const f = makeFakes({ RAISE: { variants: [{ variantId: 'v', price: '15.00', cost: '5.00' }], competitor: { estimateGbp: 25, confidence: 'high' } } });
    const r = await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: true }), {});
    expect(f.priceCalls.length).toBe(0);                 // nothing executed
    expect(r.repriced).toBe(1);                          // but counted as "would reprice"
    expect(r.dryRun).toBe(true);
    expect(f.ledger.length).toBe(1);
    expect(f.ledger[0].action).toBe('reprice');
    expect(f.ledger[0].dryRun).toBe(true);
    expect(f.productProfit.get('RAISE')?.action).toBe('reprice');
  });

  it('LIVE reprice RAISES to just under the market (a .99, above our price, below competitor)', async () => {
    const f = makeFakes({ RAISE: { variants: [{ variantId: 'v', price: '15.00', cost: '5.00' }], competitor: { estimateGbp: 25, confidence: 'high' } } });
    const r = await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: false }), {});
    expect(f.priceCalls.length).toBe(1);
    const price = Number(f.priceCalls[0].updates[0].price);
    expect(price).toBeGreaterThan(15);
    expect(price).toBeLessThan(25);
    expect(f.priceCalls[0].updates[0].price.endsWith('.99')).toBe(true);
    expect(r.repriced).toBe(1);
    expect(f.ledger[0].dryRun).toBe(false);
  });

  it('LIVE drop ARCHIVES a clear loss and flips the link state', async () => {
    const f = makeFakes({ LOSS: { variants: [{ variantId: 'v', price: '10.00', cost: '8.00' }], competitor: { estimateGbp: 15, confidence: 'high' } } });
    const r = await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: false }), {});
    expect(f.archiveCalls).toEqual(['gid://LOSS']);
    expect(f.putLinkCalls).toEqual([{ cjPid: 'LOSS', state: 'archived' }]);
    expect(r.dropped).toBe(1);
    expect(f.ledger[0].action).toBe('drop');
  });

  it('NEVER auto-archives on a medium-confidence market (flag only, no execution)', async () => {
    const f = makeFakes({ MAYBE: { variants: [{ variantId: 'v', price: '10.00', cost: '8.00' }], competitor: { estimateGbp: 15, confidence: 'medium' } } });
    await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: false }), {});
    expect(f.archiveCalls.length).toBe(0);
    expect(f.ledger.length).toBe(0);                     // flag is not a ledger mutation
    expect(f.productProfit.get('MAYBE')?.verdict).toBe('review');
  });

  it('RAISES a thin NO-competitor product to our cost-plus price (the market of one), not a flag', async () => {
    // price 13 / cost 10: gross-positive but full-stack net thin, and NO competitor
    // found. The runner computes the cost-plus price from the live cost and reprices
    // to it, keeping the product live rather than flagging or freezing it.
    const f = makeFakes({ THIN: { variants: [{ variantId: 'v', price: '13.00', cost: '10.00' }] } });
    const r = await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: true }), {});
    expect(r.repriced).toBe(1);
    expect(f.priceCalls.length).toBe(0);                 // dry-run previews only
    expect(f.ledger.length).toBe(1);
    expect(f.ledger[0].action).toBe('reprice');
    expect(Number(f.ledger[0].toGbp)).toBeGreaterThan(13); // raised toward our markup
    expect(f.productProfit.get('THIN')?.action).toBe('reprice');
  });

  it('the ledger DEDUPES: re-previewing the same reprice each tick logs only once', async () => {
    const f = makeFakes({ RAISE: { variants: [{ variantId: 'v', price: '15.00', cost: '5.00' }], competitor: { estimateGbp: 25, confidence: 'high' } } });
    await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: true }), {});
    await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: true }), {});
    expect(f.ledger.length).toBe(1);                     // second tick is identical -> not re-logged
  });

  it('KEEPS a product with no live price/cost, spending no market lookup or ledger', async () => {
    const f = makeFakes({ BLANK: { variants: [{ variantId: 'v', price: '', cost: '' }], competitor: { estimateGbp: 25, confidence: 'high' } } });
    await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: false }), {});
    expect(f.priceCalls.length).toBe(0);
    expect(f.archiveCalls.length).toBe(0);
    expect(f.ledger.length).toBe(0);
    expect(f.productProfit.get('BLANK')?.action).toBe('keep');
  });

  it('owner Keep short-circuits the judge: a clear-loss kept product is never touched', async () => {
    // Without the override these numbers auto-archive live (high-confidence loss).
    const f = makeFakes({ LOSS: { variants: [{ variantId: 'v', price: '10.00', cost: '8.00' }], competitor: { estimateGbp: 15, confidence: 'high' }, profitKeep: 1 } });
    const r = await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: false }), {});
    expect(f.archiveCalls.length).toBe(0);
    expect(f.priceCalls.length).toBe(0);
    expect(f.ledger.length).toBe(0);
    expect(r.dropped).toBe(0);
    expect(f.productProfit.get('LOSS')?.verdict).toBe('pass');
    expect(f.productProfit.get('LOSS')?.action).toBe('keep');
    expect(f.productProfit.get('LOSS')?.reason).toContain('kept by owner');
  });

  it('rolls through the catalog via offset/limit and reports next', async () => {
    const f = makeFakes({
      A: { variants: [{ variantId: 'v', price: '20.00', cost: '5.00' }] },
      B: { variants: [{ variantId: 'v', price: '20.00', cost: '5.00' }] },
      C: { variants: [{ variantId: 'v', price: '20.00', cost: '5.00' }] },
    });
    const r = await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: true }), { offset: 0, limit: 2 });
    expect(r.scanned).toBe(2);
    expect(r.total).toBe(3);
    expect(r.next).toBe(2);
    const r2 = await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: true }), { offset: 2, limit: 2 });
    expect(r2.next).toBeNull();
  });
});

describe('owner row actions (Keep/Release + Wrong match)', () => {
  it('setProfitKeepAction sets the flag and re-judges immediately to a kept pass row', async () => {
    const f = makeFakes({ LOSS: { variants: [{ variantId: 'v', price: '10.00', cost: '8.00' }], competitor: { estimateGbp: 15, confidence: 'high' } } });
    const r = await setProfitKeepAction(f.store, f.admin, f.llm, cfg({ dryRun: false }), 'LOSS', true, null);
    expect(r.ok).toBe(true);
    expect(f.keepCalls).toEqual([{ cjPid: 'LOSS', keep: true }]);
    // The immediate re-judge honors the fresh flag even though the link row still says 0.
    expect(f.productProfit.get('LOSS')?.verdict).toBe('pass');
    expect(f.productProfit.get('LOSS')?.action).toBe('keep');
    expect(f.archiveCalls.length).toBe(0);
  });

  it('rejectProfitMatch writes a 90-day owner marker over the cached signal and re-judges without a market', async () => {
    // With the eBay match these numbers would drop; the owner says it is NOT the
    // same product, so the judgment must fall back to the no-market rules.
    const f = makeFakes({ LOSS: { variants: [{ variantId: 'v', price: '10.00', cost: '8.00' }], competitor: { estimateGbp: 15, confidence: 'high' } } });
    const r = await rejectProfitMatch(f.store, f.admin, f.llm, cfg({ dryRun: false }), 'LOSS');
    expect(r.ok).toBe(true);
    expect(f.cacheWrites.length).toBe(1);
    expect(f.cacheWrites[0].key).toBe('comp:LOSS');
    expect(f.cacheWrites[0].ttlDays).toBe(90);
    const marker = JSON.parse(f.cacheWrites[0].payload) as { estimateGbp: number; sources: string[] };
    expect(marker.estimateGbp).toBe(0);
    expect(marker.sources.join(' ')).toContain('owner');
    // Re-judged with NO market signal: not archived on the discarded match.
    expect(f.archiveCalls.length).toBe(0);
    expect(f.productProfit.get('LOSS')?.competitorGbp).toBeNull();
  });

  it('the stored owner marker suppresses the cached market signal on later sweeps', async () => {
    const f = makeFakes({ LOSS: { variants: [{ variantId: 'v', price: '10.00', cost: '8.00' }], competitor: { estimateGbp: 15, confidence: 'high' } } });
    // Simulate the sweep AFTER a Wrong match: the cache now returns the owner marker.
    f.store.getSearchCache = async (key: string) =>
      key === 'comp:LOSS' ? JSON.stringify({ estimateGbp: 0, confidence: 'low', sources: ['owner: competitor item is not the same product'] }) : null;
    const r = await runProfitAgent(f.store, f.admin, f.llm, cfg({ dryRun: false }), {});
    expect(r.dropped).toBe(0);
    expect(f.archiveCalls.length).toBe(0);
    // The marker's 0 estimate is stored as-is: not a usable market (renders "no market").
    expect(f.productProfit.get('LOSS')?.competitorGbp ?? 0).toBe(0);
  });

  it('setProfitKeepAction refuses an unknown or archived product', async () => {
    const f = makeFakes({ LOSS: { variants: [{ variantId: 'v', price: '10.00', cost: '8.00' }] } });
    const missing = await setProfitKeepAction(f.store, f.admin, f.llm, cfg({}), 'NOPE', true, null);
    expect(missing.ok).toBe(false);
    const badFlag = await setProfitKeepAction(f.store, f.admin, f.llm, cfg({}), 'LOSS', 'yes', null);
    expect(badFlag.ok).toBe(false);
  });
});
