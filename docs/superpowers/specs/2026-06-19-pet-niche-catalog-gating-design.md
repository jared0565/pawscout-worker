# Pet-Niche Catalog Gating - Cull + Guard + Audit (Design)

**Date:** 2026-06-19
**Status:** approved (brainstorm) - proceeding to implement
**Goal:** Remove off-niche (non-pet) products from the live Active Paw catalog, and close the gating gap that let them in, so the store only ever lists genuine pet-care products.

## Problem (root-caused 2026-06-19, live catalog = 104 products, 90 active)

The merchant's "I still see unrelated pet products" complaint traces to **non-pet human jewelry/apparel that is ACTIVE + live**, all tagged `cj-pet-more-to-love` and therefore surfaced by the `More To Love` smart collection (rule: `TAG EQUALS "cj-pet-more-to-love"`):

> couple love bra · "Love You More" pearl-chain necklace · knuckle ring · diamond pendant · phone case · "Love You More" short-sleeve t-shirt · four-leaf-clover necklace (~7 items)

These were pulled by an early sourcing seed / legacy bulk import that chased the literal phrase "more to love" (the collection's own name) and imported human "Love…More" listings. The off-niche **tools** (kitchen vacuum sealer, knife/scissor sharpeners, garden pruning shears, barber/tailor/hairdressing scissors) are **already ARCHIVED** - not part of the live problem.

**Why the gate let jewelry in:** `isLikelyPetProduct` (the LLM-free mechanical floor, `src/proxy/search.ts`) returns **admit** for *ambiguous* items - those with no pet token AND no `NONPET_MARKERS` hit. `NONPET_MARKERS` covers kitchen/garden/human-grooming but **not** jewelry/apparel/human-accessory terms, so "couple love bra" / "diamond pendant" are ambiguous → admitted whenever LLM curation isn't applied (LLM-down window, or a path that skips curation). The LLM `curateProduct` gate (household/children < 30, admit ≥ 60) *does* reject them when up; the floor is the leak.

## Design

### Part A+C - Audit + cull (standalone, reversible, no worker deploy)
- Read all ACTIVE products via the data-scripts app (`f00b61bc`, has `read_products`/`write_products`).
- Score each product's pet-niche relevance with an LLM via OpenRouter (`OPENROUTER_API_KEY` in `.env`): "Is this a genuine pet-care product for Active Paw (dogs/cats grooming, toys, feeding, walking, health, daily care)? 0–100." Mirrors `curateProduct`'s rubric (human/household < 30, species rule).
- Produce a **flagged list** (score < 50) and **review it by eye before archiving** - never auto-archive without the list being sane (guard against nuking a legit pet product).
- Archive (set `status: ARCHIVED`) the confirmed non-pet items via `productUpdate`. **Reversible** - archived, not deleted; restore by flipping status back.
- Re-scan afterward: 0 non-pet products active; `More To Love` holds only genuine pet items.

### Part B - Guard (worker code, tested, deploy-gated)
- Extend `NONPET_MARKERS` in `src/proxy/search.ts` with human-jewelry/apparel/accessory signals: `ring`, `necklace`, `pendant`, `bracelet`, `earring`, `brooch`, `bra`, `lingerie`, `t-shirt`/`tshirt`, `sweater`, `hoodie`, `phone case`, `couple`, `wedding`, `bridal`, etc. (word-boundary safe - must not clip legitimate pet terms; e.g. avoid bare `ring` matching "training" - use token-equality, not substring, for short words).
- Effect: an ambiguous non-pet listing with a human-accessory signal is now **rejected** by the mechanical floor (LLM-down mode), not admitted. Pet items (which carry a PET_TOKEN) are unaffected - the explicit pet signal still admits first.
- Add unit tests in `tests/search.test.ts`: jewelry/apparel rejected; pet products (incl. ambiguous-but-pet) still admitted; no regression on existing cases.
- Commit + push to branch; **`wrangler deploy` gated on an explicit go.**

### `more-to-love` hygiene
The catch-all must only ever hold *pet* items that don't fit a specific collection - never a fallback for non-pet. Part B's floor + the audit enforce this; no separate collection-rule change needed (the rule itself is fine - the tag was applied to non-pet products, which the guard now prevents).

## Verification
- **Cull:** re-scan active catalog + `More To Love` → 0 non-pet items; spot-check the storefront collection page.
- **Guard:** `npx vitest run tests/search.test.ts` green (new jewelry-reject + pet-admit cases); `npx tsc --noEmit` clean.
- **Audit safety:** the flagged list is human-reviewed before any archive; archive is reversible.

## Risks / non-goals
- **Don't archive legit pet products** - conservative threshold (< 50) + human review of the flagged list before archiving.
- Native **search relevance** (e.g. "Dog Prebiotics" ranking for "pet feeding") is a *separate* strand (Shopify Search & Discovery) - out of scope here; this design is import/catalog gating only.
- Reversible throughout (archive, not delete).
