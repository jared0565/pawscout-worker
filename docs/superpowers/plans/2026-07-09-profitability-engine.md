# Profitability Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vet every product for real net-after-ads profit at import time and continuously over the catalog, shipped dormant so nothing changes until the owner flips it on.

**Architecture:** One deterministic + LLM engine (`src/profitability.ts`) feeds two consumers — a preventive import gate inside `confirmAndImport`, and an observe-first nightly audit agent + console view. Ships with `profit.enabled=false` (no spend, gate no-ops, existing tests unaffected); observe (`enabled`) and enforce (`hardBlock`) are separate knobs.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Hono; OpenRouter web-search grounding (reused); vitest.

## Global Constraints

- **Ship dormant:** `DEFAULT_PROFIT.enabled = false`. When `!cfg.profit?.enabled`, the import-gate block and the audit stage are complete no-ops (zero behaviour change, zero LLM spend).
- **Live pricing only:** compute retail/COGS from the `cfg.pricing` passed in (2.2× live), NEVER `DEFAULT_PRICING`.
- **Variant policy:** a product is judged on its WORST sellable variant, mirroring `productAffiliateEligible` ("one thin variant disqualifies the whole product").
- **Hard REJECT only** on the deterministic net-after-ads floor + a HIGH-confidence competition loss. Everything uncertain → REVIEW (draft/flag). Audit never auto-archives (competition-aware-catalog policy: archive not delete, owner confirms).
- **Competition = LLM + web search** (`jsonChain({ web })`), cached in `search_cache` (`comp:<pid>`), hermetic-safe (any failure → `null`, not a fail). Kept OUT of the synchronous import path unless `competitionCheckOnImport`.
- **No em-dash** anywhere (worker sanitizes outbound, but keep source clean).
- Run graphite `impact`/`context` before editing `confirmAndImport`, `jobs.ts`, `tenant-store.ts` (shared).

---

### Task 1: ProfitConfig types + defaults

**Files:**
- Modify: `src/types.ts` (add interface + default + `TenantConfig.profit`)

**Interfaces:**
- Produces: `ProfitConfig`, `DEFAULT_PROFIT`, `TenantConfig.profit?: ProfitConfig`.

- [ ] **Step 1: Add the interface + default** after the `Pricing`/`Floors` block:

```ts
/**
 * Profitability gate config. Ships DORMANT (enabled=false): the import gate and
 * the audit stage are no-ops until the owner flips it on. Two knobs separate
 * observe from enforce: enabled turns on the OBSERVE audit + REVIEW-mode import
 * gate (sub-floor items import as drafts); hardBlock turns on actual REJECT.
 * All fees are the researched cost stack the pricing multiplier was sized for.
 */
export interface ProfitConfig {
  enabled: boolean;                 // master switch; false = fully dormant
  hardBlock: boolean;               // enforce: import gate REJECTs sub-floor items
  competitionCheckOnImport: boolean;// add the LLM+web competitor check to the sync import path (default off)
  adShareOfRevenue: number;         // ad spend as a fraction of GROSS retail (0.33 = ROAS 3)
  paymentsFeeRate: number;          // payment processing, on gross (~0.025)
  refundReserveRate: number;        // refund reserve, on ex-VAT revenue (~0.03)
  vatRate: number;                  // UK VAT included in the sticker (0.20)
  minNetAfterAdsGbp: number;        // per-unit net-after-ads floor, GBP
  minNetMarginPct: number;          // net as a fraction of ex-VAT revenue floor
  competitionTolerancePct: number;  // how far above the cheapest competitor we may sit
  cacheTtlDays: number;             // competitor-signal cache TTL
}
export const DEFAULT_PROFIT: ProfitConfig = {
  enabled: false, hardBlock: false, competitionCheckOnImport: false,
  adShareOfRevenue: 0.33, paymentsFeeRate: 0.025, refundReserveRate: 0.03, vatRate: 0.20,
  minNetAfterAdsGbp: 2, minNetMarginPct: 0.05, competitionTolerancePct: 0.15, cacheTtlDays: 14,
};
```

- [ ] **Step 2: Add `profit` to `TenantConfig`** (optional, like `semantic`):

```ts
  // Profitability gate config. Ships dormant; rides the '{}' column default +
  // getConfig merge (like addons/fulfil/semantic). Read via DEFAULT_PROFIT guard.
  profit?: ProfitConfig;
```

- [ ] **Step 3: Typecheck** — `npx tsc --noEmit` — Expected: no new errors.
- [ ] **Step 4: Commit** — `git commit -am "feat(profit): ProfitConfig types + dormant defaults"`

---

### Task 2: Deterministic net-after-ads engine + tests

**Files:**
- Create: `src/profitability.ts`
- Create: `tests/profitability.test.ts`

**Interfaces:**
- Consumes: `retailPriceGbp`, `landedCostGbp` from `./pricing`; `Pricing`, `ProfitConfig` from `./types`.
- Produces: `netAfterAdsGbp(landedUsd, freightUsd, pricing, profit): NetAfterAds`; `productNetAfterAds(variants, pricing, freightUsd, profit): ProductNet | null`.

- [ ] **Step 1: Write the failing test** `tests/profitability.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { netAfterAdsGbp, productNetAfterAds } from '../src/profitability';
import { DEFAULT_PROFIT, type Pricing } from '../src/types';

const PRICING: Pricing = { multiplier: 2.2, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2, maxMarginGbp: 30 };

describe('netAfterAdsGbp', () => {
  it('nets positive on a healthy low-ticket item', () => {
    const n = netAfterAdsGbp(10, 0, PRICING, DEFAULT_PROFIT);
    expect(n.retailGbp).toBeGreaterThan(0);
    expect(n.adCostGbp).toBeCloseTo(0.33 * n.retailGbp, 5);
    expect(n.netGbp).toBeGreaterThan(0);
  });
  it('nets negative on a high cost+freight item the margin cap starves of ad budget', () => {
    // ~$116 grooming table + freight: capped at £30 margin, ads (~33%) exceed it.
    const n = netAfterAdsGbp(116, 20, PRICING, DEFAULT_PROFIT);
    expect(n.netGbp).toBeLessThan(DEFAULT_PROFIT.minNetAfterAdsGbp);
  });
});

describe('productNetAfterAds (worst-variant policy)', () => {
  it('judges on the worst variant', () => {
    const p = productNetAfterAds([{ sellPriceUsd: 10 }, { sellPriceUsd: 116 }], PRICING, 20, DEFAULT_PROFIT);
    expect(p).not.toBeNull();
    expect(p!.belowFloor).toBe(true); // the $116 variant drags it under
  });
  it('returns null when no sellable variant', () => {
    expect(productNetAfterAds([{ sellPriceUsd: 0 }], PRICING, 0, DEFAULT_PROFIT)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/profitability.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/profitability.ts`:

```ts
import { retailPriceGbp, landedCostGbp } from './pricing';
import type { Pricing, ProfitConfig } from './types';

function round2(x: number): number { return Math.round(x * 100) / 100; }

export interface NetAfterAds {
  retailGbp: number; cogsGbp: number; adCostGbp: number; netGbp: number; netPct: number;
}

/**
 * Deterministic per-unit net profit after ALL costs at the product's rule price.
 * Ad spend is 0.33 x GROSS retail (ROAS 3, the sizing the multiplier assumes);
 * payments on gross, refund reserve on ex-VAT revenue. Uses the LIVE pricing
 * rule passed in, never a default. No LLM.
 */
export function netAfterAdsGbp(landedUsd: number, freightUsd: number, pricing: Pricing, profit: ProfitConfig): NetAfterAds {
  const retailGbp = retailPriceGbp(landedUsd, pricing, freightUsd);
  const cogsGbp = landedCostGbp(landedUsd, pricing, freightUsd);
  const exVatRevenue = retailGbp / (1 + profit.vatRate);
  const adCostGbp = profit.adShareOfRevenue * retailGbp;
  const paymentsFee = profit.paymentsFeeRate * retailGbp;
  const refundReserve = profit.refundReserveRate * exVatRevenue;
  const netGbp = exVatRevenue - cogsGbp - adCostGbp - paymentsFee - refundReserve;
  return { retailGbp, cogsGbp: round2(cogsGbp), adCostGbp: round2(adCostGbp), netGbp: round2(netGbp), netPct: exVatRevenue > 0 ? netGbp / exVatRevenue : 0 };
}

export interface ProductNet {
  worstNetGbp: number;   // net of the WORST sellable variant (the decider)
  worstNetPct: number;
  belowFloor: boolean;   // worst variant fails £ OR % floor
  fromRetailGbp: number; // min sticker across variants (what the card shows; competitor compares to this)
}

/**
 * Product-level verdict input, mirroring productAffiliateEligible's variant
 * policy: EVERY sellable variant is evaluated and the product is judged on its
 * worst one. Returns null when no variant has a usable cost.
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
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/profitability.test.ts` — Expected: PASS. (If the high-ticket case doesn't clear the assertion, read the actual `netGbp` and adjust the test's cost inputs — do NOT weaken the engine.)
- [ ] **Step 5: Commit** — `git commit -am "feat(profit): deterministic net-after-ads engine + tests"`

---

### Task 3: Competitor signal + verdict + tests

**Files:**
- Modify: `src/profitability.ts` (append)
- Modify: `tests/profitability.test.ts` (append)

**Interfaces:**
- Consumes: `LlmClient` (`./llm`), `resolveChain` (`./llm-resolve`), `TenantStore` (`./tenant-store`), `TenantConfig` (`./types`), `DEFAULT_PROFIT`; `ProductNet` from Task 2.
- Produces: `competitorCacheKey(pid)`, `competitorSignal(llm, store, cfg, arg): Promise<CompetitorSignal | null>`, `profitVerdict({ net, competitor, profit }): { verdict: Verdict; reason: string }`.

- [ ] **Step 1: Write failing tests** (append to `tests/profitability.test.ts`):

```ts
import { profitVerdict, competitorCacheKey } from '../src/profitability';

describe('profitVerdict', () => {
  const net = { worstNetGbp: 8, worstNetPct: 0.2, belowFloor: false, fromRetailGbp: 20 };
  it('rejects when below the deterministic floor', () => {
    const v = profitVerdict({ net: { ...net, belowFloor: true, worstNetGbp: 1 }, competitor: null, profit: DEFAULT_PROFIT });
    expect(v.verdict).toBe('reject');
  });
  it('rejects on a HIGH-confidence competitor undercut beyond tolerance', () => {
    const v = profitVerdict({ net, competitor: { estimateGbp: 12, confidence: 'high', sources: ['amazon.co.uk'] }, profit: DEFAULT_PROFIT });
    expect(v.verdict).toBe('reject'); // £20 > £12 * 1.15
  });
  it('only REVIEWS on a low-confidence undercut', () => {
    const v = profitVerdict({ net, competitor: { estimateGbp: 12, confidence: 'low', sources: [] }, profit: DEFAULT_PROFIT });
    expect(v.verdict).toBe('review');
  });
  it('passes when priced at/under the competitor', () => {
    const v = profitVerdict({ net, competitor: { estimateGbp: 25, confidence: 'high', sources: [] }, profit: DEFAULT_PROFIT });
    expect(v.verdict).toBe('pass');
  });
  it('passes when there is no competitor signal', () => {
    expect(profitVerdict({ net, competitor: null, profit: DEFAULT_PROFIT }).verdict).toBe('pass');
  });
});

describe('competitorCacheKey', () => {
  it('namespaces by pid', () => { expect(competitorCacheKey('ABC')).toBe('comp:ABC'); });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run tests/profitability.test.ts` — Expected: FAIL (exports missing).

- [ ] **Step 3: Implement** (append to `src/profitability.ts`):

```ts
import { LlmClient } from './llm';
import { resolveChain } from './llm-resolve';
import type { TenantStore } from './tenant-store';
import type { TenantConfig } from './types';
import { DEFAULT_PROFIT } from './types';

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
  if (cached) { try { return JSON.parse(cached) as CompetitorSignal; } catch { /* re-fetch */ } }
  if (!llm.available || !cfg.llm.enabled) return null;
  const chain = resolveChain(cfg, 'text');
  const r = await llm.jsonChain<CompetitorSignal>({
    chain, maxTokens: 500, web: { maxResults: 5 },
    system:
      'You are a UK retail price researcher for a pet-care shop. Using live web search, find the typical UK retail price (GBP, including VAT) that comparable products sell for RIGHT NOW at mainstream UK retailers (Amazon.co.uk, Pets at Home, eBay UK, B&M, etc.). ' +
      'Respond with ONLY JSON: {"estimateGbp": <typical UK street price incl VAT for a comparable product, or 0 if you truly cannot find one>, "confidence": <"high" when several mainstream UK listings agree, "medium" when few, "low" when guessing or comparables are weak>, "sources": [<up to 3 short retailer/domain names>]}.',
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
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/profitability.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(profit): competitor signal + verdict + tests"`

---

### Task 4: Migration 0027 + tenant-store persistence

**Files:**
- Create: `migrations/0027_profitability.sql`
- Modify: `src/tenant-store.ts` (getConfig SELECT + merge, `saveProfit`, verdict CRUD)

**Interfaces:**
- Produces: `TenantConfig.profit` populated by `getConfig`; `store.saveProfit(profit)`, `store.upsertProfitVerdict(rec)`, `store.listProfitVerdicts(limit?)`, `store.getProfitVerdict(cjPid)`.

- [ ] **Step 1: Write the migration** `migrations/0027_profitability.sql`:

```sql
-- Profitability engine (2026-07-09): per-product net-after-ads + competition
-- verdicts (observe-first audit), and the dormant profit config block on
-- tenant_config. product_profit is one row per product; verdict in
-- pass|review|reject. Config rides the '{}' default + getConfig merge.

CREATE TABLE product_profit (
  shop                  TEXT NOT NULL,
  cj_pid                TEXT NOT NULL,
  verdict               TEXT NOT NULL DEFAULT 'pass',
  net_gbp               REAL,
  net_pct               REAL,
  our_retail_gbp        REAL,
  competitor_gbp        REAL,
  competitor_confidence TEXT,
  competitor_sources    TEXT,
  reason                TEXT NOT NULL DEFAULT '',
  checked_at            TEXT NOT NULL,
  PRIMARY KEY (shop, cj_pid)
);
CREATE INDEX idx_product_profit_shop ON product_profit (shop, verdict);

ALTER TABLE tenant_config ADD COLUMN profit TEXT NOT NULL DEFAULT '{}';
```

- [ ] **Step 2: Apply locally + remotely**:

```bash
npx wrangler d1 execute pawscout --local --file=migrations/0027_profitability.sql
npx wrangler d1 execute pawscout --remote --file=migrations/0027_profitability.sql
```
Expected: both report success. (Remote apply is an owner-authorized DB change; safe — additive only.)

- [ ] **Step 3: Wire `getConfig`** — add `profit` to the SELECT column list and the return object in `src/tenant-store.ts`:

SELECT (add `profit`):
```ts
.prepare(`SELECT collection_map, gates, pricing, floors, llm, addons, fulfil, inbox, semantic, target, profit FROM tenant_config WHERE shop = ?1`)
```
Row type (add `profit: string`), and in the returned object (after `semantic`):
```ts
      profit: { ...DEFAULT_PROFIT, ...JSON.parse(row.profit || '{}') },
```
Import `DEFAULT_PROFIT` at the top with the other type imports.

- [ ] **Step 4: Add savers/CRUD** near `saveInbox`:

```ts
  /** Persist the profitability config block. */
  async saveProfit(profit: ProfitConfig): Promise<void> {
    await this.db.prepare(`UPDATE tenant_config SET profit = ?2, updated_at = ?3 WHERE shop = ?1`)
      .bind(this.shop, JSON.stringify(profit), new Date().toISOString()).run();
  }

  /** Upsert a product's profitability verdict (observe audit output). */
  async upsertProfitVerdict(rec: {
    cjPid: string; verdict: string; netGbp: number | null; netPct: number | null; ourRetailGbp: number | null;
    competitorGbp: number | null; competitorConfidence: string | null; competitorSources: string[] | null; reason: string;
  }): Promise<void> {
    await this.db.prepare(
      `INSERT INTO product_profit (shop, cj_pid, verdict, net_gbp, net_pct, our_retail_gbp, competitor_gbp, competitor_confidence, competitor_sources, reason, checked_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
       ON CONFLICT(shop, cj_pid) DO UPDATE SET verdict=?3, net_gbp=?4, net_pct=?5, our_retail_gbp=?6, competitor_gbp=?7, competitor_confidence=?8, competitor_sources=?9, reason=?10, checked_at=?11`
    ).bind(this.shop, rec.cjPid, rec.verdict, rec.netGbp, rec.netPct, rec.ourRetailGbp, rec.competitorGbp, rec.competitorConfidence,
      rec.competitorSources ? JSON.stringify(rec.competitorSources) : null, rec.reason, new Date().toISOString()).run();
  }

  /** List verdicts worst-first (reject, then review, then pass) then lowest net. */
  async listProfitVerdicts(limit = 500): Promise<ProfitVerdictRow[]> {
    const { results } = await this.db.prepare(
      `SELECT cj_pid, verdict, net_gbp, net_pct, our_retail_gbp, competitor_gbp, competitor_confidence, competitor_sources, reason, checked_at
       FROM product_profit WHERE shop = ?1
       ORDER BY CASE verdict WHEN 'reject' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, net_gbp ASC LIMIT ?2`
    ).bind(this.shop, limit).all<ProfitVerdictRow>();
    return results ?? [];
  }

  async getProfitVerdict(cjPid: string): Promise<ProfitVerdictRow | null> {
    return await this.db.prepare(
      `SELECT cj_pid, verdict, net_gbp, net_pct, our_retail_gbp, competitor_gbp, competitor_confidence, competitor_sources, reason, checked_at
       FROM product_profit WHERE shop = ?1 AND cj_pid = ?2`
    ).bind(this.shop, cjPid).first<ProfitVerdictRow>();
  }
```

Add the row type + `ProfitConfig` to the imports; export near the other row types:
```ts
export interface ProfitVerdictRow {
  cj_pid: string; verdict: string; net_gbp: number | null; net_pct: number | null; our_retail_gbp: number | null;
  competitor_gbp: number | null; competitor_confidence: string | null; competitor_sources: string | null; reason: string; checked_at: string;
}
```
And extend the top import: `..., DEFAULT_PROFIT, type ProfitConfig, ...`.

- [ ] **Step 5: Typecheck + commit** — `npx tsc --noEmit` then `git add -A && git commit -m "feat(profit): migration 0027 + tenant-store persistence"`

---

### Task 5: Import gate in confirmAndImport + tests

**Files:**
- Modify: `src/proxy/import.ts` (`confirmAndImport` gate + `importProduct`/`confirmAndImport` opts `extraTags`)
- Modify: `tests/import.test.ts` (append)

**Interfaces:**
- Consumes: `productNetAfterAds` from `./profitability`.
- Produces: import-time REJECT (hardBlock) / REVIEW-draft (observe) behaviour; `opts.extraTags` threaded to product tags.

- [ ] **Step 1: Run graphite blast-radius** — `python -m graphite query "callers confirmAndImport"` and `python -m graphite context src/proxy/import.ts`. Confirm the 3 lanes (index.ts /proxy/product, jobs.ts promote, jobs.ts seedOriginAssortment). Read those call sites.

- [ ] **Step 2: Write the failing test** (append to `tests/import.test.ts`, following the existing `confirmAndImport` test setup in that file for the store/cj/admin fakes):

```ts
it('confirmAndImport hard-blocks a below-floor product when profit.hardBlock is on', async () => {
  // A high cost+freight detail that nets below the floor after ads.
  const detail = makeDetail({ pid: 'LOSS1', variants: [{ vid: 'v1', sku: 's1', name: 'One', sellPriceUsd: 140, stock: 50 }], freightUsd: 25 });
  const cfg = makeCfg({ profit: { ...DEFAULT_PROFIT, enabled: true, hardBlock: true } });
  const store = makeStore(); const cj = makeCj({ stock: 50, origins: gbOrigins() });
  await confirmAndImport(store, cj, admin, cfg, detail, null);
  expect(store.links.get('LOSS1')?.state).toBe('failed');
  expect(admin.calls.find((c) => c.q.includes('productSet'))).toBeUndefined(); // never imported
});

it('confirmAndImport imports a below-floor product as a DRAFT in review mode (enabled, not hardBlock)', async () => {
  const detail = makeDetail({ pid: 'LOSS2', variants: [{ vid: 'v1', sku: 's1', name: 'One', sellPriceUsd: 140, stock: 50 }], freightUsd: 25 });
  const cfg = makeCfg({ profit: { ...DEFAULT_PROFIT, enabled: true, hardBlock: false } });
  const store = makeStore(); const cj = makeCj({ stock: 50, origins: gbOrigins() });
  await confirmAndImport(store, cj, admin, cfg, detail, null);
  const link = store.links.get('LOSS2');
  expect(link?.state).toBe('draft'); // imported but unpublished for review
});

it('confirmAndImport ignores profit entirely when disabled (default)', async () => {
  const detail = makeDetail({ pid: 'OK1', variants: [{ vid: 'v1', sku: 's1', name: 'One', sellPriceUsd: 140, stock: 50 }], freightUsd: 25 });
  const cfg = makeCfg({}); // profit undefined/dormant
  const store = makeStore(); const cj = makeCj({ stock: 50, origins: gbOrigins() });
  await confirmAndImport(store, cj, admin, cfg, detail, null);
  expect(store.links.get('OK1')?.state).toBe('imported'); // normal path, published
});
```

(Reuse the file's existing `makeDetail`/`makeCfg`/`makeStore`/`makeCj`/`admin`/`gbOrigins` helpers; if a helper is named differently, match the existing tests in `tests/import.test.ts`. Import `DEFAULT_PROFIT` from `../src/types`.)

- [ ] **Step 3: Run to verify fail** — `npx vitest run tests/import.test.ts` — Expected: FAIL.

- [ ] **Step 4: Implement the gate** — in `src/proxy/import.ts`, add the import and insert the gate in `confirmAndImport` AFTER the live-stock block (right before `await importProduct(...)` at ~line 270):

Import at top:
```ts
import { productNetAfterAds } from '../profitability';
```

Insert before `await importProduct(store, admin, cfg, detail, category, opts);`:
```ts
  // Profitability gate (DORMANT unless cfg.profit.enabled). Deterministic
  // net-after-ads only - the competition (LLM+web) check runs in the nightly
  // audit, never this batch import path (seed/refill lanes stay cheap).
  const profit = cfg.profit;
  if (profit?.enabled) {
    const net = productNetAfterAds(detail.variants, cfg.pricing, detail.freightUsd, profit);
    if (net?.belowFloor) {
      if (profit.hardBlock) {
        console.warn(`import blocked (below profit floor) for ${detail.pid}: net GBP ${net.worstNetGbp.toFixed(2)} (${Math.round(net.worstNetPct * 100)}%)`);
        await store.putLink({ cjPid: detail.pid, state: 'failed', category: category ?? null });
        return;
      }
      // Observe/review: import as a DRAFT for owner review, never hard-reject.
      console.warn(`import flagged for review (below profit floor) for ${detail.pid}: net GBP ${net.worstNetGbp.toFixed(2)}`);
      opts = { ...opts, publish: false, extraTags: [...(opts.extraTags ?? []), 'cj-profit-review'] };
    }
  }
```

- [ ] **Step 5: Thread `extraTags`** — extend both opts types (`confirmAndImport` and `importProduct`) from `{ publish?: boolean; localWarehouses?: string[]; marketTag?: string }` to add `; extraTags?: string[]`, and in `importProduct`'s `tags` array append `...(opts.extraTags ?? [])`:

```ts
      tags: [IMPORT_TAG, `cj-pid-${detail.pid}`, ...(opts.marketTag ? [opts.marketTag] : []), ...(opts.extraTags ?? []), ...(isAddon ? [ADDON_TAG] : []), ...],
```

- [ ] **Step 6: Run to verify pass** — `npx vitest run tests/import.test.ts` — Expected: PASS (new + existing).
- [ ] **Step 7: graphite build + commit** — `python -m graphite build .` then `git commit -am "feat(profit): import gate in confirmAndImport (dormant)"`

---

### Task 6: Audit agent + nightly stage + tests

**Files:**
- Modify: `src/profitability.ts` (append `auditProfitability`)
- Modify: `src/jobs.ts` (new STAGE `profit-audit`; import `auditProfitability`)
- Create: `tests/profit-audit.test.ts`

**Interfaces:**
- Consumes: `TenantStore`, `LlmClient`, `TenantConfig`, `CjDetail` (`./cj`); `productNetAfterAds`, `competitorSignal`, `profitVerdict` (Tasks 2-3).
- Produces: `auditProfitability(store, llm, cfg, { offset?, limit? }): Promise<{ scanned; flagged; total; next }>`.

- [ ] **Step 1: Write the failing test** `tests/profit-audit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { auditProfitability } from '../src/profitability';
import { DEFAULT_PROFIT } from '../src/types';

function fakeStore(details: Record<string, any>) {
  const verdicts: any[] = [];
  return {
    verdicts,
    listImportedLinks: async () => Object.keys(details).map((pid) => ({ cj_pid: pid, shopify_product_id: `gid://${pid}` })),
    getWarehouseProduct: async (pid: string) => details[pid] ? { detail: JSON.stringify(details[pid]) } : null,
    getSearchCache: async () => null,
    putSearchCache: async () => {},
    logLlmUsage: async () => {},
    upsertProfitVerdict: async (rec: any) => { verdicts.push(rec); },
  } as any;
}
const noLlm = { available: false } as any;

describe('auditProfitability', () => {
  it('no-ops when profit is disabled', async () => {
    const store = fakeStore({ P1: { pid: 'P1', nameEn: 'x', variants: [{ sellPriceUsd: 10 }], freightUsd: 0 } });
    const r = await auditProfitability(store, noLlm, { pricing: PRICING, profit: { ...DEFAULT_PROFIT, enabled: false } } as any, {});
    expect(r.scanned).toBe(0); expect(store.verdicts.length).toBe(0);
  });
  it('writes a verdict per product when enabled (deterministic, no LLM)', async () => {
    const store = fakeStore({
      GOOD: { pid: 'GOOD', nameEn: 'cheap toy', variants: [{ sellPriceUsd: 10 }], freightUsd: 0 },
      LOSS: { pid: 'LOSS', nameEn: 'big table', variants: [{ sellPriceUsd: 140 }], freightUsd: 25 },
    });
    const cfg = { pricing: PRICING, llm: { enabled: false }, profit: { ...DEFAULT_PROFIT, enabled: true } } as any;
    const r = await auditProfitability(store, noLlm, cfg, {});
    expect(r.scanned).toBe(2);
    expect(store.verdicts.find((v) => v.cjPid === 'LOSS')?.verdict).toBe('reject');
    expect(store.verdicts.find((v) => v.cjPid === 'GOOD')?.verdict).toBe('pass');
  });
});

const PRICING = { multiplier: 2.2, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2, maxMarginGbp: 30 };
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run tests/profit-audit.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `auditProfitability`** (append to `src/profitability.ts`):

```ts
import type { CjDetail } from './cj';

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
  const limit = opts.limit ?? 20;
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
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/profit-audit.test.ts` — Expected: PASS.

- [ ] **Step 5: Wire the nightly stage** — in `src/jobs.ts`, import `auditProfitability` (extend the `./profitability` import if any, else add one) and add a STAGE near `store-inventory` (verify `DailyShopCtx` exposes `llm`; the blog/semantic stages use it, so it does):

```ts
  {
    name: 'profit-audit', maxMs: 6 * MIN_MS, needsCj: false,
    async run(ctx, offset, deadline) {
      if (!ctx.cfg.profit?.enabled) return; // dormant: no spend
      let off: number | null = offset;
      while (off !== null) {
        const r = await auditProfitability(ctx.store, ctx.llm, ctx.cfg, { offset: off, limit: 20 });
        off = r.next;
        if (off !== null && Date.now() > deadline) return off; // checkpoint
      }
    },
  },
```

- [ ] **Step 6: Typecheck + graphite + commit** — `npx tsc --noEmit`, `python -m graphite build .`, `git commit -am "feat(profit): observe-first audit agent + nightly stage"`

---

### Task 7: Console Profitability view + actions

**Files:**
- Read first: `src/console/views/catalog.ts` + how `src/console/page.ts` / the console router registers a view + a POST action (follow the exact existing pattern; do NOT invent one).
- Create: `src/console/views/profit.ts`
- Modify: the console router/page to add a "Profitability" nav entry + `POST` actions `profit-audit-run` (run a batch now) and `profit-archive` (owner-confirm archive of one product).
- Modify: `tests/console.test.ts` (a render smoke test; per memory, ALWAYS run this after editing console files).

**Interfaces:**
- Consumes: `store.listProfitVerdicts()`, `store.getLink()`, existing archive/cull helper (find the one the current "cull"/archive path uses; reuse it).
- Produces: a read-only-by-default Profitability view; Run-now populates verdicts; Archive is per-row + owner-confirmed.

- [ ] **Step 1:** Read `src/console/views/catalog.ts` and the console router to learn the view + action registration and the archive helper.
- [ ] **Step 2:** Implement `src/console/views/profit.ts` rendering `listProfitVerdicts()` as a table (verdict badge, net GBP + %, our price, competitor est + confidence, reason, checked-at), sorted worst-first (the query already does this), with a header "Run audit now" button and a per-row "Archive (confirm)" button shown only for reject/review rows. Mirror the catalog view's table markup + action-button wiring.
- [ ] **Step 3:** Register the nav entry + the two POST actions. `profit-audit-run` calls `auditProfitability` for one batch and re-renders. `profit-archive` archives one product via the existing archive path (never auto; triggered only by the button) and re-renders.
- [ ] **Step 4:** Add a `console.test.ts` case asserting the Profitability view renders with an empty verdict list and with one seeded reject row.
- [ ] **Step 5: Run** — `npx vitest run tests/console.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat(profit): console Profitability view + owner-confirm archive"`

---

### Task 8: Typecheck, full tests, deploy dormant, verify

- [ ] **Step 1: Typecheck** — `npx tsc --noEmit` — Expected: clean.
- [ ] **Step 2: Run the affected suites** (space batches per the workerd-wedge memory — do not run the whole suite in one shot):
  - `npx vitest run tests/profitability.test.ts tests/profit-audit.test.ts`
  - `npx vitest run tests/import.test.ts`
  - `npx vitest run tests/console.test.ts`
  - `npx vitest run tests/pricing.test.ts tests/affiliate.test.ts` (regression: engine reuses these)
  Expected: all PASS.
- [ ] **Step 3: graphite build** — `python -m graphite build .`
- [ ] **Step 4: Deploy** (owner go) — `npx wrangler deploy` — Expected: new version id.
- [ ] **Step 5: Verify DORMANT live** — confirm `enabled=false` means zero behaviour change:
  - `npx wrangler d1 execute pawscout --remote --command "SELECT profit FROM tenant_config WHERE shop='4qkudm-ez.myshopify.com'"` → `{}` or `enabled:false`.
  - `npx wrangler d1 execute pawscout --remote --command "SELECT COUNT(*) FROM product_profit"` → 0 (nothing observed yet; audit no-ops while dormant).
  - The nightly `profit-audit` stage returns immediately (dormant).
- [ ] **Step 6: Commit any final touch + push.**

---

## Self-Review

**Spec coverage:** engine (`netAfterAdsGbp`/`productNetAfterAds`/`competitorSignal`/`profitVerdict`) = Tasks 2-3; import gate w/ observe/enforce = Task 5; audit agent + nightly stage = Task 6; console view + owner-confirm archive = Task 7; config + persistence = Tasks 1, 4; dormant default + live pricing + variant policy = Global Constraints, enforced in Tasks 2/5/6. All spec sections covered.

**Placeholder scan:** Task 7 is the only lighter task (console markup is read-then-mirror, not invented); its store-side + action code and the exact files/pattern to copy are named. All other tasks carry full code.

**Type consistency:** `ProductNet` (worstNetGbp/worstNetPct/belowFloor/fromRetailGbp), `CompetitorSignal` (estimateGbp/confidence/sources), `Verdict`, `ProfitConfig`, `ProfitVerdictRow`, and `upsertProfitVerdict`'s record shape are used identically across Tasks 2-7.
