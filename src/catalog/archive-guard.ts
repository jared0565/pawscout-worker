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
import type { HealCandidate } from '../blog/article-health';

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
 * The repair path, injected so the guard is testable without a network or an
 * LLM. Absent means "this caller cannot repair", and the guard then refuses any
 * referenced product rather than archiving one.
 */
export interface GuardDeps {
  loadArticle(articleId: string): Promise<{ title: string; bodyHtml: string; tags: string[]; relatedHandles: string[] } | null>;
  saveArticle(articleId: string, body: string): Promise<void>;
  /** Rewrite the curated "Shop this guide" picks. */
  saveRelated(articleId: string, handles: string[]): Promise<void>;
  /** Live, congruent products to relink to, excluding the one being archived. */
  liveCandidates(excludeHandle: string, tags: string[]): Promise<HealCandidate[]>;
  healBody(opts: {
    body: string; articleTitle: string; deadHandles: string[];
    candidates: HealCandidate[]; collectionPath: string | null;
  }): Promise<{ body: string; samples: string[] }>;
}

/** Distinct product handles a body links. Local copy for the same reason
 *  referrers.ts keeps one: this must not move when the heal pass changes. */
function bodyHandles(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*['"]\/products\/([a-zA-Z0-9][a-zA-Z0-9-]*)['"]/g)) out.add(m[1].toLowerCase());
  return out;
}

/**
 * Rewrite every guide that points at `handle` so it points somewhere live.
 *
 * THE ORDER MATTERS AND IT IS DELIBERATE: articles are saved BEFORE the caller
 * archives. If the archive then fails, the guides are already honest and the
 * archive simply retries next run. The reverse would leave a published guide
 * pointing at an archived product, which is the 404 this project exists to
 * prevent.
 *
 * A product can be referenced by the BODY, by the curated shop-block picks, or
 * both, and fixing only the body would archive a product that is still a
 * visible pick. Both surfaces are handled, and anything that cannot be fully
 * repaired refuses instead - the product stays live, which is always recoverable.
 */
async function replaceInArticles(
  deps: GuardDeps,
  articleIds: string[],
  handle: string
): Promise<{ ok: true } | { ok: false; detail: string }> {
  for (const articleId of articleIds) {
    const article = await deps.loadArticle(articleId);
    // A referrer row pointing at an article that no longer exists is stale
    // index data, not a reason to block: nothing customer-facing references
    // the product through it.
    if (!article) continue;

    const inBody = bodyHandles(article.bodyHtml).has(handle.toLowerCase());
    const inPicks = article.relatedHandles.some((h) => h.toLowerCase() === handle.toLowerCase());
    if (!inBody && !inPicks) continue; // index was stale; this guide moved on already

    const candidates = await deps.liveCandidates(handle, article.tags);
    if (!candidates.length) {
      return { ok: false, detail: `no live candidates to replace ${handle} in ${articleId}` };
    }

    let newBody = article.bodyHtml;
    let replacement: string | null = null;

    if (inBody) {
      const healed = await deps.healBody({
        body: article.bodyHtml,
        articleTitle: article.title,
        deadHandles: [handle],
        candidates,
        // NEVER a collection fallback here. healArticleBody treats a null path
        // as "unwrap the anchor", and unwrapping would silently delete the
        // shopping route from a published guide. If the LLM declines to pick,
        // that is a refusal, not a licence to strip the link.
        collectionPath: null,
      });
      const after = bodyHandles(healed.body);
      if (after.has(handle.toLowerCase())) {
        return { ok: false, detail: `no congruent replacement for ${handle} in ${articleId}` };
      }
      const added = [...after].filter((h) => !bodyHandles(article.bodyHtml).has(h));
      if (!added.length) {
        // The link went away without a replacement taking its place - that is
        // the unwrap case, and it loses the shopping path.
        return { ok: false, detail: `replacement for ${handle} in ${articleId} removed the link instead of relinking it` };
      }
      replacement = added[0];
      newBody = healed.body;
    }

    let newPicks: string[] | null = null;
    if (inPicks) {
      // Prefer whatever the body was relinked to, so the guide and its shop
      // block agree. Otherwise fall back to the top grounded candidate.
      const swap = replacement ?? candidates[0].handle;
      newPicks = article.relatedHandles
        .map((h) => (h.toLowerCase() === handle.toLowerCase() ? swap : h))
        .filter((h, i, a) => a.indexOf(h) === i); // a swap can duplicate an existing pick
    }

    if (inBody) await deps.saveArticle(articleId, newBody);
    if (newPicks) await deps.saveRelated(articleId, newPicks);
    console.log(`archive repair: ${articleId} no longer links ${handle}${replacement ? ` (now ${replacement})` : ''}`);
  }
  return { ok: true };
}

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
  opts: { cjPid: string; productId: string; handle: string; reason: string; memo?: LivenessMemo },
  deps?: GuardDeps
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

  // A referrer we cannot edit is final. Only `blog` is ours to rewrite; any
  // other type would mean a surface outside our control still points at the
  // product, and no amount of repair on our side fixes that.
  const unrepairable = refs.filter((r) => r.referrer_type !== 'blog');
  if (unrepairable.length) {
    const detail = `referenced by ${unrepairable.map((r) => `${r.referrer_type}:${r.referrer_id}`).join(', ')}`;
    console.log(`archive refused for ${opts.handle} (${opts.reason}): ${detail}`);
    return { ok: false, refusal: 'referenced', detail };
  }

  const blogRefs = refs.filter((r) => r.referrer_type === 'blog');
  if (blogRefs.length) {
    // Without deps there is no way to rewrite anything, so refusing is the only
    // honest answer. This is the path the owner console takes today: it can
    // still refuse, it just cannot repair.
    if (!deps) {
      const detail = `referenced by ${blogRefs.map((r) => `blog:${r.referrer_id}`).join(', ')} (no repair path wired for this caller)`;
      console.log(`archive refused for ${opts.handle} (${opts.reason}): ${detail}`);
      return { ok: false, refusal: 'referenced', detail };
    }
    const replaced = await replaceInArticles(deps, blogRefs.map((r) => r.referrer_id), opts.handle);
    if (!replaced.ok) {
      console.log(`archive refused for ${opts.handle} (${opts.reason}): ${replaced.detail}`);
      return { ok: false, refusal: 'no-replacement', detail: replaced.detail };
    }
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
