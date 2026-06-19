# CJ Category-Scoped Supplier Search — Design

**Date:** 2026-06-20
**Backlog item:** [17] (belt-and-suspenders over the [6] pet floor)
**Status:** Approved to build via autonomous `/loop` (approach **A**; collection-mapping bonus **deferred**). The two decisions below are called out loudly so they remain vetoable from this committed doc before the build is relied upon.

## Problem

The live supplier search feed (`searchBackfill` live-CJ branch in `src/proxy/search.ts`) draws raw, uncurated products from CJ's `/product/listV2` keyword search. Today it is gated by:

1. `liveCjPasses` — relevance/species match (keyword tokens, dog≠cat).
2. `isPetProductStrict(nameEn)` — the **pet floor**: require an explicit pet token (`dog`/`cat`/`pet`/`paw`/…) in the raw title; reject otherwise.

The pet floor is a **title-only** signal. It cannot catch a non-pet product whose title *does* contain a pet token — e.g. a "Love You More" couple pendant, a dog-themed phone case, a "dog tag" fashion necklace. Those are exactly the items that slipped into the catalog in the earlier 7-item jewelry/apparel cull. We want a second, independent signal: **CJ's own product category.**

## What the live probe established (2026-06-20)

Probed CJ `/product/listV2` through the worker's **exact transport** (GET + `URLSearchParams`), not the Python client's POST, because CJ endpoints are inconsistent and a transport mismatch would make the gate silently no-op.

- **Transport:** `features=enable_category` as a **single GET query-string value** populates the category fields (20/20 items). The JSON-array form `features=["enable_category"]` populates **0** — so the worker's existing single-string `features` pattern (as used by `detail`) is the correct one. Without the feature, `oneCategoryName` is `null`.
- **Name field unaffected:** the product title is in `nameEn` (which `mapCjSearchItems` already reads); enabling the feature does **not** suppress it. `nameEn` + `oneCategoryName` co-populate on the same row.
- **Real top-category strings observed** (`oneCategoryName`): `Pet Supplies`, `Home, Garden & Furniture`, `Jewelry & Watches`, `Phones & Accessories`, `Health, Beauty & Hair`, `Sports & Outdoors`.
- **Asymmetry confirmed:** CJ misfiles *some genuine pet items* into the catch-all `Home, Garden & Furniture` (a real "Dog bath massage brush", an "Animal Hair Remover Brush Dog And Cat" both landed there). It does **not** misfile pet items into the clean non-pet buckets (jewelry/phones/beauty held only human products). So a top category can be trusted to **drop**, but the catch-all buckets must **defer**.
- **Admit-bypass is dead weight (decisive):** of 14 items CJ topped as `Pet Supplies` across `water bottle`/`dog brush`/`shampoo`, **0 lacked a pet token** — every genuine `Pet Supplies` item already says dog/cat/pet in its title, so `isPetProductStrict` already admits them. A "category says Pet Supplies → bypass the title floor" branch would rescue nothing. **Dropped from the design.**

## Approach A (chosen): asymmetric category gate, drop/defer only

A two-way verdict composed **with** (not replacing) the existing floor:

- **DROP** — `oneCategoryName` matches a clearly-non-pet top category → reject the item **even if its title has a pet token**. This is the belt-and-suspenders.
- **DEFER** — anything else (`Pet Supplies`, `Home, Garden & Furniture`, `Sports & Outdoors`, blank/absent) → fall through to today's `isPetProductStrict(nameEn)` floor. Behavior is unchanged for these.

Rejected alternatives: **B** strict category-AND-title (drops CJ-misfiled real pet items in the catch-all → false negatives); **C** category admit-only-OR (the admit path rescues nothing per the probe → no precision gain, added complexity).

### Hard-drop top categories

Matched as **case-insensitive substrings** of `oneCategoryName`. Each is a CJ top-level category that never legitimately holds a pet product:

| Marker | Catches (observed / anticipated) |
|---|---|
| `jewelry` | `Jewelry & Watches` — observed (the pendant/necklace cull) |
| `phone` | `Phones & Accessories` — observed (dog-themed phone cases) |
| `beauty` | `Health, Beauty & Hair` — observed (human shampoo, nail art) |
| `apparel` | human apparel — anticipated (the "Love You More" bra / t-shirt cull) |
| `clothing` | human clothing — anticipated |
| `electronics` | `Consumer Electronics` — anticipated |
| `automobile` | `Automobiles & Motorcycles` — anticipated |
| `motorcycle` | `Automobiles & Motorcycles` — anticipated |

The first three are confirmed against real CJ strings from the probe; the rest are anticipated from the known cull and are safe (an unmatched marker is simply inert). The set is deliberately small and extensible — **expand it when a non-pet top category bearing pet-token items is observed in production.** It is verified non-colliding with the observed pet/ambiguous tops (`Pet Supplies`, `Home, Garden & Furniture`, `Sports & Outdoors`).

The catch-all `Home, Garden & Furniture` and `Sports & Outdoors` are **intentionally not** in the drop set — they hold CJ-misfiled real pet items, so they defer to the title floor (which admits the pet-token ones, drops the rest).

## Graceful degradation (and why the cache key must bump)

If `oneCategoryName` is ever absent — CJ omits it, an old cache entry predates the feature — the gate **defers**, i.e. behaves exactly as today. The gate only ever *removes* clearly-non-pet items; it never admits something the floor would have rejected. This makes the change strictly additive and safe.

**But** that same safety hides a failure mode: live CJ results are cached 30 days under `kw:${kw}`. Entries written **before** this deploy are arrays of old-shape `CjSearchItem` (no `topCategory`) → the gate would defer (no-op) on the hottest keywords for up to a month, indistinguishable from "working conservatively." Fix: bump the cache key `kw:` → `kw2:` so the next access on any keyword re-fetches with the feature on and the gate takes effect immediately.

**This `kw:` namespace is SHARED** with the cron sourcing path (`jobs.ts` `replenishWarehouse`'s inner `search`), which by design reuses the same cached CJ results as the storefront feed (its comment: "the same gate the storefront uses"). So **both** consumers must bump to `kw2:` — otherwise the bump silently *splits* a shared cache, double-fetching a rate-limited supplier. `jobs.ts` ignores `topCategory` (its admission is LLM-curated via `tryAdmit`) and does **not** get the category gate; it only follows the key rename so the two paths stay on one category-bearing namespace.

## Components / changes

### `src/cj.ts`
- `CjSearchItem`: add `topCategory: string` (the CJ top-level category, `oneCategoryName`). Keep `categoryName` (the leaf) unchanged.
- `searchV2`: add `features: 'enable_category'` to the listV2 GET params.
- `mapCjSearchItems`: set `topCategory: String(p.oneCategoryName ?? '')`. (`/product/list` fallback rows have no `oneCategoryName` → `''` → defer, which is correct.)

### `src/proxy/search.ts`
- Add `HARD_DROP_TOP_CATEGORIES: string[]` (the markers above).
- Add exported `categoryAdmitsLiveCj(topCategory: string): boolean` → `false` iff the lowercased `topCategory` contains a hard-drop marker; `true` otherwise (blank → `true`/defer).
- In the `searchBackfill` live-CJ filter, insert `categoryAdmitsLiveCj(i.topCategory)` **before** `isPetProductStrict(i.nameEn)` (cheap check first; composes with `liveCjPasses`).
- Bump the live-CJ cache key `kw:${kw}` → `kw2:${kw}` (both `getSearchCache` and `putSearchCache`).

### `src/jobs.ts`
- Bump the shared live-CJ cache key `kw:${kw}` → `kw2:${kw}` in `replenishWarehouse`'s inner `search` (both get + put). **Key rename only** — no category gate (the sourcing path's admission is LLM-curated).

No change to the warehouse admission logic or imported-product path: those are already LLM-curated at import; the raw-category gate belongs only on the uncurated live feed, exactly like the pet floor.

## Testing

- `categoryAdmitsLiveCj`: drops `Jewelry & Watches`, `Phones & Accessories`, `Health, Beauty & Hair`, `Apparel`; admits `Pet Supplies`, `Home, Garden & Furniture`, `Sports & Outdoors`, `''`. Case-insensitive.
- `mapCjSearchItems`: maps `topCategory` from `oneCategoryName`; `''` when absent; `nameEn` still mapped.
- `searchBackfill` integration: a non-pet item with a pet-token title under a hard-drop category (e.g. a "dog" necklace under `Jewelry & Watches`) is dropped; a CJ-misfiled real pet item under `Home, Garden & Furniture` with a pet token is kept; the cache read/write uses `kw2:`.
- All existing search tests stay green (the change is additive; the gate only drops items already at risk).

Run as focused vitest files (Windows full-suite contention is documented). `tsc --noEmit` clean.

## Out of scope — deferred follow-on: collection mapping

The probe shows CJ returns a rich 3-level path (`oneCategoryName / twoCategoryName / threeCategoryName`), e.g. `Pet Supplies / Pet Drinking Tools`, `Pet Supplies / Pet Hair Removers & Combs`, `Pet Supplies / Pet Feeding Tools`, `Pet Supplies / Pet Shower Products`. These map cleanly onto Active Paw collections (feeding/cleaning/grooming/health) and could sharpen **import-time collection assignment** (`signaledCategory` / `reconcileCategories` in `src/proxy/search.ts`), which currently relies on title-keyword signals and misfiles e.g. "Multivitamin **Chews**" as a toy.

This is a **separate concern** (import flow, not search filtering), would balloon this spec, and is deferred per YAGNI. The observed path data above is recorded so a future spec can resume cleanly.
