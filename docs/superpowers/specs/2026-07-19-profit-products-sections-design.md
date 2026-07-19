# Profitability → Products: dead-row cleanup + sectioned list + search

**Date:** 2026-07-19
**Status:** Approved (owner, 2026-07-19)
**Problem:** The Products list "has become too long" (owner). Root cause is twofold:
1. **52 of the 97 default-view rows are dead.** `listProfitVerdicts` excludes
   `archived` links but not `failed` ones, so drop-verdicts for products that are
   not in the catalog render — and sort FIRST (reject=0 in the ORDER BY), burying
   the 45 genuine flags.
2. The surviving list is one flat run of rows with a single "Show all" toggle —
   no grouping, no counts, no way to find a product by name.

## Scope

Two files plus tests. No migration, no new routes, no data-model change.

### 1. Data layer — `src/tenant-store.ts` `listProfitVerdicts`

Change the link-state exclusion from
`(pl.state IS NULL OR pl.state <> 'archived')` to
`(pl.state IS NULL OR pl.state NOT IN ('archived','failed'))`.

- `failed` links are not sellable; there is nothing to review. Mirrors the
  existing archived rationale exactly.
- `NULL` state (verdict with no link row) keeps today's behavior — included.
  Surgical: no other clause changes.
- Sole caller is `getProfitConsole` (graphite-verified), so the change is
  console-display only. `clearProfitDecisions` wipes `product_profit` by shop
  regardless of link state — unaffected.

### 2. Console UI — `src/console/profit-js.ts` `pfRender`

Replace the flat list + `pfState.showAll` toggle with three collapsible
sections, each with a live count in its header:

| Section | Contents | Default |
|---|---|---|
| Rejected (N) | `verdict === 'reject'` | expanded |
| Flagged (N) | `verdict === 'review'` | expanded |
| Passing (N) | `verdict === 'pass'` (incl. reprices with action chips) | collapsed |

- Section header = clickable toggle (chevron + title + count). State lives in
  `pfState.sections` (per-section boolean), not persisted — page loads reset to
  the defaults above.
- Empty sections render header with (0) and no body (never hidden entirely, so
  the owner always sees the shape of the list).
- Search box above the sections: client-side substring match (case-insensitive)
  on product name, SKU, and handle. Filters rows within every section; headers
  show the FILTERED counts while a query is active; empty query restores full
  view. No debounce needed at this list size (≤ a few hundred rows).
- Row rendering (`pfRowTr`), per-row actions (Deep check, Archive), Clear-list
  button, ledger, and all API contracts unchanged.
- `pfToggleAll` and the "Show all" footer link are removed (the Passing section
  replaces them).

### 3. Tests

- **Store:** seed a `failed`-state link with a `product_profit` row; assert
  `listProfitVerdicts` omits it (mirror of the existing archived-exclusion
  coverage in `tests/profit-console.test.ts`).
- **Browser JS:** the grouping and search-filter logic are pure functions;
  extend the existing node-smoke pattern (unescape the template literal, eval,
  drive with mock rows) covering: three-way grouping, collapsed/expanded
  rendering, search narrowing + count updates, hostile input escaping.
  Per the console template-literal gotcha, run `tests/console.test.ts` after
  every edit to `profit-js.ts`.
- `tsc` + affected console/profit test files green before deploy.

## Non-goals

- No persistent per-row "seen/acknowledge" state (owner chose against for now).
- No pagination — the cleaned list is ~45 review rows + ~51 passes; sections
  and search carry it comfortably at this scale.
- No change to verdict semantics, sweep cadence, or any agent behavior.

## Success criteria

Owner opens Profitability → Products and sees: search box, "Rejected (0-ish)",
"Flagged (~45)" expanded with the real queue, "Passing (~51)" collapsed — and
zero rows for products that are not live in the catalog. Typing in the search
box narrows every section instantly.
