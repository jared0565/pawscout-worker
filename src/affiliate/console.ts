// Task 6: console-facing functions for the self-serve affiliate marketplace -
// the Applications card (list + owner Approve-anyway/Decline) and the
// selfServe config round-trip. Kept as plain, directly-testable functions
// (store/cfg/deps in, JSON-shaped result out) rather than inline in the Hono
// route handlers, matching this repo's established split for session-token-
// authed /api routes (see src/profit-console.ts's saveProfitFlags /
// src/console/routes.ts's getPartners) - no test in this codebase drives a
// session-token-authed /api route through app.request, so the route handlers
// in src/index.ts stay thin wrappers around these.
import type { TenantConfig } from '../types';
import { DEFAULT_SELF_SERVE } from '../types';
import {
  AFFILIATE_STAGE_OWNER_QUEUE, AFFILIATE_STAGE_DEFLECTED, AFFILIATE_STAGE_APPROVED, AFFILIATE_STAGE_DECLINED,
  type TenantStore
} from '../tenant-store';
import { issueOrQueue, declineApplication, applicationForConsole, type ApplicationForConsole, type ScreenDeps } from './screen';

export async function getApplicationsConsole(
  store: TenantStore, cfg: TenantConfig | null
): Promise<{ applications: ApplicationForConsole[]; selfServe: NonNullable<TenantConfig['selfServe']> }> {
  const apps = await store.listApplicationsForConsole();
  return {
    applications: apps.map(applicationForConsole),
    selfServe: cfg?.selfServe ?? DEFAULT_SELF_SERVE
  };
}

/** Owner override: issue the SAME bounded starter voucher (via issueVoucher,
 *  through the existing issueOrQueue path - 5% off / 2% commission / capped
 *  usage, never an unbounded code) for an application the automatic funnel
 *  routed to owner_queue or deflected. Refuses any other stage - an already-
 *  approved application already has a code (revoke/reissue lives on the
 *  Partners table instead), and a mid-flight stage should finish screening,
 *  not be short-circuited. */
export async function approveApplicationAnyway(
  deps: ScreenDeps, id: string
): Promise<{ ok: true; application: ApplicationForConsole } | { ok: false; error: string }> {
  const { store } = deps;
  const app = await store.getApplication(id);
  if (!app) return { ok: false, error: 'Application not found' };
  if (app.stage !== AFFILIATE_STAGE_OWNER_QUEUE && app.stage !== AFFILIATE_STAGE_DEFLECTED) {
    return { ok: false, error: 'Only owner_queue or deflected applications can be approved anyway' };
  }
  await issueOrQueue(deps, app, { score: app.score, factsJson: app.facts_json ?? '{}' });
  const after = await store.getApplication(id);
  if (after?.stage === AFFILIATE_STAGE_APPROVED) return { ok: true, application: applicationForConsole(after) };
  // issueOrQueue never throws - a Shopify/store failure parks the row at
  // approved_pending_issue (retried by the next screen sweep) and records the
  // error in flags_json (see issueOrQueue's lastIssueError write).
  let error = 'Could not issue the voucher (Shopify may be unreachable) - it will retry automatically';
  try {
    const f = JSON.parse(after?.flags_json || '{}') as { lastIssueError?: string };
    if (f.lastIssueError) error = f.lastIssueError;
  } catch { /* flags_json malformed - keep the generic message */ }
  return { ok: false, error };
}

/** Owner override: decline an application at any non-terminal stage. Refuses
 *  an already-approved application (a live voucher exists - revoke it from
 *  the Partners table, declining here would not touch it) and a
 *  already-declined one (idempotent no-op guard, not an error the owner needs
 *  to see twice). */
export async function declineApplicationById(
  deps: ScreenDeps, id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { store } = deps;
  const app = await store.getApplication(id);
  if (!app) return { ok: false, error: 'Application not found' };
  if (app.stage === AFFILIATE_STAGE_APPROVED) {
    return { ok: false, error: 'Already approved - revoke the voucher from the Partners table instead' };
  }
  if (app.stage === AFFILIATE_STAGE_DECLINED) return { ok: false, error: 'Already declined' };
  await declineApplication(deps, app);
  return { ok: true };
}
