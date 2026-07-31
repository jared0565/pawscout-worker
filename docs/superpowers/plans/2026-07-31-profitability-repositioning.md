# Profitability Agent Repositioning + Product-Referrer Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the profitability agent out of the live catalog into the admission gates, make the no-movement cull the single takedown path, and stop archives from ever minting a 404.

**Architecture:** Three existing archive paths collapse into one guarded chokepoint, `archiveProductGuarded`, enforced by a source-scanning guard test. Before archiving, the guard consults a derived `product_referrers` index and refuses when a product is referenced and no congruent replacement exists. Every archive creates a Shopify URL redirect first; restore deletes it.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1 (SQLite), Shopify Admin GraphQL 2026-04, vitest 4 + @cloudflare/vitest-pool-workers.

**Spec:** `docs/superpowers/specs/2026-07-31-profitability-repositioning-design.md`

## Global Constraints

- **Admin API version is pinned to `2026-04`** (`ADMIN_API_VERSION`, `src/shopify-admin.ts:11`). Every new GraphQL document must be valid against it.
- **Only `src/tenant-store.ts` may touch D1 directly.** `tests/guard.test.ts` fails the build otherwise. All new persistence goes in `tenant-store.ts` as methods; `src/catalog/*.ts` must call those methods, never `.prepare(` / `.batch(`.
- **Never default a parameter to the global `fetch`.** Use `defaultFetch` from `safe-fetch.ts`; `tests/guard.test.ts` enforces this.
- **No em-dash or en-dash anywhere**, in code, comments, or copy. Use a plain hyphen.
- **Never claim UK fulfilment.** Not touched by this work, but any customer-facing string added must respect it.
- `cfg.profit.dryRun !== false` means dry-run is ON by default. Preserve that default in every new gate.
- Tests run with `npx vitest run <file>`. The full suite is ~275s; run single files during development.
- **Migrations apply `--remote` BEFORE `wrangler deploy`**, never after.

## File Structure

| File | Responsibility |
|---|---|
| `migrations/0035_product_referrers.sql` | New `product_referrers` table |
| `src/tenant-store.ts` (modify) | All D1 access for referrers + redirect bookkeeping |
| `src/catalog/referrers.ts` (new) | Build the index from blog, syndication and collection sources; `referrersFor()` |
| `src/catalog/archive-guard.ts` (new) | `archiveProductGuarded()` - the ONLY archive door, plus the scope probe |
| `src/catalog/redirects.ts` (new) | `urlRedirectCreate` / `urlRedirectDelete` wrappers + target selection |
| `src/profitability.ts` (modify) | `drop` becomes `flag` on live products; delete the archive call |
| `src/jobs.ts` (modify) | Cull routes through the guard; delete inline `ARCHIVE` |
| `src/profit-console.ts` (modify) | Console archive routes through the guard; delete inline `SET_PRODUCT_STATUS` |
| `src/proxy/inventory.ts` (modify) | Delete `archiveProduct` |
| `src/proxy/search.ts` (modify) | Cheap margin gate on ghost cards |
| `src/types.ts` (modify) | `profit.repriceEnabled` |
| `tests/archive-guard.test.ts` (new) | Guard behaviour + the source-scanning tripwire |
| `tests/referrers.test.ts` (new) | Index build and miss semantics |
| `tests/search-profit-gate.test.ts` (new) | Ghost-card gating, zero network calls |

---

### Task 0: Access scope prerequisite (OWNER ACTION - blocks Tasks 7, 8, 9)

**Files:**
- Modify: `shopify.app.toml:10`
- Modify: `wrangler.toml:43`

**Interfaces:**
- Consumes: nothing
- Produces: a token carrying `read_online_store_navigation` + `write_online_store_navigation`, which Tasks 7-9 require.

`urlRedirectCreate` and `urlRedirectDelete` exist in 2026-04 but both require `write_online_store_navigation`, which this app does not have. The two files are kept in lockstep by the comment at `wrangler.toml:35`.

- [ ] **Step 1: Add both scopes to `shopify.app.toml:10`**

Append to the existing `scopes` string (keep it one line, comma-separated, no spaces):

```
,read_online_store_navigation,write_online_store_navigation
```

- [ ] **Step 2: Add both scopes to `wrangler.toml:43`**

Append the identical two scopes to `SHOPIFY_SCOPES`, and add a comment above it in the style of the existing ones:

```
# read/write_online_store_navigation (2026-07-31): archive must leave a URL
# redirect instead of a 404. write_ creates and deletes redirects; read_ lets the
# backfill skip handles already redirected so a re-run cannot mint duplicates.
```

- [ ] **Step 3: Owner re-authenticates**

Follow `docs/INBOX_OPS.md` section 2 (the flow already used for `write_draft_orders` + `read_customers`). This is an owner-only consent step and cannot be done from the shell.

- [ ] **Step 4: Verify the grant, do not assume it**

The scope is granted only when a real call succeeds. After re-auth, confirm via the worker (console action or a deployed route) that `urlRedirects(first: 1)` returns without `ACCESS_DENIED`. A consent screen that was clicked is not proof.

- [ ] **Step 5: Commit**

```bash
git add shopify.app.toml wrangler.toml
git commit -m "feat(scopes): request online store navigation for archive redirects"
```

---

### Task 1: `product_referrers` table and store methods

**Files:**
- Create: `migrations/0035_product_referrers.sql`
- Modify: `src/tenant-store.ts`
- Test: `tests/referrers.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `store.putProductReferrers(handle, rows)`, `store.referrersFor(handle)`, `store.clearProductReferrers(referrerType, referrerId)`, and the `ProductReferrer` type. Tasks 2 and 3 consume these.

- [ ] **Step 1: Write the migration**

Create `migrations/0035_product_referrers.sql`:

```sql
-- Reverse index: which internal surfaces point at a product handle.
-- DERIVED CACHE, never a source of truth - rebuilt from article bodies, the
-- related_products metafield, and syndication_ledger. A MISS means "unknown"
-- and must BLOCK an archive; it must never be read as "safe to archive".
CREATE TABLE product_referrers (
  shop          TEXT NOT NULL,
  handle        TEXT NOT NULL,
  referrer_type TEXT NOT NULL,   -- blog | syndication | collection
  referrer_id   TEXT NOT NULL,   -- article handle, ledger row id, or collection handle
  detected_at   TEXT NOT NULL,
  PRIMARY KEY (shop, handle, referrer_type, referrer_id)
);
CREATE INDEX idx_product_referrers_handle ON product_referrers (shop, handle);
CREATE INDEX idx_product_referrers_source ON product_referrers (shop, referrer_type, referrer_id);
```

- [ ] **Step 2: Write the failing test**

Create `tests/referrers.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

const SHOP = 'test.myshopify.com';

describe('product_referrers store', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  it('round-trips referrers for a handle', async () => {
    await store.putProductReferrers('cat-tree-88', [
      { referrerType: 'blog', referrerId: 'indoor-cat-boredom' },
    ]);
    const rows = await store.referrersFor('cat-tree-88');
    expect(rows).toHaveLength(1);
    expect(rows[0].referrer_type).toBe('blog');
    expect(rows[0].referrer_id).toBe('indoor-cat-boredom');
  });

  it('returns an empty array for an unreferenced handle', async () => {
    expect(await store.referrersFor('never-mentioned')).toEqual([]);
  });

  it('clearProductReferrers removes only that source', async () => {
    await store.putProductReferrers('cat-tree-88', [
      { referrerType: 'blog', referrerId: 'article-a' },
      { referrerType: 'blog', referrerId: 'article-b' },
    ]);
    await store.clearProductReferrers('blog', 'article-a');
    const rows = await store.referrersFor('cat-tree-88');
    expect(rows.map((r) => r.referrer_id)).toEqual(['article-b']);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run tests/referrers.test.ts`
Expected: FAIL, `store.putProductReferrers is not a function`.

- [ ] **Step 4: Add the type and methods to `src/tenant-store.ts`**

Add the interface near the other row types:

```typescript
export interface ProductReferrer {
  shop: string;
  handle: string;
  referrer_type: string;
  referrer_id: string;
  detected_at: string;
}
```

Add these methods to the `TenantStore` class:

```typescript
/** Replace-or-insert referrer rows for ONE handle. Idempotent per
 *  (handle, type, id) so a nightly rebuild does not accumulate duplicates. */
async putProductReferrers(
  handle: string,
  rows: { referrerType: string; referrerId: string }[]
): Promise<void> {
  if (!rows.length) return;
  const now = new Date().toISOString();
  await this.db.batch(
    rows.map((r) =>
      this.db
        .prepare(
          `INSERT INTO product_referrers (shop, handle, referrer_type, referrer_id, detected_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (shop, handle, referrer_type, referrer_id)
           DO UPDATE SET detected_at = excluded.detected_at`
        )
        .bind(this.shop, handle, r.referrerType, r.referrerId, now)
    )
  );
}

async referrersFor(handle: string): Promise<ProductReferrer[]> {
  const rs = await this.db
    .prepare(`SELECT * FROM product_referrers WHERE shop = ?1 AND handle = ?2`)
    .bind(this.shop, handle)
    .all<ProductReferrer>();
  return rs.results ?? [];
}

/** Drop every row contributed by ONE source, so a rebuild of that source
 *  removes links it no longer contains. */
async clearProductReferrers(referrerType: string, referrerId: string): Promise<void> {
  await this.db
    .prepare(
      `DELETE FROM product_referrers
       WHERE shop = ?1 AND referrer_type = ?2 AND referrer_id = ?3`
    )
    .bind(this.shop, referrerType, referrerId)
    .run();
}
```

- [ ] **Step 5: Apply the migration locally and run the test**

Run: `npm run migrate:local && npx vitest run tests/referrers.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add migrations/0035_product_referrers.sql src/tenant-store.ts tests/referrers.test.ts
git commit -m "feat(catalog): product_referrers table and store accessors"
```

---

### Task 2: Build the referrer index

**Files:**
- Create: `src/catalog/referrers.ts`
- Test: `tests/referrers.test.ts` (extend)

**Interfaces:**
- Consumes: `store.putProductReferrers`, `store.clearProductReferrers` (Task 1); `extractProductHandles` from `src/blog/article-health.ts:50` region.
- Produces: `rebuildBlogReferrers(store, articles): Promise<number>` where `articles: { handle: string; bodyHtml: string; relatedHandles: string[] }[]`. Task 3 relies only on `store.referrersFor`.

- [ ] **Step 1: Write the failing test (append to `tests/referrers.test.ts`)**

```typescript
import { rebuildBlogReferrers } from '../src/catalog/referrers';

describe('rebuildBlogReferrers', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  it('indexes handles from the body and the related list', async () => {
    const n = await rebuildBlogReferrers(store, [
      {
        handle: 'indoor-cat-boredom',
        bodyHtml: '<p>Try the <a href="/products/cat-tree-88">tall tree</a>.</p>',
        relatedHandles: ['scratch-post-63'],
      },
    ]);
    expect(n).toBe(2);
    expect((await store.referrersFor('cat-tree-88'))[0].referrer_id).toBe('indoor-cat-boredom');
    expect((await store.referrersFor('scratch-post-63'))[0].referrer_type).toBe('blog');
  });

  it('a rebuild DROPS a handle the article no longer mentions', async () => {
    await rebuildBlogReferrers(store, [
      { handle: 'guide-a', bodyHtml: '<a href="/products/old-item">x</a>', relatedHandles: [] },
    ]);
    expect(await store.referrersFor('old-item')).toHaveLength(1);
    await rebuildBlogReferrers(store, [
      { handle: 'guide-a', bodyHtml: '<a href="/products/new-item">y</a>', relatedHandles: [] },
    ]);
    expect(await store.referrersFor('old-item')).toEqual([]);
    expect(await store.referrersFor('new-item')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/referrers.test.ts`
Expected: FAIL, cannot resolve `../src/catalog/referrers`.

- [ ] **Step 3: Implement `src/catalog/referrers.ts`**

```typescript
import type { TenantStore } from '../tenant-store';

/** Distinct product handles a body links, in order of first appearance.
 *  Mirrors the extractor in blog/article-health.ts - kept local so the index
 *  does not depend on the heal pass running. */
export function handlesInBody(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*['"]\/products\/([a-z0-9][a-z0-9-]*)['"]/gi)) {
    const h = m[1].toLowerCase();
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

export interface ArticleSource {
  handle: string;
  bodyHtml: string;
  relatedHandles: string[];
}

/** Rebuild the blog slice of the index. Each article is CLEARED first, so a
 *  handle the article no longer mentions stops being a referrer - otherwise the
 *  index would only ever grow and would block archives forever. */
export async function rebuildBlogReferrers(
  store: TenantStore,
  articles: ArticleSource[]
): Promise<number> {
  let written = 0;
  for (const a of articles) {
    await store.clearProductReferrers('blog', a.handle);
    const handles = new Set<string>([
      ...handlesInBody(a.bodyHtml),
      ...a.relatedHandles.map((h) => h.toLowerCase()),
    ]);
    for (const h of handles) {
      await store.putProductReferrers(h, [{ referrerType: 'blog', referrerId: a.handle }]);
      written++;
    }
  }
  return written;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/referrers.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/referrers.ts tests/referrers.test.ts
git commit -m "feat(catalog): build blog slice of the product referrer index"
```

---

### Task 3: The archive guard and its tripwire

**Files:**
- Create: `src/catalog/archive-guard.ts`
- Test: `tests/archive-guard.test.ts`

**Interfaces:**
- Consumes: `store.referrersFor` (Task 1); `AdminGraphql` from `src/shopify-admin.ts`.
- Produces: `archiveProductGuarded(admin, store, opts): Promise<ArchiveOutcome>` where `opts: { cjPid: string; productId: string; handle: string; reason: string }` and `ArchiveOutcome = { ok: true } | { ok: false; refusal: 'referenced' | 'missing-scope' | 'redirect-failed' | 'no-replacement'; detail: string }`. Tasks 4, 7, 8 consume it.

Redirect creation is added in Task 7 (blocked on Task 0). This task builds the guard with redirects **not yet wired**, so the missing-scope refusal is the default path and the cull is dormant exactly as the spec requires.

- [ ] **Step 1: Write the failing test**

Create `tests/archive-guard.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { archiveProductGuarded, writesArchivedStatus } from '../src/catalog/archive-guard';

const SHOP = 'test.myshopify.com';
const noopAdmin = async () => ({});

describe('archiveProductGuarded', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  it('REFUSES to archive a product a blog article references', async () => {
    await store.putProductReferrers('cat-tree-88', [
      { referrerType: 'blog', referrerId: 'indoor-cat-boredom' },
    ]);
    const out = await archiveProductGuarded(noopAdmin, store, {
      cjPid: '1', productId: 'gid://shopify/Product/1', handle: 'cat-tree-88', reason: 'cull',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('referenced');
  });

  it('refuses with missing-scope (not a generic abort) when redirects are unavailable', async () => {
    const out = await archiveProductGuarded(noopAdmin, store, {
      cjPid: '2', productId: 'gid://shopify/Product/2', handle: 'unreferenced-item', reason: 'cull',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.refusal).toBe('missing-scope');
      expect(out.detail).toContain('write_online_store_navigation');
    }
  });
});

describe('archive tripwire', () => {
  it('flags a real ARCHIVED status write but not an innocent state comparison', () => {
    expect(writesArchivedStatus(`admin(M, { input: { id, status: 'ARCHIVED' } })`)).toBe(true);
    expect(writesArchivedStatus(`status: "ARCHIVED"`)).toBe(true);
    // Negative controls - these appear all over the codebase and are innocent.
    expect(writesArchivedStatus(`if (link.state === 'archived') return;`)).toBe(false);
    expect(writesArchivedStatus(`// archived under the CURRENT rules`)).toBe(false);
    expect(writesArchivedStatus(`state: 'archived' | 'imported'`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/archive-guard.test.ts`
Expected: FAIL, cannot resolve `../src/catalog/archive-guard`.

- [ ] **Step 3: Implement `src/catalog/archive-guard.ts`**

```typescript
import type { AdminGraphql } from '../shopify-admin';
import type { TenantStore } from '../tenant-store';

const ARCHIVE = `mutation pawscoutArchive($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

export type ArchiveOutcome =
  | { ok: true }
  | { ok: false; refusal: 'referenced' | 'missing-scope' | 'redirect-failed' | 'no-replacement'; detail: string };

/** Tripwire helper, exported for tests/archive-guard.test.ts.
 *  Matches a GraphQL status WRITE only. It must NOT match the bare token
 *  `archived`: `link.state === 'archived'` comparisons and type unions appear
 *  throughout src/ and are innocent. This repo already lost time to a guard
 *  regex that was too broad (guard.test.ts matched `.exec(` and flagged
 *  RegExp.exec) - the fix there was to narrow the TEST, not the source. */
export function writesArchivedStatus(src: string): boolean {
  return /status\s*:\s*['"]ARCHIVED['"]/.test(src);
}

/**
 * The ONLY way a product may be archived.
 *
 * Order is deliberate: refuse a referenced product BEFORE touching Shopify, and
 * never archive without a redirect in place. Until the online-store-navigation
 * scope is granted (see the spec's PREREQUISITE section) redirects cannot be
 * created at all, so every archive refuses with `missing-scope` and the cull is
 * dormant BY DESIGN. That is logged explicitly so a dormant cull is diagnosable
 * rather than looking like a broken job.
 */
export async function archiveProductGuarded(
  admin: AdminGraphql,
  store: TenantStore,
  opts: { cjPid: string; productId: string; handle: string; reason: string }
): Promise<ArchiveOutcome> {
  const refs = await store.referrersFor(opts.handle);
  if (refs.length) {
    const detail = `referenced by ${refs.map((r) => `${r.referrer_type}:${r.referrer_id}`).join(', ')}`;
    console.log(`archive refused for ${opts.handle}: ${detail}`);
    return { ok: false, refusal: 'referenced', detail };
  }

  // Redirect support lands in Task 7 behind the scope grant. Until then this is
  // the only reachable outcome for an unreferenced product, and it is correct.
  const detail = 'redirect unavailable: missing write_online_store_navigation';
  console.log(`archive refused for ${opts.handle}: ${detail}`);
  return { ok: false, refusal: 'missing-scope', detail };
}

/** Perform the Shopify archive. Private to this module BY DESIGN - the guard
 *  test fails if any other file writes status ARCHIVED. */
async function setArchived(admin: AdminGraphql, productId: string): Promise<void> {
  const data = await admin(ARCHIVE, { input: { id: productId, status: 'ARCHIVED' } });
  const errs = (data.productUpdate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

export const __setArchivedForTask7 = setArchived;
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/archive-guard.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/archive-guard.ts tests/archive-guard.test.ts
git commit -m "feat(catalog): archive guard refuses referenced products and missing scope"
```

---

### Task 4: Route all three archive paths through the guard

**Files:**
- Modify: `src/profitability.ts:541-543`
- Modify: `src/jobs.ts:125-139`
- Modify: `src/profit-console.ts:214-233`
- Modify: `src/proxy/inventory.ts:105-115`
- Test: `tests/archive-guard.test.ts` (extend with the source scan)

**Interfaces:**
- Consumes: `archiveProductGuarded`, `writesArchivedStatus` (Task 3).
- Produces: no new exports. `archiveProduct` is DELETED from `src/proxy/inventory.ts`.

**Run `python -m graphite impact src/profitability.ts` and read the call sites before editing** - it is imported by `index.ts`, `jobs.ts`, `profit-console.ts` and `proxy/import.ts`.

- [ ] **Step 1: Write the failing source-scan test (append to `tests/archive-guard.test.ts`)**

```typescript
declare global {
  interface ImportMeta {
    glob(pattern: string, opts: { query?: string; eager?: boolean; import?: string }): Record<string, string>;
  }
}
const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', eager: true, import: 'default' });

describe('single archive door', () => {
  it('only archive-guard.ts writes status ARCHIVED', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    const offenders = Object.entries(sources)
      .filter(([p]) => !p.endsWith('catalog/archive-guard.ts'))
      .filter(([, src]) => writesArchivedStatus(src))
      .map(([p]) => p);
    expect(offenders, `archive outside the guard: ${offenders.join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails, naming all three offenders**

Run: `npx vitest run tests/archive-guard.test.ts`
Expected: FAIL listing `../src/jobs.ts`, `../src/profit-console.ts`, `../src/proxy/inventory.ts`.

- [ ] **Step 3: Delete `archiveProduct` from `src/proxy/inventory.ts`**

Remove the whole `archiveProduct` function (lines 105-115 region) and its `ARCHIVE`-style mutation constant. Remove `archiveProduct` from the import list at `src/profitability.ts:18`.

- [ ] **Step 4: Make the agent flag instead of archive, in `src/profitability.ts`**

Replace lines 541-543:

```typescript
  } else if (action.kind === 'drop') {
    if (!dryRun) { await archiveProduct(admin, pid); await store.putLink({ cjPid: link.cj_pid, state: 'archived' }); }
  }
```

with:

```typescript
  }
  // The agent NEVER archives a live product (2026-07-31). A drop verdict is a
  // signal for the owner, not an action: archiving is the cull's job and must go
  // through archiveProductGuarded. decideProfitAction is intentionally unchanged
  // because the IMPORT entry gate still needs `drop` to mean "refuse admission".
```

Then, immediately after `const action = decideProfitAction(...)` on line 525, remap for the live path:

```typescript
  // Live products: a `drop` becomes a `flag` for owner review.
  const liveAction = action.kind === 'drop'
    ? { kind: 'flag' as const, reason: `${action.reason} (flagged for review - the agent no longer archives live products)` }
    : action;
```

Use `liveAction` in place of `action` for the `verdict`, `upsertProfitVerdict`, ledger, and return value. Leave the `reprice` branch reading `action` so the typed `updates` field stays available.

- [ ] **Step 5: Route the cull through the guard, in `src/jobs.ts`**

Replace the body of the `for (const link of stale)` loop (lines 127-138) with:

```typescript
  for (const link of stale) {
    if (!link.shopify_product_id || !link.handle) continue;
    const out = await archiveProductGuarded(admin, store, {
      cjPid: link.cj_pid,
      productId: link.shopify_product_id,
      handle: link.handle,
      reason: 'no-movement cull',
    });
    if (out.ok) { await store.putLink({ cjPid: link.cj_pid, state: 'archived' }); archived++; }
    else console.log(`cull: skipped ${link.cj_pid} - ${out.refusal}: ${out.detail}`);
  }
```

Delete the `ARCHIVE` constant at `src/jobs.ts:102-105` and add the import.

- [ ] **Step 6: Route the console archive through the guard, in `src/profit-console.ts`**

Replace lines 228-231 of `archiveProfitProduct` with:

```typescript
  if (!link.handle) return { ok: false, error: 'No handle on that link' };
  const out = await archiveProductGuarded(admin, store, {
    cjPid, productId: link.shopify_product_id, handle: link.handle, reason: 'owner console archive',
  });
  if (!out.ok) return { ok: false, error: `${out.refusal}: ${out.detail}` };
  await store.putLink({ cjPid, state: 'archived' });
  return { ok: true };
```

Delete the `SET_PRODUCT_STATUS` constant at lines 214-216 and add the import.

- [ ] **Step 7: Run the guard test plus every impacted suite**

Run: `npx vitest run tests/archive-guard.test.ts tests/guard.test.ts tests/profit-agent.test.ts tests/profitability.test.ts tests/profit-console.test.ts tests/jobs.test.ts`
Expected: PASS. Existing tests asserting the agent archives must be UPDATED to assert it flags - that is the intended behaviour change, not a regression to paper over.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/profitability.ts src/jobs.ts src/profit-console.ts src/proxy/inventory.ts tests/
git commit -m "feat(catalog): single archive door; agent flags instead of archiving"
```

---

### Task 5: Split the profit flag

**Files:**
- Modify: `src/types.ts:98` region (the `ProfitConfig` interface)
- Modify: `src/profitability.ts:578`
- Test: `tests/profit-agent.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ProfitConfig.repriceEnabled?: boolean`. `profit.enabled` keeps gating the entry gates.

- [ ] **Step 1: Write the failing test (append to `tests/profit-agent.test.ts`)**

```typescript
it('repriceEnabled:false stops the live sweep but leaves the entry gate on', async () => {
  const cfg = { ...baseCfg, profit: { ...baseCfg.profit, enabled: true, repriceEnabled: false } };
  const res = await runProfitAgent(store, admin, llm, cfg as never, {});
  expect(res.scanned).toBe(0);
  expect(cfg.profit.enabled).toBe(true); // entry gate untouched
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/profit-agent.test.ts`
Expected: FAIL, `scanned` is not 0.

- [ ] **Step 3: Add the field in `src/types.ts`**

In the `ProfitConfig` interface add:

```typescript
  /** Gates the LIVE reprice sweep only. `enabled` gates the ADMISSION gates
   *  (import + search). Split 2026-07-31 so the sweep can be stopped without
   *  also disabling admission - they shared one flag before. Default true. */
  repriceEnabled?: boolean;
```

- [ ] **Step 4: Gate the sweep in `src/profitability.ts:578`**

```typescript
  if (!profit?.enabled) return { scanned: 0, acted: 0, repriced: 0, dropped: 0, flagged: 0, total: 0, next: null, dryRun };
  if (profit.repriceEnabled === false) return { scanned: 0, acted: 0, repriced: 0, dropped: 0, flagged: 0, total: 0, next: null, dryRun };
```

- [ ] **Step 5: Run and commit**

Run: `npx vitest run tests/profit-agent.test.ts`
Expected: PASS.

```bash
git add src/types.ts src/profitability.ts tests/profit-agent.test.ts
git commit -m "feat(profit): split repriceEnabled from the admission gate flag"
```

---

### Task 6: Search-time margin gate on ghost cards

**Files:**
- Modify: `src/proxy/search.ts`
- Test: `tests/search-profit-gate.test.ts`

**Interfaces:**
- Consumes: `netAfterAdsGbp(landedUsd, freightUsd, pricing, profit)` from `src/profitability.ts:48`.
- Produces: `ghostCardClearsFloor(card, cfg): boolean`, exported from `src/proxy/search.ts`.

Ghost cards are supplier products NOT in the catalog, so this gate structurally cannot touch inventory products.

- [ ] **Step 1: Write the failing test**

Create `tests/search-profit-gate.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ghostCardClearsFloor } from '../src/proxy/search';

const cfg = {
  pricing: { markup: 2.2, vatRate: 0.2 },
  profit: { enabled: true, floorGbp: 2, adShare: 0.1, vatRate: 0.2 },
} as never;

describe('ghostCardClearsFloor', () => {
  it('keeps a card that clears the profit floor', () => {
    expect(ghostCardClearsFloor({ sellPriceUsd: 30, freightUsd: 3 } as never, cfg)).toBe(true);
  });

  it('drops a card that cannot clear the floor', () => {
    expect(ghostCardClearsFloor({ sellPriceUsd: 0.5, freightUsd: 9 } as never, cfg)).toBe(false);
  });

  it('makes ZERO network calls (it runs on a live shopper request)', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    ghostCardClearsFloor({ sellPriceUsd: 30, freightUsd: 3 } as never, cfg);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('passes the card through when the profit gate is disabled', () => {
    const off = { ...cfg, profit: { ...(cfg as never as { profit: object }).profit, enabled: false } } as never;
    expect(ghostCardClearsFloor({ sellPriceUsd: 0.5, freightUsd: 9 } as never, off)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/search-profit-gate.test.ts`
Expected: FAIL, `ghostCardClearsFloor` is not exported.

- [ ] **Step 3: Implement it in `src/proxy/search.ts`**

Add near the other gate helpers (around `liveCjPasses`, line 244):

```typescript
/**
 * Read-time profitability gate for ghost cards (2026-07-31).
 *
 * DETERMINISTIC and NETWORK-FREE by design: this runs on a live shopper request,
 * so it must not call eBay or an LLM. It reuses the same landed-cost maths the
 * import entry gate uses, so a card we would refuse to import is not shown.
 * The FULL judgment still runs at import if the shopper clicks - the two can
 * disagree at the margin, which is accepted (see the spec's residual risks).
 */
export function ghostCardClearsFloor(
  item: { sellPriceUsd: number; freightUsd?: number },
  cfg: TenantConfig
): boolean {
  const profit = cfg.profit as ProfitConfig | undefined;
  if (!profit?.enabled) return true; // gate dormant - unchanged behaviour
  const net = netAfterAdsGbp(item.sellPriceUsd, item.freightUsd ?? 0, cfg.pricing, profit);
  return net.netGbp >= (profit.floorGbp ?? 0);
}
```

Import `netAfterAdsGbp` and `ProfitConfig` at the top of the file.

- [ ] **Step 4: Apply it to the live-CJ result path**

In `searchBackfill`, filter cards before they are pushed:

```typescript
    if (!ghostCardClearsFloor(item, cfg)) continue;
```

Place it immediately after the existing `liveCjPasses(...)` check so an unprofitable card never reaches the grid.

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run tests/search-profit-gate.test.ts tests/search.test.ts`
Expected: PASS.

```bash
git add src/proxy/search.ts tests/search-profit-gate.test.ts
git commit -m "feat(search): deterministic profitability gate on ghost cards"
```

---

### Task 7: Redirect creation in the guard (BLOCKED BY TASK 0)

**Files:**
- Create: `src/catalog/redirects.ts`
- Modify: `src/catalog/archive-guard.ts`
- Test: `tests/archive-guard.test.ts` (extend)

**Interfaces:**
- Consumes: `AdminGraphql`; `store.referrersFor`.
- Produces: `createRedirect(admin, path, target)`, `deleteRedirect(admin, id)`, `findRedirect(admin, path)`, `pickRedirectTarget(store, link)`.

- [ ] **Step 1: Write the failing test (append to `tests/archive-guard.test.ts`)**

```typescript
it('creates a redirect BEFORE archiving, and archives only if it succeeded', async () => {
  const calls: string[] = [];
  const admin = async (q: string) => {
    if (q.includes('urlRedirectCreate')) { calls.push('redirect'); return { urlRedirectCreate: { urlRedirect: { id: 'gid://1' }, userErrors: [] } }; }
    if (q.includes('productUpdate')) { calls.push('archive'); return { productUpdate: { product: { id: 'p' }, userErrors: [] } }; }
    return { urlRedirects: { nodes: [] } };
  };
  const out = await archiveProductGuarded(admin as never, store, {
    cjPid: '9', productId: 'gid://shopify/Product/9', handle: 'dead-item', reason: 'cull',
  });
  expect(out.ok).toBe(true);
  expect(calls).toEqual(['redirect', 'archive']); // ORDER is the assertion
});

it('does NOT archive when redirect creation fails', async () => {
  const calls: string[] = [];
  const admin = async (q: string) => {
    if (q.includes('urlRedirectCreate')) return { urlRedirectCreate: { urlRedirect: null, userErrors: [{ message: 'boom' }] } };
    if (q.includes('productUpdate')) { calls.push('archive'); return { productUpdate: { userErrors: [] } }; }
    return { urlRedirects: { nodes: [] } };
  };
  const out = await archiveProductGuarded(admin as never, store, {
    cjPid: '10', productId: 'gid://shopify/Product/10', handle: 'dead-2', reason: 'cull',
  });
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.refusal).toBe('redirect-failed');
  expect(calls).toEqual([]); // never archived
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/archive-guard.test.ts`
Expected: FAIL - the guard still returns `missing-scope`.

- [ ] **Step 3: Implement `src/catalog/redirects.ts`**

```typescript
import type { AdminGraphql } from '../shopify-admin';

const CREATE = `mutation pawscoutRedirectCreate($urlRedirect: UrlRedirectInput!) {
  urlRedirectCreate(urlRedirect: $urlRedirect) {
    urlRedirect { id }
    userErrors { field message }
  }
}`;

const DELETE = `mutation pawscoutRedirectDelete($id: ID!) {
  urlRedirectDelete(id: $id) { deletedRedirectId userErrors { field message } }
}`;

const FIND = `query pawscoutRedirectFind($q: String!) {
  urlRedirects(first: 1, query: $q) { nodes { id path target } }
}`;

/** Existing redirect for a path, or null. The backfill MUST call this first or a
 *  re-run mints duplicates. Requires read_online_store_navigation. */
export async function findRedirect(admin: AdminGraphql, path: string): Promise<{ id: string } | null> {
  const data = await admin(FIND, { q: `path:${path}` });
  const nodes = (data.urlRedirects as { nodes?: { id: string; path: string }[] } | undefined)?.nodes ?? [];
  const hit = nodes.find((n) => n.path === path);
  return hit ? { id: hit.id } : null;
}

export async function createRedirect(admin: AdminGraphql, path: string, target: string): Promise<void> {
  const data = await admin(CREATE, { urlRedirect: { path, target } });
  const errs = (data.urlRedirectCreate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

export async function deleteRedirect(admin: AdminGraphql, id: string): Promise<void> {
  const data = await admin(DELETE, { id });
  const errs = (data.urlRedirectDelete as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/** ACCESS_DENIED doubles as the scope check - the pattern proven at
 *  src/affiliate-discounts.ts:85. Returns false when the scope is absent. */
export async function redirectsAvailable(admin: AdminGraphql): Promise<boolean> {
  try { await admin(FIND, { q: 'path:/products/__scope_probe__' }); return true; }
  catch (e) { return !/ACCESS_DENIED|not approved|scope/i.test((e as Error).message); }
}
```

- [ ] **Step 4: Wire it into `archiveProductGuarded`**

Replace the Task 3 placeholder block (the unconditional `missing-scope` return) with:

```typescript
  if (!(await redirectsAvailable(admin))) {
    const detail = 'redirect unavailable: missing write_online_store_navigation';
    console.log(`archive refused for ${opts.handle}: ${detail}`);
    return { ok: false, refusal: 'missing-scope', detail };
  }

  const target = await pickRedirectTarget(store, opts.handle);
  const path = `/products/${opts.handle}`;
  try {
    if (!(await findRedirect(admin, path))) await createRedirect(admin, path, target);
  } catch (e) {
    const detail = `redirect creation failed: ${(e as Error).message}`;
    console.warn(`archive aborted for ${opts.handle}: ${detail}`);
    return { ok: false, refusal: 'redirect-failed', detail };
  }

  await setArchived(admin, opts.productId);
  return { ok: true };
```

Add `pickRedirectTarget` to `src/catalog/redirects.ts`:

```typescript
/** Deterministic, NO LLM, so the 112-URL backfill is cheap and verifiable:
 *  same-category live product with the most 30-day events, else the collection
 *  page, else /collections/all. Never a 404. */
export async function pickRedirectTarget(store: TenantStore, handle: string): Promise<string> {
  const link = await store.getLinkByHandle(handle);
  const category = link?.category ?? null;
  if (category) {
    const best = await store.topLiveHandleInCategory(category);
    if (best && best !== handle) return `/products/${best}`;
    return `/collections/${category}`;
  }
  return '/collections/all';
}
```

Add `getLinkByHandle(handle)` and `topLiveHandleInCategory(category)` to `src/tenant-store.ts` (D1 access must live there - the guard test enforces it):

```typescript
async getLinkByHandle(handle: string): Promise<ProductLink | null> {
  return await this.db
    .prepare(`SELECT * FROM product_links WHERE shop = ?1 AND handle = ?2`)
    .bind(this.shop, handle)
    .first<ProductLink>();
}

/** Most-engaged live product in a category: most product_events in 30 days,
 *  ties broken by most recently created link. */
async topLiveHandleInCategory(category: string): Promise<string | null> {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const row = await this.db
    .prepare(
      `SELECT pl.handle AS h, COUNT(pe.id) AS n
         FROM product_links pl
         LEFT JOIN product_events pe
           ON pe.shop = pl.shop AND pe.cj_pid = pl.cj_pid AND pe.created_at >= ?3
        WHERE pl.shop = ?1 AND pl.state = 'imported' AND pl.category = ?2
          AND pl.handle IS NOT NULL
        GROUP BY pl.handle
        ORDER BY n DESC, pl.created_at DESC
        LIMIT 1`
    )
    .bind(this.shop, category, since)
    .first<{ h: string; n: number }>();
  return row?.h ?? null;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/archive-guard.test.ts tests/guard.test.ts`
Expected: PASS. The `guard.test.ts` D1 tripwire must stay green - all new SQL is inside `tenant-store.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/catalog/redirects.ts src/catalog/archive-guard.ts src/tenant-store.ts tests/archive-guard.test.ts
git commit -m "feat(catalog): create a URL redirect before every archive"
```

---

### Task 8: Restore deletes the redirect first (BLOCKED BY TASK 0)

**Files:**
- Modify: `src/jobs.ts:143-166` (`restoreCulledProducts`)
- Test: `tests/jobs.test.ts` (extend)

**Interfaces:**
- Consumes: `findRedirect`, `deleteRedirect` (Task 7).
- Produces: no new exports.

Without this, a restored product's own URL redirects away from itself and it is unreachable while live.

- [ ] **Step 1: Write the failing test (append to `tests/jobs.test.ts`)**

```typescript
it('deletes the redirect BEFORE un-archiving, so a restored product is reachable', async () => {
  const calls: string[] = [];
  const admin = async (q: string) => {
    if (q.includes('urlRedirects')) return { urlRedirects: { nodes: [{ id: 'gid://r/1', path: '/products/restored-item' }] } };
    if (q.includes('urlRedirectDelete')) { calls.push('delete'); return { urlRedirectDelete: { deletedRedirectId: 'gid://r/1', userErrors: [] } }; }
    if (q.includes('productUpdate')) { calls.push('activate'); return { productUpdate: { userErrors: [] } }; }
    return {};
  };
  await store.putLink({ cjPid: 'r1', state: 'archived', shopifyProductId: 'gid://shopify/Product/7', handle: 'restored-item' });
  await restoreCulledProducts(store, admin as never, new Date(Date.now() - 86400_000).toISOString());
  expect(calls).toEqual(['delete', 'activate']); // ORDER is the assertion
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/jobs.test.ts`
Expected: FAIL, `calls` is `['activate']`.

- [ ] **Step 3: Implement**

In the restore loop, before the status-to-ACTIVE mutation:

```typescript
    // Delete the redirect FIRST. A live product whose own /products/<handle>
    // still redirects elsewhere is unreachable - the restore would look like it
    // worked while the product stayed invisible.
    if (link.handle) {
      try {
        const existing = await findRedirect(admin, `/products/${link.handle}`);
        if (existing) await deleteRedirect(admin, existing.id);
      } catch (e) {
        console.warn(`restore: redirect cleanup failed for ${link.cj_pid}: ${(e as Error).message}`);
        continue; // do NOT un-archive behind a live redirect
      }
    }
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run tests/jobs.test.ts`
Expected: PASS.

```bash
git add src/jobs.ts tests/jobs.test.ts
git commit -m "fix(catalog): delete the redirect before restoring an archived product"
```

---

### Task 9: Backfill the 112 archived URLs (BLOCKED BY TASK 0)

**Files:**
- Modify: `src/jobs.ts` (new exported function)
- Modify: `src/console/routes.ts` (owner-triggered action)
- Test: `tests/jobs.test.ts` (extend)

**Interfaces:**
- Consumes: `findRedirect`, `createRedirect`, `pickRedirectTarget` (Task 7).
- Produces: `backfillArchivedRedirects(store, admin, opts): Promise<{ scanned: number; created: number; skipped: number }>`.

- [ ] **Step 1: Write the failing test (append to `tests/jobs.test.ts`)**

```typescript
it('is idempotent - a second run creates nothing', async () => {
  const created: string[] = [];
  const existing = new Set<string>();
  const admin = async (q: string, v?: Record<string, unknown>) => {
    if (q.includes('urlRedirects')) {
      const path = String(v?.q ?? '').replace(/^path:/, '');
      return { urlRedirects: { nodes: existing.has(path) ? [{ id: 'gid://r', path }] : [] } };
    }
    if (q.includes('urlRedirectCreate')) {
      const path = String((v?.urlRedirect as { path: string }).path);
      created.push(path); existing.add(path);
      return { urlRedirectCreate: { urlRedirect: { id: 'gid://r' }, userErrors: [] } };
    }
    return {};
  };
  await store.putLink({ cjPid: 'a1', state: 'archived', shopifyProductId: 'gid://p/1', handle: 'dead-one' });
  const first = await backfillArchivedRedirects(store, admin as never, {});
  expect(first.created).toBe(1);
  const second = await backfillArchivedRedirects(store, admin as never, {});
  expect(second.created).toBe(0);
  expect(second.skipped).toBe(1);
  expect(created).toEqual(['/products/dead-one']);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/jobs.test.ts`
Expected: FAIL, `backfillArchivedRedirects` is not exported.

- [ ] **Step 3: Implement in `src/jobs.ts`**

```typescript
/**
 * One-off (re-runnable) backfill: give every already-archived product a redirect
 * so it stops 404ing. Measured 2026-07-31: 112 archived links, all with handles.
 * Idempotent - findRedirect is checked first, so a re-run creates nothing.
 */
export async function backfillArchivedRedirects(
  store: TenantStore,
  admin: AdminGraphql,
  opts: { limit?: number } = {}
): Promise<{ scanned: number; created: number; skipped: number }> {
  const links = await store.listArchivedLinksWithHandles(opts.limit ?? 500);
  let created = 0, skipped = 0;
  for (const link of links) {
    if (!link.handle) { skipped++; continue; }
    const path = `/products/${link.handle}`;
    try {
      if (await findRedirect(admin, path)) { skipped++; continue; }
      await createRedirect(admin, path, await pickRedirectTarget(store, link.handle));
      created++;
    } catch (e) {
      console.warn(`backfill: ${link.handle} failed: ${(e as Error).message}`);
      skipped++;
    }
  }
  return { scanned: links.length, created, skipped };
}
```

Add to `src/tenant-store.ts`:

```typescript
async listArchivedLinksWithHandles(limit = 500): Promise<ProductLink[]> {
  const rs = await this.db
    .prepare(
      `SELECT * FROM product_links
        WHERE shop = ?1 AND state = 'archived' AND handle IS NOT NULL AND handle <> ''
        ORDER BY updated_at ASC LIMIT ${Math.min(Math.max(limit, 1), 1000)}`
    )
    .bind(this.shop)
    .all<ProductLink>();
  return rs.results ?? [];
}
```

- [ ] **Step 4: Add the owner-triggered console action**

In `src/console/routes.ts`, add:

```typescript
app.post('/api/catalog/backfill-redirects', async (c) => {
  const ctx = await requireOwner(c);           // same helper the profit routes use
  if (!ctx.ok) return c.json({ ok: false, error: ctx.error }, 403);
  const res = await backfillArchivedRedirects(ctx.store, ctx.admin, {});
  return c.json({ ok: true, ...res });
});
```

Read the neighbouring profit route immediately above to confirm the exact owner-auth helper name and the `ctx` shape before writing this - do not assume `requireOwner`.

In `src/console/views/profit.ts`, add the button next to the existing Clear/Recalibrate/Restore row:

```html
<button type="button" class="ghost" onclick="pfBackfillRedirects(this)">Backfill archive redirects</button>
```

and in `src/console/profit-js.ts` add the handler, mirroring `pfRestoreCulled` (around line 281):

```javascript
async function pfBackfillRedirects(btn){
  setMsg('pf-msg','Creating redirects for archived products…','muted');
  const r = await fetch('/api/catalog/backfill-redirects',{method:'POST'});
  const j = await r.json();
  setMsg('pf-msg', j.ok ? (j.created+' redirect(s) created, '+j.skipped+' already covered') : ('Failed: '+j.error), j.ok?'ok':'bad');
}
```

Remember `src/console/page.ts` is one template literal - escape backslashes as `\\n` in any browser-JS string.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/jobs.test.ts tests/console.test.ts`
Expected: PASS. `tests/console.test.ts` is REQUIRED after touching console code - `src/console/page.ts` is one big template literal and tsc cannot see JS syntax errors inside it.

- [ ] **Step 6: Commit**

```bash
git add src/jobs.ts src/tenant-store.ts src/console/ tests/
git commit -m "feat(catalog): idempotent redirect backfill for archived products"
```

---

### Task 10: Wire the index rebuild into the nightly chain (BUILT 2026-07-31)

**Status: complete. Built larger than specified - see "What changed" below.**

**Files:**
- Create: `migrations/0036_referrer_index_stamp.sql`
- Modify: `src/catalog/referrers.ts` (`listArticlesForIndex`, `rebuildReferrerIndex`, `reindexArticle`)
- Modify: `src/tenant-store.ts` (`putReferrerIndexStamp`, `getReferrerIndexStamp`)
- Modify: `src/catalog/archive-guard.ts` (`indexUsable`, `index-incomplete` refusal)
- Modify: `src/jobs.ts` (`referrer-index` stage above `cull`)
- Modify: `src/blog/pipeline.ts` (reindex after regenerate + enrich)
- Test: `tests/referrers.test.ts`, `tests/archive-guard.test.ts`, `tests/daily-chain.test.ts`

**What changed from the plan as written, and why.**

1. **The stage exports are `DAILY_SHOP_STAGES`, not `STAGES`** (`src/jobs.ts:1415`).
   `cull` was at index 0, so `referrer-index` is inserted above it. The existing
   name-reresolution test (`tests/daily-chain.test.ts:190`) already proves that
   inserting a stage mid-day is safe for a parked cursor.

2. **The article query shape in the plan was a guess and was wrong.** There is no
   root `articles(first:)` read here; the proven shape is
   `blogs(first:20) { nodes { articles(first:100) { nodes { ... } } } }`, copied
   from `HEALTH_ARTICLES_QUERY` (`src/blog/article-health.ts:192`), which is
   validated against the pinned 2026-04 schema. The metafield is
   **`namespace: "blog", key: "related_products"`**, NOT `custom`. The plan told
   the implementer to verify this rather than trust the guess; verified.

3. **`referrer_id` is the article GID, not its handle.** `clearProductReferrers`
   is scoped to one id, so a handle-keyed row is orphaned by any article rename
   and would block that product from archiving forever. The GID is stable and is
   also what `ARTICLE_BODY_UPDATE` takes, so Task 12's in-article repair needs no
   second lookup. `ArticleSource.handle` was renamed to `ArticleSource.articleId`.

4. **THE COMPLETENESS STAMP - the defect this task nearly shipped.**
   `referrers.ts` promises "a MISS means unknown and must BLOCK an archive", but
   the code could not honour it. `blogs(first:20) x articles(first:100)`
   truncates silently, and `runArticleHealth` merely *logs* `hasNextPage`. For
   healing, a missed article is degraded-but-safe. For the index it is not: an
   unindexed article makes `referrersFor(X)` return `[]`, which is
   indistinguishable from "genuinely unreferenced". Today `missing-scope` masks
   it. The moment Task 7 lands, that mask lifts and the guard becomes a 404
   generator aimed at exactly the products this project protects.

   So the rebuild records what it actually managed to read
   (`referrer_index_stamp`: `indexed_at`, `article_count`, `row_count`,
   `truncated`) and `archiveProductGuarded` refuses with `index-incomplete` when
   the stamp is **absent**, **truncated**, or **older than
   `INDEX_MAX_AGE_MS` (36h)**. 36h tolerates one skipped nightly run and refuses
   on two. The check runs BEFORE the referrer lookup: checking it second would
   let a never-built index answer "nothing references it" for every product.

5. **Per-article reindex on regenerate and enrich** (`reindexArticle`) uses the
   body and picks already in hand - no extra Admin call. It deliberately does NOT
   touch the stamp: a single-article refresh says nothing about whether the whole
   blog was read, and moving `indexed_at` there would let a stale index look
   fresh every time the owner regenerated a post. It never throws - an article
   write must not roll back because a derived cache could not be updated, and a
   miss can only over-block, never over-archive.

**Verification:** `npx vitest run tests/referrers.test.ts tests/archive-guard.test.ts
tests/daily-chain.test.ts tests/blog.test.ts tests/jobs.test.ts tests/guard.test.ts`
-> 154 passed. `npx tsc --noEmit` clean.

---

### Task 11: WITHDRAWN - the premise was falsified during implementation (2026-07-31)

**Status: not built, and it should not be. Superseded by the completeness stamp folded into Task 10.**

This task was written to add `syndication` and `collection` slices to the index,
on the reasoning that "once a Pinterest or Facebook post carries a product URL,
that link is outside our control forever". That reasoning is wrong for this
codebase, and the plan itself flagged the checks that proved it.

**What the code actually does:**

1. **Syndicated posts never carry a product URL.** `utmUrl`
   (`src/syndicate/channels.ts:16-18`) is the ONLY link builder in
   `src/syndicate/`, and it emits `${STORE_URL}/blogs/${BLOG_HANDLE}/${handle}`.
   A syndicated post links an ARTICLE. Archiving a product therefore cannot break
   the post; it puts a dead link inside the article, which `runArticleHealth`
   already heals nightly and which the blog slice already indexes.
2. **`syndication_ledger` has no product handles to read.** Migration 0029
   defines it as `(shop, post_id, channel, status, external_id, error, attempts,
   sent_at, created_at, updated_at)`. The plan's `listSyndicatedProductHandles`
   query would not have compiled against the real schema. The plan told the
   implementer to check the column existed first; it does not.
3. **The "collection" slice is the blog slice under another name.** The curated
   Shop-this-guide picks ARE the `blog`/`related_products` metafield, which
   `rebuildBlogReferrers` already unions into `relatedHandles`.
4. **Shopify collections do not 404 on archive.** A collection drops the product
   from its listing and keeps working. There is no broken referrer to prevent.

**The surface sweep that closed the question.** Every `/products/` URL the worker
constructs (`grep -rn "'/products/" src/`) is one of:

| Site | Durable? | Covered by |
|---|---|---|
| `src/blog/ground.ts:83` | yes - lands in article bodies | blog slice |
| `blog`/`related_products` metafield | yes | blog slice (`relatedHandles`) |
| `src/index.ts:1705`, `src/proxy/import.ts:72`, `src/proxy/search.ts:404,456` | no - response payloads | n/a |
| `src/console/profit-js.ts:28` | no - owner console only | n/a |
| `src/blog/draft.ts:36`, `quality.ts:81`, `sources.ts:91` | no - prompt text | n/a |

Affiliate and partner modules persist no product handles at all (they work off
discount codes); every `handle` match in `src/affiliate*` is a function name.

**The one genuinely uncovered surface: Online Store navigation menus.** A menu
item can point at `/products/<handle>` and would 404 on archive. It is NOT
indexed today. Reading menus needs `read_online_store_navigation` - the same
scope Task 0 requests and Tasks 7-9 wait on - so it is blocked by the same owner
action, and there is no point building it before that lands.

**Follow-up when the scope is granted:** add a `navigation` slice reading
`menus(first:)` -> `items { type resourceId }`, filtered to product resources,
keyed by menu GID. It is a strictly stronger refusal than `blog`: a menu item
cannot be repaired by rewriting an article, so a referenced product should be
refused outright rather than routed through Task 12's replacement path.

**What replaced this task's effort.** The review that falsified Task 11 surfaced
a real defect in Task 10's lap, and the budget went there instead: the index had
no way to distinguish "nothing references this product" from "the index never
read the article that does". `blogs(first:20) x articles(first:100)` silently
truncates, and `referrersFor()` returns `[]` either way. That would have turned
the guard into a 404 generator the moment Task 7 removed the `missing-scope`
mask. See `migrations/0036_referrer_index_stamp.sql`, `indexUsable()` in
`src/catalog/archive-guard.ts`, and the `index-incomplete` refusal.

---

### Task 12: Replace a referenced product in-article before archiving (BUILT 2026-08-01)

**Status: complete, committed `b5278d5`. Built WIDER than specified - see below.**

**THE PLAN HEALED ONE SURFACE; THERE ARE TWO.** As written this task only
rewrote the article BODY. But a product can be referenced solely by the curated
"Shop this guide" metafield (`blog`/`related_products`) and never appear in the
body at all - `rebuildBlogReferrers` indexes both, so such a product IS a blog
referrer. Healing the body alone would have archived a product that was still a
visible pick in the guide, leaving a dead entry in the shop block: the same
class of defect this task exists to prevent, one surface over.

`getArticleForEnrich` now returns `relatedHandles` (additive; `ARTICLE_READ`
gained the metafield) and both surfaces are repaired. The shop block prefers
whatever the body was relinked to, so the guide and its block agree, and a swap
that collides with an existing pick is deduped.

**Refusal is the fallback, never the default.** Every uncertain case leaves the
product live, because live is recoverable and a 404 in a published guide is not:
no live candidates; the heal left the dead link in place; the heal UNWRAPPED the
anchor rather than relinking (reachable, because `collectionPath` is passed as
null and `healArticleBody` treats null as "unwrap" - removing a 404 is not the
same as replacing a product); a non-blog referrer; or no `deps` wired at all.

**`deps` are wired ONLY at the nightly cull stage**, the one caller holding an
env, config and LLM. The owner console passes none and therefore still refuses
rather than silently archiving.

**Two properties verified at source rather than assumed:**
- `liveCandidates` cannot relink to a dead product: `groundCollection` sets
  `available = availableForSale && !!onlineStoreUrl` (`src/blog/ground.ts:85`),
  so an archived or unpublished product is excluded by the 404 truth, not just
  by stock.
- The repair path never calls `clearProductReferrers` or `reindexArticle`
  (grep-verified zero occurrences in `archive-guard.ts` and `jobs.ts`). Clearing
  an article's rows mid-run would drop OTHER products' blocks and let them
  archive unguarded. Index staleness after a repair therefore only ever
  over-blocks, and the nightly rebuild corrects it.

Ordering is pinned by a test: articles save BEFORE `setArchived`.

**Verification:** 155 files / 1968 tests green, tsc clean, and
`status: 'ARCHIVED'` appears only in `src/catalog/archive-guard.ts`.

---

<details>
<summary>Original task text as planned (kept for reference)</summary>

### Task 12 (as originally written)


Blocked because its success-path tests archive, and archiving requires a redirect (Task 7), which requires the scope. The refusal-path tests could run earlier, but keep the task whole rather than splitting it.

**Files:**
- Modify: `src/catalog/archive-guard.ts`
- Test: `tests/archive-guard.test.ts` (extend)

**Interfaces:**
- Consumes: `healArticleBody(llm, store, cfg, opts)` from `src/blog/article-health.ts:110`, whose `opts` is `{ body, articleTitle, deadHandles, candidates, collectionPath }` and which returns `{ body, samples }`. `HealCandidate` is `{ title: string; handle: string; path: string }`.
- Produces: the `no-replacement` refusal declared in Task 3's `ArchiveOutcome`.

This is the owner's central requirement: *"If a product becomes candidate for archiving and they are mentioned in blog posts, these products must be replaced with current live products."* Task 3 deliberately shipped the safe behaviour (always refuse when referenced); this task upgrades it to attempt replacement first, and refuse only when no congruent replacement exists.

Reuse `healArticleBody` rather than writing a second relink path - it already enforces the deterministic cage (the chosen handle MUST be in the grounded candidate list) that makes an LLM pick safe.

- [ ] **Step 1: Write the failing test (append to `tests/archive-guard.test.ts`)**

```typescript
it('REPLACES the product in the article, then archives', async () => {
  await store.putProductReferrers('old-tree', [{ referrerType: 'blog', referrerId: 'guide-a' }]);
  const saved: string[] = [];
  const deps = {
    loadArticle: async () => ({ title: 'Guide A', bodyHtml: '<a href="/products/old-tree">tree</a>' }),
    saveArticle: async (_h: string, body: string) => { saved.push(body); },
    liveCandidates: async () => [{ title: 'New Tree', handle: 'new-tree', path: '/products/new-tree' }],
    healBody: async () => ({ body: '<a href="/products/new-tree">tree</a>', samples: [] }),
  };
  const out = await archiveProductGuarded(okAdmin as never, store, {
    cjPid: '20', productId: 'gid://p/20', handle: 'old-tree', reason: 'cull',
  }, deps as never);
  expect(out.ok).toBe(true);
  expect(saved[0]).toContain('/products/new-tree');
  expect(saved[0]).not.toContain('/products/old-tree');
});

it('REFUSES when no congruent replacement exists - product stays live', async () => {
  await store.putProductReferrers('only-tree', [{ referrerType: 'blog', referrerId: 'guide-b' }]);
  const deps = {
    loadArticle: async () => ({ title: 'Guide B', bodyHtml: '<a href="/products/only-tree">t</a>' }),
    saveArticle: async () => { throw new Error('must not save'); },
    liveCandidates: async () => [],
    healBody: async () => ({ body: '<a href="/products/only-tree">t</a>', samples: [] }), // unchanged
  };
  const out = await archiveProductGuarded(okAdmin as never, store, {
    cjPid: '21', productId: 'gid://p/21', handle: 'only-tree', reason: 'cull',
  }, deps as never);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.refusal).toBe('no-replacement');
});

it('refuses a SYNDICATION referrer outright - an off-platform post cannot be edited', async () => {
  await store.putProductReferrers('posted-item', [{ referrerType: 'syndication', referrerId: 'syn-1' }]);
  const out = await archiveProductGuarded(okAdmin as never, store, {
    cjPid: '22', productId: 'gid://p/22', handle: 'posted-item', reason: 'cull',
  });
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.refusal).toBe('referenced');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run tests/archive-guard.test.ts`
Expected: FAIL - the guard still refuses every referenced product with `referenced`.

- [ ] **Step 3: Upgrade the guard**

Replace the Task 3 `if (refs.length) { ... return referenced }` block with:

```typescript
  // BLOG referrers are repairable: rewrite the article to a congruent live
  // product first, then archive. SYNDICATION and COLLECTION referrers are not
  // editable by us (a Facebook post is gone the moment it is published), so a
  // product they reference is refused outright.
  const unrepairable = refs.filter((r) => r.referrer_type !== 'blog');
  if (unrepairable.length) {
    const detail = `referenced by ${unrepairable.map((r) => `${r.referrer_type}:${r.referrer_id}`).join(', ')}`;
    console.log(`archive refused for ${opts.handle}: ${detail}`);
    return { ok: false, refusal: 'referenced', detail };
  }

  for (const ref of refs) {
    const article = await deps.loadArticle(ref.referrer_id);
    if (!article) continue;
    const candidates = await deps.liveCandidates(opts.handle);
    const healed = await deps.healBody({
      body: article.bodyHtml,
      articleTitle: article.title,
      deadHandles: [opts.handle],
      candidates,
      // null would UNWRAP the anchor as a last resort. We must not silently
      // strip the shopping path - no congruent product means refuse instead.
      collectionPath: null,
    });
    const stillThere = healed.body.includes(`/products/${opts.handle}`);
    if (stillThere || healed.body === article.bodyHtml) {
      const detail = `no congruent replacement for ${opts.handle} in ${ref.referrer_id}`;
      console.log(`archive refused: ${detail}`);
      return { ok: false, refusal: 'no-replacement', detail };
    }
    await deps.saveArticle(ref.referrer_id, healed.body);
  }
```

Add a `deps` parameter with a production default so the guard stays testable without network:

```typescript
export interface GuardDeps {
  loadArticle(handle: string): Promise<{ title: string; bodyHtml: string } | null>;
  saveArticle(handle: string, body: string): Promise<void>;
  liveCandidates(excludeHandle: string): Promise<HealCandidate[]>;
  healBody(opts: {
    body: string; articleTitle: string; deadHandles: string[];
    candidates: HealCandidate[]; collectionPath: string | null;
  }): Promise<{ body: string; samples: string[] }>;
}
```

The production wiring binds `healBody` to `healArticleBody(llm, store, cfg, opts)` and `liveCandidates` to the same grounded-candidate query `runArticleHealth` uses (window 50, per the 2026-07-19 fix - a window of 12 was all-dead because archives bury collection heads).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/archive-guard.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Ordering check**

Confirm the article save happens BEFORE `setArchived`. If the archive later fails, the article is already honest and the archive retries next run. The reverse order would leave a live article pointing at an archived product.

- [ ] **Step 6: Commit**

```bash
git add src/catalog/archive-guard.ts tests/archive-guard.test.ts
git commit -m "feat(catalog): replace referenced products in-article before archiving"
```

---

## Final verification (before requesting deploy-go)

- [ ] `npm run typecheck` - clean
- [ ] `npm run test:ci` - full suite green (~275s)
- [ ] `npx vitest run tests/guard.test.ts tests/archive-guard.test.ts` - both tripwires green
- [ ] Adversarial review of the whole branch (2 lenses, high effort)
- [ ] Confirm `git grep -n "status: 'ARCHIVED'" src/` returns ONLY `src/catalog/archive-guard.ts`

## Deploy sequence (owner go required)

1. Owner completes Task 0 re-auth and it is verified by a real call, not a consent screen
2. `npx wrangler d1 migrations apply pawscout --remote`
3. `npx wrangler deploy`
4. Owner clicks "Backfill archive redirects"
5. Verify by re-crawling a sample of the 112 archived URLs - expect 301, never 404
6. Verify the next cull tick logs a refusal for a referenced product rather than archiving it

</details>
