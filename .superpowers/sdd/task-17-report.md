# Task 17 Report: Per-product origin in shipping agent

## Implementation

### Exact accessor names used
- `resolveLineRequest(ctx.admin, query)` from `src/shopify-catalog.ts` -- returns `{ status, variant? }` where `variant.productId` is the Shopify GID
- `ctx.store.getLinkByShopifyProductId(productId)` from `src/tenant-store.ts:383` -- returns `ProductLink | null` with `.cj_pid`
- `ctx.store.getWarehouseProduct(cjPid)` from `src/tenant-store.ts:597` -- returns `WarehouseRow | null` with `.detail` (CjDetail JSON)
- `CjDetail.origins?: Record<string, number>` from `src/cj.ts:158` -- stock per origin country

### Design implemented (CONTROLLER-REDIRECTED)
Exported `resolveProductOrigin(ctx, dest): Promise<string | null>` in `src/inbox/agents/shipping.ts`:
1. Guard: `!ctx.admin` -> null
2. `resolveLineRequest` on first 80 chars of `latestMessage`; not resolved -> null
3. `getLinkByShopifyProductId(variant.productId)` -> no link -> null
4. `getWarehouseProduct(link.cj_pid)` -> no row -> null
5. `JSON.parse(row.detail)` -> get `origins`; empty/missing -> null
6. In-market check: if `origins[dest] > 0` return `dest` (no customs leg)
7. Best-stocked fallback: iterate `origins` entries, return highest-qty CC
8. Wrapped in try/catch; returns null on any error; never throws

In `ground()`: `resolveProductOrigin` result used if non-null and non-CN; falls back to CN route if origin null/CN or if origin route not found in D1. This means today's behavior is UNCHANGED (no non-CN rows in the logistics matrix yet), and it lights up automatically once non-CN rows are synced.

## TDD RED/GREEN

### RED (before implementation)
```
npx vitest run tests/agents/shipping-origin.test.ts
TypeError: resolveProductOrigin is not a function
9 failed
```

### GREEN (after implementation + DEFAULT_LOGISTICS import fix)
```
npx vitest run tests/agents/shipping-origin.test.ts tests/agents/shipping-agent.test.ts tests/logistics.test.ts
Test Files  3 passed (3)
Tests       31 passed (31)
Duration    2.62s
```

### TypeScript
```
npx tsc --noEmit
(no output -- clean)
```

## Files changed
- `src/inbox/agents/shipping.ts` -- added `resolveProductOrigin` (exported), two new imports (`resolveLineRequest`, `CjDetail`), updated `ground()` to try real origin before CN fallback
- `tests/agents/shipping-origin.test.ts` -- new file: 9 tests (2 band-math, 7 resolveProductOrigin cases)

## Self-review
- No em-dash or en-dash anywhere in new code
- Customer-facing appendix unchanged (time-only, never names origin country)
- `resolveProductOrigin` is exported for testability (as required by TDD)
- The brief's `admin: null` path in existing shipping-agent tests still returns CN fallback -> same "estimated 7-23 days" for Texas/US -- test confirmed green
- `chooseOrigin` from `src/cj.ts` was NOT used here (it applies a stock floor for UK preference at admission time; this function does its own dest-first logic appropriate for the shipping agent context)

## Concerns
- None blocking. Non-CN logistics matrix rows don't exist in D1 yet, so resolveProductOrigin's real origin path (GB/US warehouse) will always fall back to CN until a later task syncs those rows. This is the intended behavior per design.
- `resolveLineRequest` searches Shopify products by title/sku; a vague message ("how long to ship?") returns no product, resolveProductOrigin returns null -- correct fallback.
