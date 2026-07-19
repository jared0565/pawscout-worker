# Blog Article Health (always-live product bundles) - Design

Date: 2026-07-19. Owner-approved (heal mode: LLM relink with deterministic fallback).

## Problem

Published guides rot as the profitability agent archives products. Verified live
2026-07-19: 5 of 10 distinct `/products/<handle>` links across the 4 guides are
404 (including the beds guide's own featured product), and every "Shop this
guide" block has shrunk to 1-2 cards (design is 4) because the theme skips
archived picks but never tops up. Generation-time grounding cannot prevent this:
the catalog changes after publication. The fix is reconciliation, mirroring the
approved-source scrub architecture (deterministic, self-healing, nightly + on
demand).

## Layer 1 - theme render-time bundle (main-article.liquid)

The Shop-this-guide block builds its render list at view time:

1. Curated handles from `article.metafields.blog.related_products.value`, in
   order, keeping only products that resolve (`all_products[handle] != empty`)
   AND are `available`.
2. Top-up from the guide's funnel collection (first tag with products), skipping
   handles already shown and unavailable products, until 4 cards render.

The block is always full and always buyable. No worker involvement; truth is
render-time. The block renders only when the combined list is non-empty (same
as today's `shop_count > 0` guard, but on the composed list).

## Layer 2 - worker article-health pass (src/blog/article-health.ts, new)

Runs as a nightly maintenance stage (after `debrand`) AND an owner console
button (Ops -> Catalog card). Per guide article (published AND drafted, from the
same blogs query shape the debrand sweep uses, extended with tags + the
related_products metafield):

1. **Detect**: extract distinct `/products/<handle>` hrefs from the body.
   Resolve all handles in one Admin query (`products(query: "handle:a OR ...")`,
   selecting `handle`, `onlineStoreUrl`, `status`). Dead = handle absent OR
   `onlineStoreUrl == null` (archived / unpublished from Online Store = the 404
   class). Sold-out-but-live body links are NOT dead (the PDP handles it).
2. **Heal body links** (per dead handle):
   - Ground the article's funnel collection (first tag with a grounded pack,
     `groundCollection`) for live candidates (`available` products with paths).
   - LLM (resolveChain 'text', usage logged as `blog-health`): given the anchor
     text + surrounding sentence + candidate list (title, handle), return JSON
     `{handle, anchorText}` - the congruent replacement and new anchor words.
   - Deterministic cage: returned handle MUST be in the candidate list;
     anchorText sanitised (em-dash strip, length cap 120, plain text). The swap
     is a string replacement of the exact old `<a ...>...</a>` markup; the
     result passes scrubExternalLinks before write.
   - Fallback (LLM unavailable / invalid answer / no candidates): href becomes
     the funnel collection path, anchor words unchanged. Never a 404 either way.
3. **Heal the bundle metafield**: if `related_products` contains any dead
   handle, call the existing `enrichBlogPost` for that article id (it re-picks a
   congruent live set via the combo merchandiser and never overwrites an
   owner-chosen hero). Articles without a D1 bookkeeping row skip this step with
   a warning (none exist today).
4. **Write**: `articleUpdate` body only when changed. Result mirrors
   DebrandResult: `{articlesScanned, linksChecked, deadLinks, bodiesHealed,
   metafieldsRefreshed, errors, samples}` with before->after samples for the
   console.

Idempotent: a healthy catalog makes the pass a cheap no-op. Per-item failures
collect into `errors`, never abort the pass (debrand philosophy).

## Wiring

- Nightly: new DailyStage `{ name: 'article-health', maxMs: 3 * MIN_MS,
  needsCj: false }` immediately after `debrand` in the shop-stage list.
- Route: `POST /api/blog/health` (session-authed via shopOf, same shape as
  /api/catalog/debrand).
- Console: new panel on the Ops Catalog card ("Heal guide links now") with
  button + msg + pre result, mirroring the De-brand panel. Browser JS follows
  the page.ts template-literal rules; tests/console.test.ts containment
  assertions + node smoke.

## Not in scope

Event-driven healing on each profit-agent archive (nightly + button suffices at
this catalog size). RSS/syndication surfaces (they link the guide, not
products). Retroactive un-archival of products.

## Testing

- article-health unit tests (fake admin + fakeLlm): dead handle healed via LLM
  within the cage; invalid LLM handle -> collection fallback; no candidates ->
  collection fallback; live links untouched (no write); metafield refresh
  invoked only when curated handles are dead; result counts + samples.
- Theme: verified on `shopify theme dev` with Playwright (4 cards, no dead
  picks) before live push.
- New Admin query document validated against the pinned 2026-04 schema via the
  shopify-admin skill validator.
