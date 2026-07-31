/**
 * THE SINGLE ARCHIVE DOOR.
 *
 * Before 2026-07-31 three independent code paths archived products - the profit
 * agent (proxy/inventory.ts archiveProduct), the no-movement cull (an inline
 * mutation in jobs.ts) and the owner console (another inline mutation in
 * profit-console.ts, whose comment said it was "mirroring the cull path"). Two
 * were written by copying the third, so any policy added to one would rot in
 * the others. They are collapsed here.
 *
 * `writesArchivedStatus` below powers a source-scanning test that fails the
 * build if any file OTHER than this one writes status ARCHIVED. That is what
 * makes "the profit agent has no reachable archive path" a provable property
 * rather than a convention.
 *
 * ORDER IS LOAD-BEARING:
 *   1. refuse a referenced product BEFORE touching Shopify
 *   2. never archive without a redirect already in place
 *   3. only then archive
 */
import type { AdminGraphql } from '../shopify-admin';
import type { TenantStore } from '../tenant-store';

const ARCHIVE = `mutation pawscoutArchive($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

export type ArchiveRefusal = 'referenced' | 'missing-scope' | 'redirect-failed' | 'no-replacement';

export type ArchiveOutcome =
  | { ok: true }
  | { ok: false; refusal: ArchiveRefusal; detail: string };

/**
 * Tripwire helper, exported for tests/archive-guard.test.ts.
 *
 * Matches a GraphQL status WRITE only. It must NOT match the bare token
 * `archived`: `link.state === 'archived'` comparisons, the ProductLink state
 * union and SQL predicates appear throughout src/ and are all innocent.
 *
 * This repo has already lost time to an over-broad guard regex - the original
 * guard.test.ts matched `.exec(` and flagged RegExp.exec as raw D1 access. The
 * fix was to narrow the TEST, not to change the innocent source. Keep this
 * anchored to `status:` + a quoted ARCHIVED literal.
 */
export function writesArchivedStatus(src: string): boolean {
  return /status\s*:\s*['"]ARCHIVED['"]/.test(src);
}

/**
 * The ONLY way a product may be archived.
 *
 * Redirect creation lands with the online-store-navigation scope. Until that
 * scope is granted, every archive of an unreferenced product refuses with
 * `missing-scope`, which means the no-movement cull and the owner's console
 * archive are BOTH DORMANT BY DESIGN. That is the accepted trade: nothing
 * archives, so nothing new 404s. It is logged with the scope name so a dormant
 * cull is diagnosable rather than looking like a broken job.
 */
export async function archiveProductGuarded(
  admin: AdminGraphql,
  store: TenantStore,
  opts: { cjPid: string; productId: string; handle: string; reason: string }
): Promise<ArchiveOutcome> {
  const refs = await store.referrersFor(opts.handle);
  if (refs.length) {
    const detail = `referenced by ${refs.map((r) => `${r.referrer_type}:${r.referrer_id}`).join(', ')}`;
    console.log(`archive refused for ${opts.handle} (${opts.reason}): ${detail}`);
    return { ok: false, refusal: 'referenced', detail };
  }

  // Redirect support is gated on read/write_online_store_navigation. Until the
  // owner grants it this is the only reachable outcome for an unreferenced
  // product, and refusing is correct - archiving here would mint the exact 404
  // class this whole change exists to eliminate.
  const detail = 'redirect unavailable: missing write_online_store_navigation';
  console.log(`archive refused for ${opts.handle} (${opts.reason}): ${detail}`);
  return { ok: false, refusal: 'missing-scope', detail };
}

/**
 * Perform the Shopify archive. PRIVATE BY DESIGN - the source-scanning test in
 * tests/archive-guard.test.ts fails if any other file writes status ARCHIVED,
 * so this must stay the only such call site in the codebase.
 */
export async function setArchived(admin: AdminGraphql, productId: string): Promise<void> {
  const data = await admin(ARCHIVE, { input: { id: productId, status: 'ARCHIVED' } });
  const errs = (data.productUpdate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}
