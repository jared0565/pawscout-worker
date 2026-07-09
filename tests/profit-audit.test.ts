import { describe, it, expect } from 'vitest';
import { auditProfitability } from '../src/profitability';
import { DEFAULT_PROFIT, type Pricing } from '../src/types';

const PRICING: Pricing = { multiplier: 2.2, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2, maxMarginGbp: 30 };

function fakeStore(details: Record<string, { pid: string; nameEn: string; variants: { sellPriceUsd: number }[]; freightUsd?: number }>) {
  const verdicts: Array<{ cjPid: string; verdict: string }> = [];
  return {
    verdicts,
    listImportedLinks: async () => Object.keys(details).map((pid) => ({ cj_pid: pid, shopify_product_id: `gid://${pid}` })),
    getWarehouseProduct: async (pid: string) => (details[pid] ? { detail: JSON.stringify(details[pid]) } : null),
    getSearchCache: async () => null,
    putSearchCache: async () => {},
    logLlmUsage: async () => {},
    upsertProfitVerdict: async (rec: { cjPid: string; verdict: string }) => { verdicts.push(rec); },
  } as any;
}
const noLlm = { available: false } as any;

describe('auditProfitability', () => {
  it('no-ops entirely when profit is disabled (dormant, zero spend)', async () => {
    const store = fakeStore({ P1: { pid: 'P1', nameEn: 'toy', variants: [{ sellPriceUsd: 10 }], freightUsd: 0 } });
    const cfg = { pricing: PRICING, llm: { enabled: false }, profit: { ...DEFAULT_PROFIT, enabled: false } } as any;
    const r = await auditProfitability(store, noLlm, cfg, {});
    expect(r.scanned).toBe(0);
    expect(store.verdicts.length).toBe(0);
  });

  it('writes a deterministic verdict per product when enabled (no LLM needed)', async () => {
    const store = fakeStore({
      GOOD: { pid: 'GOOD', nameEn: 'cheap cat toy', variants: [{ sellPriceUsd: 10 }], freightUsd: 0 },
      LOSS: { pid: 'LOSS', nameEn: 'big grooming table', variants: [{ sellPriceUsd: 140 }], freightUsd: 25 },
    });
    // Realistic (tuned) ad share so a healthy product passes; at the worst-case
    // 33% default the full cost stack sinks even a cheap item (that is the lever).
    const cfg = { pricing: PRICING, llm: { enabled: false }, profit: { ...DEFAULT_PROFIT, enabled: true, adShareOfRevenue: 0.15 } } as any;
    const r = await auditProfitability(store, noLlm, cfg, {});
    expect(r.scanned).toBe(2);
    const find = (pid: string) => store.verdicts.find((v: { cjPid: string; verdict: string }) => v.cjPid === pid);
    expect(find('LOSS')?.verdict).toBe('reject'); // margin-capped, ads sink it
    expect(find('GOOD')?.verdict).toBe('pass');   // profitable at a realistic ad share
    expect(r.flagged).toBe(1);
  });

  it('paginates via offset/limit and reports next', async () => {
    const store = fakeStore({
      A: { pid: 'A', nameEn: 'a', variants: [{ sellPriceUsd: 10 }] },
      B: { pid: 'B', nameEn: 'b', variants: [{ sellPriceUsd: 10 }] },
      C: { pid: 'C', nameEn: 'c', variants: [{ sellPriceUsd: 10 }] },
    });
    const cfg = { pricing: PRICING, llm: { enabled: false }, profit: { ...DEFAULT_PROFIT, enabled: true } } as any;
    const r = await auditProfitability(store, noLlm, cfg, { offset: 0, limit: 2 });
    expect(r.scanned).toBe(2);
    expect(r.total).toBe(3);
    expect(r.next).toBe(2); // one product left
  });
});
