## Task 19 Report: Product Agent Warehouse Stock/Specs Supplement

### Implementation

**Files changed:**
- `src/inbox/agents/product.ts` - warehouse supplement added in `ground()` resolved branch
- `tests/agents/product-agent.test.ts` - 2 new tests added (TDD)

**Exact accessors used (verified against `src/tenant-store.ts`):**
- `ctx.store.getLinkByShopifyProductId(productId)` -> `ProductLink | null` (line 383)
- `ctx.store.getWarehouseProduct(link.cj_pid)` -> `WarehouseRow | null` (line 597)
- Pattern copied from `src/inbox/agents/shipping.ts` `resolveProductOrigin()` (proven path)

**CjDetail fields used for specs (verified against `src/cj.ts` interface):**
- `detail.categoryName` (string) - product category
- `detail.petClass` (optional string) - e.g. "dog", "cat", "both"
- Note: `material`/`weight` do NOT exist on `CjDetail`; used available fields instead.

**Guard strategy:**
- Outer `try/catch` around entire supplement block (warehouse miss = non-fatal)
- Inner `try/catch` around `JSON.parse(row.detail)` (detail parse miss = non-fatal)
- Optional chain `ctx.store?.getLinkByShopifyProductId` - handles existing test mocks with bare `store: {}` without throwing
- Existing resolved-branch facts (price/title/availability) remain intact on any miss

**Example output when warehouse hit:** 
`Resolved product "Blue Harness - M", price GBP 12.00, in stock. You MAY state these. Suggest one concrete next step (view the product page or reply with the variant they want). Stock: available (40 units known). Category: Pet Harnesses, For: dog.`

---

### TDD RED/GREEN

**RED run:**
```
npx vitest run tests/agents/product-agent.test.ts
5 tests | 1 failed
x appends warehouse stock info when D1 row is available
  → expected '...' to contain '40'
```

**GREEN run (after implementation):**
```
npx vitest run tests/agents/product-agent.test.ts
5 tests | 5 passed
```

**tsc --noEmit:** clean (0 errors after correcting CjDetail field names from material/weight to categoryName/petClass)

---

### Self-Review

- All existing 3 tests still pass (existing mock `store: {}` -> `ctx.store?.getLinkByShopifyProductId` returns undefined, supplement skipped cleanly)
- New test 1: warehouse row present -> `facts` contains 'Stock', '40', 'available'
- New test 2: getLinkByShopifyProductId returns null -> confident, facts contain price/title, no throw
- No em-dash or en-dash introduced
- Graphite build completed successfully

---

### Concerns

- `CjDetail` has no `material`/`weight` field; the brief's example spec fields don't exist on the type. Used `categoryName`/`petClass` instead - these are available and genuinely informative.
- The brief's test mock used `detail: JSON.stringify({ material: 'nylon' })` - the implementation gracefully handles this (material not on CjDetail type, so it's ignored; only `categoryName`/`petClass` are extracted, and neither is present in that mock, so no spec suffix appended - but the stock status IS appended and satisfies the test assertions for 'stock' and '40').
- The `getWarehouseProduct` call in tests uses `ctx.store` which doesn't have `getWarehouseProduct` in the "no link" test path - correctly guarded since we return early when `link` is null.
