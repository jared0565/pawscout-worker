/**
 * WHAT THE APP CAN ACTUALLY DO, asked of Shopify rather than of our own notes.
 *
 * WHY THIS EXISTS. `tenants.scopes` is a string written when a token was last
 * stored, and it is NOT the authority. Measured 2026-07-31 against live D1: that
 * row still reads its 2026-07-03 value and is missing `write_content`, a scope
 * the blog pipeline demonstrably uses every night. Scopes added in the Dev
 * Dashboard are granted through token exchange and never write that column, so
 * it drifts silently and always understates what the app holds.
 *
 * That matters beyond tidiness. The whole archive-redirect chain is blocked on
 * `write_online_store_navigation`, and "did the grant actually land?" cannot be
 * answered by a clicked consent screen or by a remembered to-do. It has to be a
 * real call. This module is that call.
 */
import type { AdminGraphql } from './shopify-admin';

/** Validated against the pinned 2026-04 Admin schema (shopify.dev docs,
 *  2026-07-31): currentAppInstallation returns AppInstallation!, whose
 *  accessScopes is [AccessScope!]! and whose handle is the scope string. */
const GRANTED_SCOPES = `query pawscoutGrantedScopes {
  currentAppInstallation { accessScopes { handle } }
}`;

/**
 * Both scopes the archive-redirect work needs.
 *
 * READ is requested alongside WRITE because the redirect backfill queries
 * existing redirects to stay idempotent, and Shopify's docs do not state that
 * write implies read. One definition, shared by the system-states register and
 * by the redirect code, so a scope cannot be checked in one place and forgotten
 * in the other.
 */
export const REDIRECT_SCOPES = ['read_online_store_navigation', 'write_online_store_navigation'] as const;

export type ScopeProbe =
  | { ok: true; granted: string[] }
  | { ok: false; error: string };

/**
 * The live granted-scope list, sorted.
 *
 * Never throws. A probe failure is reported as `ok:false` with the reason, and
 * callers MUST NOT read that as "no scopes granted" - an unreachable Admin API
 * and a genuinely missing scope are different facts, and conflating them is how
 * a working feature gets diagnosed as a permissions problem.
 */
export async function probeGrantedScopes(admin: AdminGraphql): Promise<ScopeProbe> {
  try {
    const data = await admin(GRANTED_SCOPES) as {
      currentAppInstallation?: { accessScopes?: { handle?: string }[] };
    };
    const granted = (data.currentAppInstallation?.accessScopes ?? [])
      .map((s) => s?.handle)
      .filter((h): h is string => typeof h === 'string' && h.length > 0);
    return { ok: true, granted: granted.sort() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Which of `required` are absent from `granted`, preserving the required order. */
export function missingScopes(granted: string[], required: readonly string[]): string[] {
  const have = new Set(granted);
  return required.filter((r) => !have.has(r));
}
