# GB-Warehouse Sourcing Pass - Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CJ GB-warehoused pet products to the catalog as owner-reviewed Shopify DRAFTS, reusing the existing discovery -> curation -> import chain with a new warehouse-filtered discovery method and a DRAFT import disposition.

**Architecture:** A new additive `cj.searchByWarehouse` discovers GB-warehoused candidates via CJ's `/product/list?countryCode=GB`. A new `seedOriginAssortment` orchestrator (jobs.ts) walks per-collection keywords, caches each candidate's detail (with GB origins) into `warehouse_products`, and imports it through the existing `confirmAndImport` with a new `publish:false` flag that creates a Shopify `DRAFT` (status DRAFT, no Online-Store publish) and records a `draft` link state. A daily `reconcileDraftLinks` flips `draft` -> `imported` once the owner publishes. A secret-gated temporary route triggers the seed.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Vitest (`@cloudflare/vitest-pool-workers`), Shopify Admin GraphQL, CJ Dropshipping API (via the egress relay). Spec: `docs/superpowers/specs/2026-06-24-gb-warehouse-sourcing-design.md`.

## Global Constraints

- **No DB migration needed** for the `draft` link state: `product_links.state` is `TEXT NOT NULL DEFAULT 'ghost'` with no CHECK constraint. The change is a TypeScript union widening only.
- **`publish` flag defaults to `true`** so every existing `confirmAndImport`/`importProduct` caller (ghost-click import in `index.ts`, `refillCollections` in `jobs.ts`) is byte-for-byte unchanged.
- **`refillCollections` must skip `draft` links** (they are pending owner review; the auto-publishing cron must never promote them).
- **Governance (customer-facing):** never name a fulfilment origin to customers; GB fast-delivery is a per-SKU real claim only, never blanket; no em/en-dashes anywhere; only real & defensible copy. (memories `no-uk-fulfilment-claim`, `customer-facing-only-real-defensible`, `no-em-dash`)
- **Graphite (GRAPHITE.md):** before editing `src/cj.ts`, `src/proxy/import.ts`, `src/jobs.ts`, `src/index.ts` run `python -m graphite context <file>` and `python -m graphite impact <file>`; after all edits run `python -m graphite build .`; never edit `graph-out/` by hand.
- **Tests:** TDD; run per-file/batched (the monolithic `vitest run` hits a workerd loopback limit); `npx tsc --noEmit` must stay clean. Test harness: `import { env, applyD1Migrations } from 'cloudflare:test'` + `new TenantStore(env.DB, SHOP)`; fakes for `AdminGraphql` and `CjClient` follow the patterns already in `tests/import.test.ts`, `tests/cj.test.ts`, and `tests/logistics-sync.test.ts`.
- **Production gating:** `wrangler deploy` and the live seed run need explicit owner go; `git push` is automatic after each commit (memory `auto-push-to-github`).
- **Scope:** Phase 1 only. Phase 2 (the ongoing cron bias / reserved-slot promotion) is explicitly OUT of scope.

---

### Task 1: GB warehouse-filtered discovery (`cj.searchByWarehouse`)

**Files:**
- Modify: `src/cj.ts` (add a method to `class CjClient`, near `search`/`searchV2` ~line 288-323)
- Test: `tests/cj.test.ts`

**Interfaces:**
- Consumes: the existing private `this.get(path, params)` (GETs `${CJ_BASE}${path}?${qs}` with the CJ token header) and the module-level `mapCjSearchItems(list)`.
- Produces: `cj.searchByWarehouse(keyword: string, countryCode?: string, pageSize?: number): Promise<CjSearchItem[]>` (used by Task 4).

- [ ] **Step 1: Write the failing test**

In `tests/cj.test.ts` (follow the existing fake-fetch + token-fn construction in that file):

```ts
it('searchByWarehouse queries /product/list with the warehouse countryCode', async () => {
  let calledUrl = '';
  const fakeFetch = (async (url: string) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({
      result: true,
      data: { total: 1, list: [{ pid: 'P1', productNameEn: 'Dog Nail Clipper', sellPrice: '5.99', listedNum: 42 }] }
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const cj = new CjClient(async () => 'tok', fakeFetch);

  const items = await cj.searchByWarehouse('nail clipper', 'GB', 50);

  expect(calledUrl).toContain('/product/list');
  expect(calledUrl).toContain('countryCode=GB');
  expect(calledUrl).toContain('productNameEn=nail+clipper');
  expect(items).toEqual([{ pid: 'P1', nameEn: 'Dog Nail Clipper', image: '', sellPriceUsd: 5.99, listedNum: 42, categoryName: '', topCategory: '' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cj.test.ts -t searchByWarehouse`
Expected: FAIL with `cj.searchByWarehouse is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/cj.ts`, add to `class CjClient` (right after the `search` method):

```ts
  /**
   * Warehouse-filtered discovery: products CJ stocks in `countryCode`'s warehouse.
   * Uses /product/list (the legacy keyword endpoint) because it honors the
   * `countryCode` warehouse filter that listV2 does not - the LLM curation gate
   * downstream is the real niche filter, so the endpoint's lower precision is fine.
   */
  async searchByWarehouse(keyword: string, countryCode = 'GB', pageSize = 50): Promise<CjSearchItem[]> {
    const data = (await this.get('/product/list', {
      productNameEn: keyword,
      countryCode,
      pageNum: '1',
      pageSize: String(pageSize)
    })) as { list?: Record<string, unknown>[] } | null;
    return mapCjSearchItems(data?.list);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cj.test.ts -t searchByWarehouse`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cj.ts tests/cj.test.ts
git commit -m "feat(cj): add searchByWarehouse (countryCode warehouse filter)"
```

---

### Task 2: DRAFT import disposition (`publish` flag + `draft` link state)

**Files:**
- Modify: `src/tenant-store.ts:13-23` (widen `ProductLink['state']` union to add `'draft'`)
- Modify: `src/proxy/import.ts` (`confirmAndImport` ~line 151-241 and `importProduct` ~line 269-389: add `publish` option)
- Modify: `src/jobs.ts` (`refillCollections.promote` ~line 73-82: skip `draft` links)
- Test: `tests/import.test.ts`

**Interfaces:**
- Consumes: existing `importProduct`/`confirmAndImport` bodies, the `PRODUCT_SET`/`PUBLICATIONS`/`PUBLISH` GraphQL constants, `store.putLink`.
- Produces:
  - `importProduct(store, admin, cfg, detail, category?, opts?: { publish?: boolean }): Promise<void>`
  - `confirmAndImport(store, cj, admin, cfg, detail, category?, curate?, pickHero?, opts?: { publish?: boolean }): Promise<void>`
  - `ProductLink['state']` now includes `'draft'`.

- [ ] **Step 1: Write the failing test**

In `tests/import.test.ts` (reuse the file's existing fake-admin recorder + `TenantStore` setup):

```ts
it('publish:false imports as DRAFT, skips Online-Store publish, and links state=draft', async () => {
  const ops: { q: string; vars: any }[] = [];
  const admin = (async (q: string, vars: any) => {
    ops.push({ q, vars });
    if (q.includes('productSet')) return { productSet: { product: { id: 'gid://shopify/Product/1', handle: 'h' }, userErrors: [] } };
    if (q.includes('publications(')) return { publications: { nodes: [{ id: 'pub1', name: 'Online Store' }] } };
    return {};
  }) as unknown as AdminGraphql;
  const store = new TenantStore(env.DB, SHOP);
  const detail: CjDetail = { pid: 'P1', nameEn: 'Dog Brush', images: [], descriptionHtml: 'x', variants: [{ vid: 'V1', name: 'Default', sellPriceUsd: 6, sku: 'S1', stock: 50 }], listedNum: 10, categoryName: 'pet-grooming', stock: 50, llmScore: 90 };

  await importProduct(store, admin, CFG, detail, 'pet-grooming', { publish: false });

  const setOp = ops.find((o) => o.q.includes('productSet'))!;
  expect(setOp.vars.input.status).toBe('DRAFT');
  expect(ops.some((o) => o.q.includes('publishablePublish'))).toBe(false);
  expect((await store.getLink('P1'))?.state).toBe('draft');
});

it('default (publish omitted) imports ACTIVE, publishes, links state=imported', async () => {
  const ops: string[] = [];
  const admin = (async (q: string) => {
    ops.push(q);
    if (q.includes('productSet')) return { productSet: { product: { id: 'gid://shopify/Product/2', handle: 'h2' }, userErrors: [] } };
    if (q.includes('publications(')) return { publications: { nodes: [{ id: 'pub1', name: 'Online Store' }] } };
    return {};
  }) as unknown as AdminGraphql;
  const store = new TenantStore(env.DB, SHOP);
  const detail: CjDetail = { pid: 'P2', nameEn: 'Cat Toy', images: [], descriptionHtml: 'x', variants: [{ vid: 'V2', name: 'Default', sellPriceUsd: 6, sku: 'S2', stock: 50 }], listedNum: 10, categoryName: 'pet-toys', stock: 50, llmScore: 90 };

  await importProduct(store, admin, CFG, detail, 'pet-toys');

  expect(ops.some((q) => q.includes('publishablePublish'))).toBe(true);
  expect((await store.getLink('P2'))?.state).toBe('imported');
});
```

(`SHOP`, `CFG`, and the `beforeEach`/`applyD1Migrations` setup already exist in `tests/import.test.ts`; reuse them. If `CFG` is absent, build a minimal `TenantConfig` as the other tests do.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/import.test.ts -t "publish:false"`
Expected: FAIL (status is `ACTIVE`; publish mutation runs; link is `imported`).

- [ ] **Step 3: Widen the link-state union**

In `src/tenant-store.ts`, change the `ProductLink.state` field (line 19):

```ts
  state: 'ghost' | 'importing' | 'imported' | 'archived' | 'failed' | 'draft';
```

- [ ] **Step 4: Thread the `publish` flag through the import path**

In `src/proxy/import.ts`:

`confirmAndImport` signature - add the trailing option and forward it:

```ts
export async function confirmAndImport(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  detail: CjDetail,
  category?: string | null,
  curate?: (detail: CjDetail, context: string) => Promise<Curation | null>,
  pickHero?: (title: string, imageUrls: string[]) => Promise<HeroPick>,
  opts: { publish?: boolean } = {}
): Promise<void> {
```

At its final line, replace `await importProduct(store, admin, cfg, detail, category);` with:

```ts
  await importProduct(store, admin, cfg, detail, category, opts);
```

`importProduct` signature - add the option and a local:

```ts
export async function importProduct(
  store: TenantStore,
  admin: AdminGraphql,
  cfg: TenantConfig,
  detail: CjDetail,
  category?: string | null,
  opts: { publish?: boolean } = {}
): Promise<void> {
  const publish = opts.publish ?? true;
```

In `importProduct`, the revival branch - make status follow `publish` and record the matching state:

```ts
    if (existing?.shopify_product_id) {
      const data = await admin(PRODUCT_STATUS, { input: { id: existing.shopify_product_id, status: publish ? 'ACTIVE' : 'DRAFT' } });
      const err = firstUserError(data, 'productUpdate');
      if (err) throw new Error(err);
      await store.putLink({ cjPid: detail.pid, state: publish ? 'imported' : 'draft' });
      return;
    }
```

In the `input` object, replace `status: 'ACTIVE',` with:

```ts
      status: publish ? 'ACTIVE' : 'DRAFT',
```

Wrap the Online-Store publish block so it only runs when publishing:

```ts
    if (publish) {
      try {
        const pubs = (await admin(PUBLICATIONS)) as { publications?: { nodes?: { id: string; name: string }[] } };
        const online = pubs.publications?.nodes?.find((p) => p.name === 'Online Store');
        if (online) {
          const pubData = await admin(PUBLISH, { id: product.id, input: [{ publicationId: online.id }] });
          const pubErr = firstUserError(pubData, 'publishablePublish');
          if (pubErr) console.warn(`publish failed for ${detail.pid}: ${pubErr}`);
        }
      } catch (e) {
        console.warn(`publish failed for ${detail.pid}: ${(e as Error).message}`);
      }
    }
```

Change the success `putLink` to record the matching state:

```ts
    await store.putLink({
      cjPid: detail.pid,
      state: publish ? 'imported' : 'draft',
      shopifyProductId: product.id,
      handle: product.handle,
      category: cat
    });
```

- [ ] **Step 5: Skip `draft` links in the refill cron**

In `src/jobs.ts`, `refillCollections.promote` (~line 76), widen the skip so the auto-publishing cron never promotes a pending-review draft:

```ts
    if (link && (link.state === 'imported' || link.state === 'importing' || link.state === 'draft')) return false;
```

- [ ] **Step 6: Add a refill regression test for the draft skip**

In `tests/jobs.test.ts` (or wherever `refillCollections` is tested), add:

```ts
it('refillCollections never promotes a draft-state link', async () => {
  const store = new TenantStore(env.DB, SHOP);
  // seed a warehouse row for category pet-toys + a draft link for it
  await store.putWarehouseProduct({ cjPid: 'D1', category: 'pet-toys', title: 'Cat Toy', detailJson: JSON.stringify({ pid: 'D1', nameEn: 'Cat Toy', images: [], descriptionHtml: '', variants: [{ vid: 'V', name: 'Default', sellPriceUsd: 6, sku: 'S', stock: 50 }], listedNum: 5, categoryName: 'pet-toys', stock: 50 }), priceUsd: 6, listedNum: 5, stock: 50 });
  await store.putLink({ cjPid: 'D1', state: 'draft', shopifyProductId: 'gid://shopify/Product/9', category: 'pet-toys' });
  const admin = (async () => ({})) as unknown as AdminGraphql;
  const cj = { stockByPid: async () => new Map([['V', 50]]) } as unknown as CjClient;

  await refillCollections(store, cj, admin, CFG_WITH_PETTOYS, { maxImports: 5 });

  // the draft link is untouched (still draft, not re-imported/published)
  expect((await store.getLink('D1'))?.state).toBe('draft');
});
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/import.test.ts tests/jobs.test.ts` then `npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/tenant-store.ts src/proxy/import.ts src/jobs.ts tests/import.test.ts tests/jobs.test.ts
git commit -m "feat(import): DRAFT disposition (publish flag) + draft link state"
```

---

### Task 3: Capture $0 GB-domestic freight (`freightEstimate` -> `freightQuoteAging`)

**Files:**
- Modify: `src/cj.ts` (`freightEstimate` ~line 431-434)
- Test: `tests/cj.test.ts`

**Interfaces:**
- Consumes: the existing `freightQuoteAging` (keeps `priceUsd:0` options, sorts cheapest-first).
- Produces: `freightEstimate` unchanged signature, now returning the $0 option for domestic routes instead of `null`.

**Why:** GB->GB (and US->US) freight is $0; `freightQuote` drops `priceUsd > 0` options, so `freightEstimate` returns `null` and `confirmAndImport` leaves `freightUsd` undefined. Using `freightQuoteAging` records the genuine $0 (correct COGS/affiliate-eligibility). CN->GB has no $0 options, so its cheapest is unchanged - no regression.

- [ ] **Step 1: Write the failing test**

```ts
it('freightEstimate returns the $0 domestic option (GB->GB) instead of null', async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({
    result: true,
    data: [{ logisticName: 'Royal Mail GB to GB', logisticAging: '2-5', logisticPrice: 0 }]
  }), { status: 200 })) as unknown as typeof fetch;
  const cj = new CjClient(async () => 'tok', fakeFetch);

  const est = await cj.freightEstimate('V1', 'GB', 'GB');

  expect(est).not.toBeNull();
  expect(est!.priceUsd).toBe(0);
  expect(est!.days).toBe('2-5');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cj.test.ts -t "freightEstimate returns the"`
Expected: FAIL (`est` is `null` because `freightQuote` dropped the $0 option).

- [ ] **Step 3: Implement**

In `src/cj.ts`, `freightEstimate`, change the call from `freightQuote` to `freightQuoteAging`:

```ts
  async freightEstimate(vid: string, fromCountry = 'CN', toCountry = 'GB', quantity = 1): Promise<{ priceUsd: number; days: string; name: string } | null> {
    const options = await this.freightQuoteAging(vid, fromCountry, toCountry, quantity);
    return options.length ? options[0] : null;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cj.test.ts` then `npx tsc --noEmit`
Expected: PASS (incl. existing freight tests - CN routes unchanged); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/cj.ts tests/cj.test.ts
git commit -m "fix(cj): freightEstimate keeps $0 domestic options via freightQuoteAging"
```

---

### Task 4: `seedOriginAssortment` orchestrator

**Files:**
- Modify: `src/jobs.ts` (add the orchestrator + its keyword map; near `replenishWarehouse`/`refillCollections`)
- Test: `tests/seed-origin.test.ts` (new)

**Interfaces:**
- Consumes: `cj.searchByWarehouse` (Task 1), `confirmAndImport(..., { publish: false })` (Task 2), `getCachedDetail` (from `./proxy/import`), `store.getLink`, `store.putWarehouseProduct`, `store.warehouseTitles`, `titleSignature` + `normalizeKeyword` (from `./proxy/search`), `CJ_CALL_GAP_MS`.
- Produces: `seedOriginAssortment(store, cj, admin, cfg, opts?): Promise<{ discovered: number; drafted: number; rejected: number }>` where `opts` is `{ countryCode?: string; perCollection?: number; curate?; pickHero?; pause?; keywords?: Record<string, string[]> }` (used by Task 6).

**Note on the summary:** `drafted` = candidates that passed the FULL gate chain inside `confirmAndImport` (curation + pet-floor + image QA + stock) and were written as a `draft` link. `rejected` = discovered candidates that failed any gate (link ends `failed`) or had no detail / were title-duplicates. We do not separately report curation-only pass because `confirmAndImport` owns curation internally (kept DRY - no duplicated gate logic in the orchestrator).

- [ ] **Step 1: Write the failing test**

In `tests/seed-origin.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { TenantStore } from '../src/tenant-store';
import { seedOriginAssortment } from '../src/jobs';
import type { CjClient, CjDetail, CjSearchItem } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';

const SHOP = 'test.myshopify.com';
// minimal config with one collection; mirror the config builder used in tests/jobs.test.ts
const CFG: any = { collectionMap: { 'pet-toys': { tag: 'pet-toys' } }, gates: { popularityFloor: 0, priceMin: 0.5, priceMax: 80, relevance: 'strict' }, floors: { warehouseDepth: 20, storeFloor: 8, stockFloor: 10 }, pricing: { multiplier: 2.7, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2 }, llm: { enabled: false, scoreThreshold: 60 }, addons: { enabled: false }, target: 12 };

function fakeCj(): CjClient {
  const detail = (pid: string, name: string): CjDetail => ({ pid, nameEn: name, images: ['https://img/x.jpg'], descriptionHtml: 'x', variants: [{ vid: `v-${pid}`, name: 'Default', sellPriceUsd: 6, sku: pid, stock: 50 }], listedNum: 20, categoryName: 'pet-toys', stock: 50, origins: { CN: 100, GB: 40 } });
  return {
    searchByWarehouse: async (kw: string): Promise<CjSearchItem[]> => ([
      { pid: 'GB1', nameEn: 'Dog Chew Toy', image: '', sellPriceUsd: 6, listedNum: 20, categoryName: 'pet-toys' },
      { pid: 'GB1', nameEn: 'Dog Chew Toy', image: '', sellPriceUsd: 6, listedNum: 20, categoryName: 'pet-toys' } // dup pid
    ]),
    detail: async (pid: string) => detail(pid, 'Dog Chew Toy'),
    stockByPid: async () => new Map([['v-GB1', 50]]),
    freightEstimate: async () => ({ priceUsd: 0, days: '2-5', name: 'Royal Mail' })
  } as unknown as CjClient;
}

function fakeAdmin(): AdminGraphql {
  return (async (q: string) => {
    if (q.includes('productSet')) return { productSet: { product: { id: 'gid://shopify/Product/1', handle: 'h' }, userErrors: [] } };
    if (q.includes('locations') || q.includes('location')) return { locations: { nodes: [{ id: 'loc1' }] } };
    return {};
  }) as unknown as AdminGraphql;
}

describe('seedOriginAssortment', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

  it('discovers GB candidates, dedupes pids, caches origins, and DRAFT-imports', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const summary = await seedOriginAssortment(store, fakeCj(), fakeAdmin(), CFG, { countryCode: 'GB', perCollection: 12, pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });

    expect(summary.discovered).toBe(1);        // duplicate pid counted once
    expect(summary.drafted).toBe(1);
    expect((await store.getLink('GB1'))?.state).toBe('draft');
    const wh = await store.getWarehouseProduct('GB1');
    expect(wh).not.toBeNull();
    expect(JSON.parse(wh!.detail).origins.GB).toBe(40);   // origins cached for Phase-2 geo-ranking
  });

  it('skips a pid that is already linked', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.putLink({ cjPid: 'GB1', state: 'imported', shopifyProductId: 'gid://x', category: 'pet-toys' });
    const summary = await seedOriginAssortment(store, fakeCj(), fakeAdmin(), CFG, { pause: async () => {}, keywords: { 'pet-toys': ['dog chew toy'] } });
    expect(summary.discovered).toBe(0);
    expect(summary.drafted).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/seed-origin.test.ts`
Expected: FAIL with `seedOriginAssortment is not exported`.

- [ ] **Step 3: Implement the orchestrator**

In `src/jobs.ts`, add (imports at top: `getCachedDetail` from `./proxy/import`; `titleSignature`, `normalizeKeyword` from `./proxy/search` - some may already be imported):

```ts
/** Per-collection GB sourcing keywords (mirrors discover-cj-category-products.py). */
const SEED_KEYWORDS: Record<string, string[]> = {
  'pet-cleaning': ['pet cleaning wipes', 'paw cleaner', 'pet bath towel'],
  'pet-grooming': ['dog grooming brush', 'pet nail clipper', 'dog comb'],
  'pet-health': ['dog dental', 'dog supplement', 'pet probiotic'],
  'pet-toys': ['dog chew toy', 'cat toy', 'pet puzzle toy'],
  'pet-accessories': ['dog collar', 'dog harness', 'pet bowl', 'cat litter', 'pet carrier']
};

/**
 * One-off origin seed: discover products CJ warehouses in `countryCode`, cache
 * each (with its per-country origins) into warehouse_products, and DRAFT-import
 * it (status DRAFT, unpublished) for owner review. Reuses confirmAndImport's
 * full gate chain (curation/pet-floor/image-QA/stock); the only difference from
 * the cron is publish:false. Idempotent: skips pids already linked.
 */
export async function seedOriginAssortment(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  opts: {
    countryCode?: string;
    perCollection?: number;
    curate?: (detail: CjDetail, context: string) => Promise<Curation | null>;
    pickHero?: (title: string, imageUrls: string[]) => Promise<HeroPick>;
    pause?: (ms: number) => Promise<void>;
    keywords?: Record<string, string[]>;
  } = {}
): Promise<{ discovered: number; drafted: number; rejected: number }> {
  const cc = opts.countryCode ?? 'GB';
  const cap = opts.perCollection ?? 12;
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const keywords = opts.keywords ?? SEED_KEYWORDS;
  const seenTitleSigs = new Set((await store.warehouseTitles()).map(titleSignature));
  const seenPids = new Set<string>();
  let discovered = 0, drafted = 0, rejected = 0;

  for (const [category, kws] of Object.entries(keywords)) {
    let perCat = 0;
    for (const kw of kws) {
      if (perCat >= cap) break;
      const items = await cj.searchByWarehouse(normalizeKeyword(kw), cc);
      await pause(CJ_CALL_GAP_MS);
      for (const item of items) {
        if (perCat >= cap) break;
        if (seenPids.has(item.pid)) continue;
        seenPids.add(item.pid);
        const link = await store.getLink(item.pid);
        if (link && (link.state === 'imported' || link.state === 'importing' || link.state === 'draft')) continue;
        discovered++;
        const detail = await getCachedDetail(store, cj, item.pid);
        await pause(CJ_CALL_GAP_MS);
        if (!detail) { rejected++; continue; }
        const sig = titleSignature(detail.nameEn);
        if (seenTitleSigs.has(sig)) { rejected++; continue; }
        // Cache the detail (with per-country origins) so Phase-2 geo-ranking and
        // chooseOrigin read real GB origins from D1 after the owner publishes.
        await store.putWarehouseProduct({
          cjPid: detail.pid,
          category,
          title: detail.nameEn,
          detailJson: JSON.stringify(detail),
          priceUsd: detail.variants[0]?.sellPriceUsd ?? 0,
          listedNum: detail.listedNum,
          stock: detail.stock ?? 0
        });
        await confirmAndImport(store, cj, admin, cfg, detail, category, opts.curate, opts.pickHero, { publish: false });
        await pause(CJ_CALL_GAP_MS);
        if ((await store.getLink(detail.pid))?.state === 'draft') {
          drafted++; perCat++; seenTitleSigs.add(sig);
        } else {
          rejected++; // confirmAndImport's gate chain rejected it (link ends 'failed')
        }
      }
    }
  }
  return { discovered, drafted, rejected };
}
```

(If `confirmAndImport`, `Curation`, `HeroPick`, `CjDetail` are not already imported in `jobs.ts`, add them: `confirmAndImport, getCachedDetail` from `./proxy/import`; `Curation` from `./llm`; `CjDetail, CjClient` from `./cj`; `titleSignature, normalizeKeyword` from `./proxy/search`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/seed-origin.test.ts` then `npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/jobs.ts tests/seed-origin.test.ts
git commit -m "feat(jobs): seedOriginAssortment - GB discovery -> cache origins -> DRAFT import"
```

---

### Task 5: Reconcile `draft` -> `imported` on owner publish

**Files:**
- Modify: `src/tenant-store.ts` (add `linksByState`)
- Modify: `src/jobs.ts` (add `reconcileDraftLinks`; wire into `runDailyMaintenance`)
- Test: `tests/seed-origin.test.ts` (extend) or `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `store.putLink`, the Shopify Admin product-status query.
- Produces:
  - `store.linksByState(state: ProductLink['state']): Promise<ProductLink[]>`
  - `reconcileDraftLinks(store: TenantStore, admin: AdminGraphql): Promise<number>` (returns count flipped).

- [ ] **Step 1: Write the failing test**

```ts
it('reconcileDraftLinks flips only published (ACTIVE) drafts to imported', async () => {
  const store = new TenantStore(env.DB, SHOP);
  await store.putLink({ cjPid: 'A', state: 'draft', shopifyProductId: 'gid://shopify/Product/A', category: 'pet-toys' });
  await store.putLink({ cjPid: 'B', state: 'draft', shopifyProductId: 'gid://shopify/Product/B', category: 'pet-toys' });
  const admin = (async (_q: string, vars: any) => ({
    product: { status: vars.id.endsWith('/A') ? 'ACTIVE' : 'DRAFT' }
  })) as unknown as AdminGraphql;

  const flipped = await reconcileDraftLinks(store, admin);

  expect(flipped).toBe(1);
  expect((await store.getLink('A'))?.state).toBe('imported');
  expect((await store.getLink('B'))?.state).toBe('draft');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/seed-origin.test.ts -t reconcileDraftLinks`
Expected: FAIL with `reconcileDraftLinks is not exported`.

- [ ] **Step 3: Add the store accessor**

In `src/tenant-store.ts`, near the other `product_links` accessors:

```ts
  async linksByState(state: ProductLink['state']): Promise<ProductLink[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM product_links WHERE shop = ?1 AND state = ?2`)
      .bind(this.shop, state)
      .all<ProductLink>();
    return rs.results ?? [];
  }
```

- [ ] **Step 4: Add the reconcile job**

In `src/jobs.ts`:

```ts
const PRODUCT_STATUS_QUERY = `query pawscoutProductStatus($id: ID!) { product(id: $id) { status } }`;

/**
 * Flip seed drafts to 'imported' once the owner has published them (Shopify
 * status ACTIVE). Runs daily; cheap (one status query per outstanding draft).
 */
export async function reconcileDraftLinks(store: TenantStore, admin: AdminGraphql): Promise<number> {
  let flipped = 0;
  for (const link of await store.linksByState('draft')) {
    if (!link.shopify_product_id) continue;
    try {
      const data = (await admin(PRODUCT_STATUS_QUERY, { id: link.shopify_product_id })) as { product?: { status?: string } };
      if (data.product?.status === 'ACTIVE') {
        await store.putLink({ cjPid: link.cj_pid, state: 'imported' });
        flipped++;
      }
    } catch (e) {
      console.warn(`draft reconcile failed for ${link.cj_pid}: ${(e as Error).message}`);
    }
  }
  return flipped;
}
```

- [ ] **Step 5: Wire into `runDailyMaintenance`**

In `src/jobs.ts`, inside `runDailyMaintenance`'s per-tenant block (alongside the other reconciles, after `refillCollections`), add:

```ts
        await reconcileDraftLinks(store, admin);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/seed-origin.test.ts tests/jobs.test.ts` then `npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/tenant-store.ts src/jobs.ts tests/seed-origin.test.ts
git commit -m "feat(jobs): reconcileDraftLinks flips published seed drafts to imported"
```

---

### Task 6: Secret-gated seed trigger route

**Files:**
- Modify: `src/index.ts` (add the route; mirror the existing `phase:'refill'` admin block for LlmClient/curate/pickHero and `cjFor` for the CjClient)
- Modify: the `Env` interface (wherever it is declared - `src/types.ts` or `worker-configuration.d.ts`): add `MAINT_TOKEN?: string`
- Test: `tests/seed-route.test.ts` (new) - assert the token gate

**Interfaces:**
- Consumes: `seedOriginAssortment` (Task 4), `LlmClient`, `curateProduct`, `pickHeroImage` (from `./llm`), `makeAdminGraphql`, `CjTokenManager`, `cjFetchFromEnv`, `Vault`.
- Produces: `POST /api/admin/seed-gb-origin` returning `{ ok: true, ...summary }`.

- [ ] **Step 1: Write the failing test**

In `tests/seed-route.test.ts` (mirror the route-test setup used by other `/api/admin/*` tests - import the Hono `app` / default worker and call `app.request`):

```ts
it('POST /api/admin/seed-gb-origin rejects a missing/wrong MAINT_TOKEN', async () => {
  const res = await app.request('/api/admin/seed-gb-origin', { method: 'POST' }, { ...env, MAINT_TOKEN: 'secret' });
  expect(res.status).toBe(401);
});
```

(If the suite exercises routes through the default export rather than a named `app`, follow that file's existing convention.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/seed-route.test.ts`
Expected: FAIL (route not found -> 404, not 401).

- [ ] **Step 3: Add `MAINT_TOKEN` to the Env type**

In the `Env` interface declaration, add:

```ts
  MAINT_TOKEN?: string; // TEMPORARY: throwaway secret gating the one-off seed route; remove with the route.
```

- [ ] **Step 4: Implement the route**

In `src/index.ts` (place near the other `/api/admin/*` routes). It rebuilds the same deps the refill admin block builds, plus a `CjClient` the way `cjFor` does:

```ts
// TEMPORARY (GB seed, 2026-06-24): one-off owner-triggered GB-warehouse sourcing.
// Imports GB-warehoused pet products as DRAFTS for review. Remove this route AND
// the MAINT_TOKEN secret after the seed run completes.
app.post('/api/admin/seed-gb-origin', async (c) => {
  if (!c.env.MAINT_TOKEN || c.req.header('X-Maint-Token') !== c.env.MAINT_TOKEN) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  const shop = c.req.query('shop') ?? '4qkudm-ez.myshopify.com';
  const store = new TenantStore(c.env.DB, shop);
  const tenant = await store.getTenant();
  const cfg = await store.getConfig();
  if (!tenant?.access_token_enc || !cfg) return c.json({ ok: false, error: 'Not configured' }, 400);
  const vault = await Vault.fromMasterKey(c.env.PAWSCOUT_MASTER_KEY);
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  const admin = makeAdminGraphql(shop, accessToken);
  const f = cjFetchFromEnv(c.env);
  const cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
  const llm = new LlmClient({ openrouter: c.env.OPENROUTER_API_KEY, openai: c.env.OPENAI_API_KEY });
  const curate = llm.available && cfg.llm.enabled
    ? (d: Parameters<typeof curateProduct>[3], ctx: string) => curateProduct(llm, store, cfg, d, ctx)
    : undefined;
  const pickHero = llm.available && cfg.llm.enabled
    ? (title: string, urls: string[]) => pickHeroImage(llm, store, cfg, title, urls)
    : undefined;
  try {
    const summary = await seedOriginAssortment(store, cj, admin, cfg, { countryCode: 'GB', curate, pickHero });
    return c.json({ ok: true, ...summary });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});
```

(Add `seedOriginAssortment` to the existing `from './jobs'` import; `CjClient`, `CjTokenManager`, `cjFetchFromEnv` from `./cj`. `makeAdminGraphql`, `LlmClient`, `curateProduct`, `pickHeroImage`, `Vault`, `TenantStore` are already imported.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/seed-route.test.ts` then `npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/seed-route.test.ts
git commit -m "feat(admin): temporary secret-gated /api/admin/seed-gb-origin route"
```

---

### Task 7: Refresh the Graphite graph + full-suite check

**Files:** none (verification only).

- [ ] **Step 1: Rebuild the graph (GRAPHITE.md post-edit step)**

Run: `python -m graphite build .`
Expected: a fresh `graph-out/graph.json` (do not edit it by hand).

- [ ] **Step 2: Typecheck + run the touched test files**

Run: `npx tsc --noEmit` then `npx vitest run tests/cj.test.ts tests/import.test.ts tests/jobs.test.ts tests/seed-origin.test.ts tests/seed-route.test.ts`
Expected: tsc clean; all green. (Batched - the monolithic `vitest run` hits the workerd loopback limit.)

- [ ] **Step 3: Commit the rebuilt graph**

```bash
git add graph-out/
git commit -m "chore(graph): rebuild after GB sourcing Phase 1"
```

---

## Cutover (gated on explicit owner go, in order - NOT part of the build tasks)

1. `npx wrangler deploy` (ships all of the above; no migration).
2. `npx wrangler secret put MAINT_TOKEN` (set a throwaway value).
3. `curl -X POST https://pawscout.activepaw.co.uk/api/admin/seed-gb-origin?shop=4qkudm-ez.myshopify.com -H "X-Maint-Token: <value>"` - read `{ discovered, drafted, rejected }`.
4. Owner reviews the GB **drafts** in Shopify admin, publishes the keepers (sets ACTIVE + Online-Store publish); `reconcileDraftLinks` flips their links `draft` -> `imported` on the next 04:17 UTC cron.
5. Remove the temporary route + the `MAINT_TOKEN` Env field + secret (`npx wrangler secret delete MAINT_TOKEN`); redeploy.

## Self-Review

- **Spec coverage:** Component 1 (discovery) -> Task 1; Component 2 (curate -> DRAFT import, link state) -> Tasks 2 + 4; pricing/dedup/origin correctness (Component 3) -> Tasks 3 (freight $0) + 4 (titleSignature dedup, putWarehouseProduct origins cache); testing (Component 4) -> per-task tests + Task 7; the secret-gated route + cutover -> Task 6 + Cutover section; the `refillCollections` draft-skip interaction (found while reading the code) -> Task 2 Step 5-6. Phase 2 correctly excluded.
- **Placeholder scan:** none - every code step shows complete code and exact commands.
- **Type consistency:** `publish` option object `{ publish?: boolean }` is identical across `confirmAndImport`/`importProduct`; `ProductLink['state']` widened in Task 2 is consumed by `putLink`/`linksByState`; `seedOriginAssortment` summary `{ discovered, drafted, rejected }` matches its callers (test + route); `searchByWarehouse(keyword, countryCode, pageSize)` signature matches Task 4's call.
