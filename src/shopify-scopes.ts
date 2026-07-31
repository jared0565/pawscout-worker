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
import { makeAdminGraphql, type AdminGraphql } from './shopify-admin';
import type { Env } from './types';
import { TenantStore, listActiveShops } from './tenant-store';
import { Vault } from './vault';

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

/** Validated against the pinned 2026-04 Admin schema (shopify.dev, 2026-07-31):
 *  urlRedirects(first: Int) -> UrlRedirectConnection, nodes are UrlRedirect. */
const REDIRECT_READ = `query pawscoutRedirectReadProbe { urlRedirects(first: 1) { nodes { id } } }`;

/**
 * CAN THE TOKEN ACTUALLY USE THE SCOPE, as opposed to the installation merely
 * claiming it?
 *
 * These are different facts and the difference is load-bearing here.
 * `accessScopes` reports the INSTALLATION's scope set, which the Dev Dashboard
 * config drives. The worker's offline token was minted 2026-07-03 and
 * `ensureInstalled` never re-exchanges it, so a token that predates the grant
 * could in principle keep its old, narrower authority while the installation
 * reports the new scopes. Trusting `accessScopes` alone would unblock the
 * redirect work onto a mutation that then 403s.
 *
 * This settles it with a real call. It is READ-ONLY on purpose: the read scope
 * was granted in the same action as the write, and the token predates BOTH, so
 * a successful read proves the token's grant expanded server-side. Proving it
 * without writing anything to the live store is worth more than the marginal
 * certainty a throwaway redirect would add.
 */
export async function probeRedirectRead(admin: AdminGraphql): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await admin(REDIRECT_READ);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Which of `required` are absent from `granted`, preserving the required order. */
export function missingScopes(granted: string[], required: readonly string[]): string[] {
  const have = new Set(granted);
  return required.filter((r) => !have.has(r));
}

/** search_cache key holding the last logged redirect-scope verdict, per shop. */
export const SCOPE_WATCH_KEY = 'scope-watch:redirects';
const SCOPE_WATCH_TTL_DAYS = 1 / 24; // one hour

/**
 * THE DORMANT-CULL WATCH, on the 15-minute cron.
 *
 * Adding a scope in the Dev Dashboard and the app actually holding it are
 * different events, and nothing in this worker noticed the gap between them:
 * `ensureInstalled` returns early once a token exists (auth/ensure-installed.ts)
 * and never re-exchanges, while `tenants.scopes` keeps its mint-time value
 * forever. So the only honest answer comes from asking Shopify, and the only
 * place that answer was visible was a session-authed console page - useless to
 * a cron, a log reader, or anyone without a browser open.
 *
 * This logs the verdict so the state is observable without a session. Rate
 * limited to one line per shop per hour so it cannot flood the log, and it logs
 * the GRANTED case too: silence would otherwise be ambiguous between "all good"
 * and "the cron never ran", which is the ambiguity this whole exercise is about.
 *
 * Never throws - a diagnostic must not be able to break the sweep it rides on.
 */
export async function runScopeWatch(env: Env): Promise<void> {
  let vault: Vault;
  try { vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY); }
  catch (e) { console.warn(`scope watch: vault unavailable: ${(e as Error).message}`); return; }

  for (const shop of await listActiveShops(env.DB)) {
    try {
      const store = new TenantStore(env.DB, shop);
      if (await store.getSearchCache(SCOPE_WATCH_KEY)) continue; // logged within the hour
      const tenant = await store.getTenant();
      if (!tenant?.access_token_enc || !tenant.dek_wrapped) continue;
      const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
      const probe = await probeGrantedScopes(makeAdminGraphql(shop, accessToken));
      if (!probe.ok) {
        // NOT cached: a failed probe is not a verdict, and caching it would
        // suppress the real answer for an hour.
        console.warn(`scope watch ${shop}: probe FAILED: ${probe.error}`);
        continue;
      }
      const missing = missingScopes(probe.granted, REDIRECT_SCOPES);
      let verdict: string;
      if (missing.length) {
        verdict = `missing:${missing.join(',')}`;
        console.warn(`scope watch ${shop}: archive redirects BLOCKED, missing ${missing.join(', ')} - the no-movement cull refuses every archive. Granted: ${probe.granted.join(', ')}`);
      } else {
        // The installation claims both scopes. Confirm the TOKEN can use them
        // before anyone treats the redirect work as unblocked.
        const usable = await probeRedirectRead(makeAdminGraphql(shop, accessToken));
        verdict = usable.ok ? 'granted+usable' : `granted-but-unusable:${usable.error}`;
        if (usable.ok) {
          console.log(`scope watch ${shop}: archive redirect scopes GRANTED and the token can USE them (live urlRedirects read succeeded). Granted: ${probe.granted.join(', ')}`);
        } else {
          console.warn(`scope watch ${shop}: scopes are granted on the INSTALLATION but the token cannot use them: ${usable.error}. The token predates the grant and may need a re-exchange.`);
        }
      }
      await store.putSearchCache(SCOPE_WATCH_KEY, verdict, SCOPE_WATCH_TTL_DAYS);
    } catch (e) {
      console.warn(`scope watch failed for ${shop}: ${(e as Error).message}`);
    }
  }
}
