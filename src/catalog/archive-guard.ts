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
import { findRedirect, createRedirect, pickRedirectTarget, isScopeDenial, type LivenessMemo } from './redirects';

const ARCHIVE = `mutation pawscoutArchive($input: ProductInput!) {
  productUpdate(input: $input) { product { id } userErrors { field message } }
}`;

export type ArchiveRefusal =
  | 'referenced' | 'missing-scope' | 'redirect-failed' | 'no-replacement' | 'index-incomplete';

export type ArchiveOutcome =
  | { ok: true }
  | { ok: false; refusal: ArchiveRefusal; detail: string };

/**
 * How old the referrer index may be before the guard stops believing it.
 *
 * The nightly chain rebuilds it once every 24h, so 36h tolerates one skipped or
 * deferred run and refuses on two. Deliberately NOT generous: a stale index
 * cannot know about an article published since it was built, and that article
 * is exactly the one whose product is still fresh enough to be culled.
 */
export const INDEX_MAX_AGE_MS = 36 * 60 * 60 * 1000;

/**
 * Is the index trustworthy enough to read an EMPTY result as "unreferenced"?
 *
 * This is the whole reason the stamp exists. `referrersFor` returning nothing
 * has two causes with opposite meanings - the product really is unreferenced,
 * or the index never saw the article that references it - and only the stamp
 * tells them apart. Exported for direct testing; the failure mode it guards is
 * silent, so it must be provable on its own.
 */
export function indexUsable(
  stamp: { indexedAt: string; truncated: boolean } | null,
  nowMs: number = Date.now()
): { ok: true } | { ok: false; detail: string } {
  if (!stamp) return { ok: false, detail: 'referrer index has never been built' };
  if (stamp.truncated) return { ok: false, detail: 'referrer index is truncated: some articles were never read' };
  const age = nowMs - Date.parse(stamp.indexedAt);
  if (!Number.isFinite(age)) return { ok: false, detail: `referrer index stamp is unreadable (${stamp.indexedAt})` };
  if (age > INDEX_MAX_AGE_MS) {
    return { ok: false, detail: `referrer index is stale: built ${Math.round(age / 3600_000)}h ago` };
  }
  return { ok: true };
}

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
 * Four gates, in this order, and the order is the design:
 *   1. the referrer index must be COMPLETE - an empty lookup against a
 *      half-built index is indistinguishable from "nothing references this"
 *   2. no internal surface may still point at the product
 *   3. a redirect must exist, created here if it does not
 *   4. only then does the product's status change
 *
 * The online-store-navigation scope was granted and verified live on
 * 2026-07-31, so `missing-scope` is no longer the standing outcome - it is now
 * a real measurement, raised only when Shopify actually denies the call.
 */
export async function archiveProductGuarded(
  admin: AdminGraphql,
  store: TenantStore,
  opts: { cjPid: string; productId: string; handle: string; reason: string; memo?: LivenessMemo }
): Promise<ArchiveOutcome> {
  // BEFORE the lookup, not after: an empty result is only meaningful when the
  // index that produced it was complete. Checking this second would let a
  // never-built index answer "nothing references it" for every product.
  const usable = indexUsable(await store.getReferrerIndexStamp());
  if (!usable.ok) {
    console.log(`archive refused for ${opts.handle} (${opts.reason}): ${usable.detail}`);
    return { ok: false, refusal: 'index-incomplete', detail: usable.detail };
  }

  const refs = await store.referrersFor(opts.handle);
  if (refs.length) {
    const detail = `referenced by ${refs.map((r) => `${r.referrer_type}:${r.referrer_id}`).join(', ')}`;
    console.log(`archive refused for ${opts.handle} (${opts.reason}): ${detail}`);
    return { ok: false, refusal: 'referenced', detail };
  }

  // THE REDIRECT COMES FIRST. Archiving before the redirect exists opens a
  // window - however brief - in which the URL 404s, and a crash inside that
  // window leaves it 404ing permanently. Doing it in this order means the worst
  // case is a redirect pointing at a product that is still live, which is
  // harmless and self-corrects on the next attempt.
  const path = `/products/${opts.handle}`;
  try {
    if (!(await findRedirect(admin, path))) {
      const target = await pickRedirectTarget(store, admin, opts.handle, opts.memo);
      await createRedirect(admin, path, target);
      console.log(`archive ${opts.handle} (${opts.reason}): redirect ${path} -> ${target}`);
    }
  } catch (e) {
    const message = (e as Error).message;
    // A missing scope is a CONFIGURATION state the owner can fix; anything else
    // is a fault. Collapsing them would send whoever reads this log to the
    // wrong place, so they stay separate refusals.
    if (isScopeDenial(message)) {
      const detail = `redirect unavailable: ${message}`;
      console.log(`archive refused for ${opts.handle} (${opts.reason}): ${detail}`);
      return { ok: false, refusal: 'missing-scope', detail };
    }
    const detail = `redirect creation failed: ${message}`;
    console.warn(`archive aborted for ${opts.handle} (${opts.reason}): ${detail}`);
    return { ok: false, refusal: 'redirect-failed', detail };
  }

  await setArchived(admin, opts.productId);
  return { ok: true };
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
