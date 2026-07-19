# Blog Article Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline execution, session precedent). Spec: docs/superpowers/specs/2026-07-19-blog-article-health-design.md

**Goal:** Published guides never link a 404 product and always render a full, live Shop-this-guide bundle.

**Architecture:** Theme composes the bundle at render time (curated -> available filter -> funnel top-up to 4). Worker reconciles article bodies nightly + on demand: dead `/products/` links healed by a caged LLM relink (deterministic fallback: funnel collection link), dead curated handles refreshed via the existing enrich flow.

**Tech Stack:** Worker TS (Cloudflare), Admin GraphQL 2026-04, Liquid, vitest (chunks <= 8 files).

## Global Constraints

- No em/en dashes anywhere; sanitize LLM output.
- scrubExternalLinks runs over any healed body before write.
- Console browser JS lives in template literals: no backticks/`${}`, '+' concatenation, esc() everything, run tests/console.test.ts after.
- Deploys need explicit owner go; git push automatic.

### Task 1: products-by-handle resolver + article-health core

**Files:** Create `src/blog/article-health.ts`; Test `tests/article-health.test.ts`

- Validate new GraphQL docs with the shopify-admin skill validator (pinned 2026-04):
  `products(first: 50, query: $q) { nodes { handle onlineStoreUrl status } }` and the
  blogs+articles read extended with `tags` + `metafield(namespace:"blog", key:"related_products") { value }`.
- `extractBodyProductHandles(html): string[]` (distinct, ordered).
- `resolveHandleLiveness(admin, handles): Map<handle, {live: boolean}>` - live = present AND onlineStoreUrl != null. Batch OR-query, chunks of 25.
- `healArticleBody(llm, store, cfg, {body, deadHandles, candidates, collectionPath}): {body, samples}` - per dead anchor: LLM `{handle, anchorText}` caged to candidate list; string-swap the exact `<a>` markup; fallback collection href. sanitize + scrub result.
- `runArticleHealth(env|deps): HealthResult {articlesScanned, linksChecked, deadLinks, bodiesHealed, metafieldsRefreshed, errors, samples}` - orchestrates read -> detect -> heal -> enrich (metafield) -> articleUpdate when changed. Reuses groundCollection, enrichBlogPost, updateArticleBody-style mutation (reuse debrand's ARTICLE_BODY_UPDATE shape locally).
- Tests: fake admin + fakeLlm per spec Testing section.

### Task 2: wiring (nightly stage + route)

**Files:** Modify `src/jobs.ts` (stage after `debrand`), `src/index.ts` (POST /api/blog/health mirroring /api/catalog/debrand).

### Task 3: console panel

**Files:** Modify `src/console/views/ops.ts` (Heal-guide-links panel in Catalog card), `src/console/page.ts` (runArticleHealth browser fn), `tests/console.test.ts` (containment). Node smoke of the literal.

### Task 4: theme bundle top-up

**Files:** Modify `demo-store2/sections/main-article.liquid` (compose curated+available+topup list, render 4). Pull-to-reconcile first; verify with theme dev + Playwright; live push on owner go.

### Task 5: verify + ship

- vitest chunks: article-health, blog, catalog-debrand, console (+ neighbours).
- tsc, commit, push. Deploy worker + theme push on explicit go; verify served bundle greps + live pages; first health run via console button; re-curl the 5 dead links' articles.
