# CJ Category-Scoped Supplier Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CJ's own top-level product category as a hard-drop signal on the live supplier search feed, so clearly-non-pet products are rejected even when their title carries a pet token.

**Architecture:** `searchV2` requests `features=enable_category` so listV2 returns `oneCategoryName`; `mapCjSearchItems` carries it as `CjSearchItem.topCategory`; a new `categoryAdmitsLiveCj` gate in `searchBackfill`'s live-CJ branch drops items whose top category is unambiguously non-pet, deferring everything else to the existing `isPetProductStrict` title floor. The change is additive and degrades to today's behavior when the category is absent. A cache-key bump forces the gate to take effect on already-cached hot keywords.

**Tech Stack:** TypeScript, Cloudflare Workers, vitest (`@cloudflare/vitest-pool-workers`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-20-cj-category-scoped-search-design.md`. Approach **A** (drop/defer, no admit-bypass — the bypass rescues nothing per the live probe). Collection-mapping is **deferred**, out of scope.
- `topCategory` is **optional** on `CjSearchItem` — do NOT make it required (it would churn ~6 unrelated test fixtures); the gate treats `undefined` identically to `''` (defer).
- The category gate lives ONLY on the raw live-CJ feed (alongside `isPetProductStrict`), never on the warehouse/imported path (already LLM-curated).
- Hard-drop markers are case-insensitive substrings of `oneCategoryName`; the set is small and extensible. Verified non-colliding with the observed pet/ambiguous tops (`Pet Supplies`, `Home, Garden & Furniture`, `Sports & Outdoors`).
- `features=enable_category` is a **single string** GET query value (proven: the JSON-array form returns no categories).
- Windows: run **focused** vitest files only (full `npm test` crashes on pool contention). `tsc --noEmit` must be clean.
- Never expose worker secrets; never touch `relay/fly.toml`.

---

### Task 1: Capture CJ top category on the search feed

**Files:**
- Modify: `src/cj.ts` (interface `CjSearchItem` ~L127-134; `searchV2` ~L308-316; `mapCjSearchItems` ~L211-227)
- Test: `tests/cj.test.ts` (listV2 parse test ~L160-184)

**Interfaces:**
- Produces: `CjSearchItem.topCategory?: string` — the CJ top-level category (`oneCategoryName`), `''` on the `/product/list` fallback. Consumed by Task 2.

- [ ] **Step 1: Write the failing tests** (in `tests/cj.test.ts`, the `describe('CjClient.search — listV2 first …')` block)

Add `oneCategoryName` to the existing listV2 fixture row and assert it maps; assert the listV2 URL carries the feature. Mirror the existing `features=enable_inventory` URL assertion style (cj.test.ts:51).

```ts
// In the listV2 fixture row (currently: { id:'111', nameEn:'Herding Ball for Dogs', bigImage:..., sellPrice:'9.00', listedNum:3, threeCategoryName:'Dog Toys' })
// add: oneCategoryName: 'Pet Supplies'
expect(urls[0]).toContain('features=enable_category');
expect(items[0].topCategory).toBe('Pet Supplies');
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/cj.test.ts -t "listV2"`
Expected: FAIL — `features=enable_category` not in URL; `topCategory` undefined.

- [ ] **Step 3: Add `topCategory` to `CjSearchItem`**

```ts
export interface CjSearchItem {
  pid: string;
  nameEn: string;
  image: string;
  sellPriceUsd: number; // lowest variant price when CJ returns a range
  listedNum: number;
  categoryName: string;
  /** CJ top-level category (oneCategoryName), populated only when listV2 is
   *  queried with features=enable_category; '' on the /product/list fallback.
   *  Drives the live-CJ hard-drop category gate. */
  topCategory?: string;
}
```

- [ ] **Step 4: Request the feature in `searchV2`**

```ts
private async searchV2(keyword: string, pageSize: number): Promise<CjSearchItem[]> {
  const data = (await this.get('/product/listV2', {
    keyWord: keyword,
    page: '1',
    size: String(Math.min(pageSize, 100)),
    orderBy: '0', // 0 = best match (relevance) — explicit, matches the website
    features: 'enable_category' // populates oneCategoryName for the pet-category gate
  })) as Record<string, unknown> | null;
  return mapCjSearchItems(extractV2List(data));
}
```

- [ ] **Step 5: Map it in `mapCjSearchItems`** (add the field to the returned object)

```ts
        categoryName: String(p.categoryName ?? p.threeCategoryName ?? p.categoryNameEn ?? ''),
        topCategory: String(p.oneCategoryName ?? '')
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/cj.test.ts`
Expected: PASS (all cj tests, incl. the two new assertions).

- [ ] **Step 7: Commit**

```bash
git add src/cj.ts tests/cj.test.ts
git commit -m "feat(cj): carry CJ top category on the search feed (enable_category)"
```

---

### Task 2: Hard-drop non-pet top categories on the live feed

**Files:**
- Modify: `src/proxy/search.ts` (add gate after `signaledCategory` ~L139; live-CJ filter ~L317; cache key ~L306,L311)
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: `CjSearchItem.topCategory` (Task 1).
- Produces: `export function categoryAdmitsLiveCj(topCategory?: string): boolean`.

- [ ] **Step 1: Write the failing unit tests** (in `tests/search.test.ts`; add `categoryAdmitsLiveCj` to the existing import from `../src/proxy/search`)

```ts
describe('categoryAdmitsLiveCj (live-CJ category gate)', () => {
  it('drops unambiguously non-pet top categories', () => {
    for (const c of ['Jewelry & Watches', 'Phones & Accessories', 'Health, Beauty & Hair', 'Apparel', 'CONSUMER ELECTRONICS']) {
      expect(categoryAdmitsLiveCj(c)).toBe(false);
    }
  });
  it('defers ambiguous / pet / blank top categories to the title floor', () => {
    for (const c of ['Pet Supplies', 'Home, Garden & Furniture', 'Sports & Outdoors', '', undefined]) {
      expect(categoryAdmitsLiveCj(c)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Write the failing integration test** (proves the gate composes in `searchBackfill`)

Mirror the existing live-CJ ghost-path test in `tests/search.test.ts`. A pet-token-titled item under a hard-drop top category must NOT appear as a ghost; the same title under `Pet Supplies` must. Use the `item()`/`fakeCj()` helpers already in the file:

```ts
it('hard-drops a pet-token item filed under a non-pet top category', async () => {
  const store = new TenantStore(env.DB, 't1');
  const cj = fakeCj([
    item({ pid: 'NECK', nameEn: 'Dog Mom Necklace Pendant', topCategory: 'Jewelry & Watches' }),
    item({ pid: 'REAL', nameEn: 'Dog Necklace Tag Pet Collar', topCategory: 'Pet Supplies' })
  ]);
  const cards = await searchBackfill(store, cj, CFG, 'dog necklace', 0, 12, { liveFallback: true });
  const pids = cards.map((c) => c.pid);
  expect(pids).toContain('REAL');   // Pet Supplies → defers → pet token admits
  expect(pids).not.toContain('NECK'); // Jewelry → hard drop despite the pet token
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/search.test.ts -t "categoryAdmitsLiveCj|non-pet top category"`
Expected: FAIL — `categoryAdmitsLiveCj` not exported; `NECK` still present.

- [ ] **Step 4: Add the gate** (in `src/proxy/search.ts`, after `signaledCategory`)

```ts
// --- Live-CJ category gate (LLM-free, raw-feed only) ---
// CJ's own top-level category (oneCategoryName) is independent of the title.
// CJ MIS-FILES some real pet items into catch-all tops (Home/Garden, Sports),
// so a top category can be trusted to DROP but not to ADMIT. These markers are
// tops that never legitimately hold a pet product → a match is a hard drop even
// when the title carries a pet token (the jewelry / phone-case / human-shampoo
// false positives the title floor alone misses). Matched as case-insensitive
// substrings of oneCategoryName; extend when a new non-pet top bearing
// pet-token items is observed in the live feed.
const HARD_DROP_TOP_CATEGORIES = [
  'jewelry', 'phone', 'beauty', 'apparel', 'clothing', 'electronics', 'automobile', 'motorcycle'
];

/**
 * Live-CJ category gate: reject only when CJ's TOP category is unambiguously
 * non-pet. Blank/absent or an ambiguous catch-all → admit (defer to the title
 * pet floor). Composes WITH isPetProductStrict — it never replaces it.
 */
export function categoryAdmitsLiveCj(topCategory?: string): boolean {
  const t = (topCategory || '').toLowerCase();
  if (!t) return true; // no category signal → defer to the title floor
  return !HARD_DROP_TOP_CATEGORIES.some((m) => t.includes(m));
}
```

- [ ] **Step 5: Wire it into the live-CJ filter** (~L317)

```ts
    const gated = items.filter((i) =>
      !seen.has(i.pid) &&
      liveCjPasses(i, cfg.gates, kw) &&
      categoryAdmitsLiveCj(i.topCategory) &&
      isPetProductStrict(i.nameEn)
    );
```

- [ ] **Step 6: Bump the live-CJ cache key** (so the gate takes effect on already-cached keywords; ~L306 and ~L311)

```ts
    const cached = await store.getSearchCache(`kw2:${kw}`);
    ...
      await store.putSearchCache(`kw2:${kw}`, JSON.stringify(items), CACHE_TTL_DAYS);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/search.test.ts`
Expected: PASS (all search tests, incl. the new unit + integration cases).

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (0 errors).

- [ ] **Step 9: Commit**

```bash
git add src/proxy/search.ts tests/search.test.ts
git commit -m "feat(search): hard-drop non-pet CJ top categories on the live feed [17]"
```

---

## Self-Review

- **Spec coverage:** Task 1 = `features` flag + `topCategory` mapping (spec §Components/`src/cj.ts`); Task 2 = gate + wiring + cache bump (spec §Components/`src/proxy/search.ts` + §cache). Admit-bypass omitted per spec decision. Collection-mapping deferred — no task, by design.
- **Placeholder scan:** none — every code step shows complete code.
- **Type consistency:** `topCategory?: string` defined in Task 1, consumed via `categoryAdmitsLiveCj(i.topCategory)` in Task 2; `categoryAdmitsLiveCj(topCategory?: string)` signature matches both the unit-test calls and the call site.
- **Degradation:** absent `topCategory` → `categoryAdmitsLiveCj` returns true → identical to today; verified by the `''`/`undefined` unit case.
