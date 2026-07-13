// Stage 1 verify route: the applicant clicks the magic link from Task 3's
// verify email. This is the ONLY step here - claim the single-use token,
// flip the application to 'verified', done. Actual channel judging + scoring
// (Stage 2-4) happens later, asynchronously, on the 15-minute screen sweep
// (see src/affiliate/screen.ts) - never inline on this request, so a slow or
// unavailable LLM/Firecrawl call can never delay or fail the applicant's
// click-through.
//
// Lives on the WORKER's own domain (pawscout.activepaw.co.uk), NOT under
// /proxy - the magic link in the verify email points straight at
// `${SHOPIFY_APP_URL}/affiliate/verify?token=...` (see apply.ts's
// issueVerifyLink), so there is no Shopify App Proxy signature to check here.
//
// No enumeration: an invalid, expired, or already-used token renders the
// exact same generic "link expired" page as any other failure - never a
// distinguishable error. The success page is tokenless (no email/name/token
// echoed back) and sets `Referrer-Policy: no-referrer` so a browser never
// leaks the (now-spent) token URL to an external page via the Referer header.

import type { TenantStore } from '../tenant-store';
import { AFFILIATE_STAGE_SUBMITTED, AFFILIATE_STAGE_VERIFIED } from '../tenant-store';
import { sha256Hex } from './apply';

export const EXPIRED_HTML =
  `<!doctype html><html><head><meta charset="utf-8"><title>Active Paw Partner Program</title></head>` +
  `<body><p>This link has expired or has already been used. If you are still trying to verify your ` +
  `application, please apply again.</p></body></html>`;

export const VERIFIED_HTML =
  `<!doctype html><html><head><meta charset="utf-8"><title>Active Paw Partner Program</title></head>` +
  `<body><h1>Email verified</h1><p>Thanks - your email is verified. We are reviewing your application ` +
  `and will be in touch by email soon.</p></body></html>`;

export interface VerifyResult { status: number; html: string }

/**
 * Claim the 'verify' token (atomic, single-use via `claimToken`'s
 * compare-and-swap) and, on success, advance the application to `verified`.
 * Always resolves - never throws past the caller - so the route can always
 * return 200 with the generic expired page on any unexpected failure (D1
 * hiccup, malformed token), matching the no-enumeration contract.
 *
 * The stage advance is CONDITIONAL (submitted -> verified only, Fix 1 -
 * 2026-07-13 final review): apply.ts's resend path can mint a SECOND valid
 * verify token for an application that has already left `submitted`
 * (verified/judging/approved_pending_issue are all resendable stages). If
 * that older token is later claimed - after the application has since been
 * screened all the way to `approved` (a live voucher already issued and
 * emailed) - claiming it must NEVER demote the row back to `verified` and
 * queue it for reprocessing (a second, salted voucher mint). The token is
 * still consumed (single-use) either way, and the SAME success page is
 * always shown - whether this claim genuinely verified the email or was a
 * no-op against an already-advanced row is never distinguishable to the
 * caller.
 */
export async function handleAffiliateVerify(store: TenantStore, tokenRaw: string): Promise<VerifyResult> {
  try {
    const token = (tokenRaw ?? '').trim();
    if (!token) return { status: 200, html: EXPIRED_HTML };
    const tokenHash = await sha256Hex(token);
    const applicationId = await store.claimToken(tokenHash, 'verify');
    if (!applicationId) return { status: 200, html: EXPIRED_HTML };
    await store.advanceApplicationStage(applicationId, AFFILIATE_STAGE_SUBMITTED, AFFILIATE_STAGE_VERIFIED);
    return { status: 200, html: VERIFIED_HTML };
  } catch (e) {
    console.warn(`[affiliate-verify] failed: ${(e as Error).message}`);
    return { status: 200, html: EXPIRED_HTML };
  }
}
