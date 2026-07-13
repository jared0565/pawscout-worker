// Task 5 (2026-07-12): the affiliate self-serve partner portal - a read-only
// login dashboard where an APPROVED partner checks their own results (code,
// status, order count, commission earned, payout status) without emailing
// the owner. Lives on the WORKER's own domain (pawscout.activepaw.co.uk),
// NOT under /proxy - Shopify's App Proxy strips Cookie/Set-Cookie, so a real
// httpOnly session cookie is only possible here (see the design spec's
// "Partner portal (dashboard)" section). Ships DARK behind
// cfg.selfServe.enabled (default false), exactly like apply.ts/verify.ts.
//
// This module exports a testable CORE (handlePortalLogin/handlePortalGet/
// handlePortalData) that takes its dependencies as plain arguments, same
// dependency-injection pattern as src/affiliate/apply.ts's
// handleAffiliateApply. src/index.ts wires thin app.get/app.post adapters on
// top.
//
// Route shape (three routes total, matching docs/superpowers/plans/
// 2026-07-12-affiliate-self-serve-marketplace.md's Task 5 + the design spec's
// "Portal login + dashboard" row - ONE route for the whole GET surface, not a
// separate /session sub-route): GET /affiliate/portal is a single endpoint
// that does triple duty based on what's present on the request - a `token`
// query param claims a login link (issued by this module's handlePortalLogin
// AND by apply.ts's issueLoginLink, which already emails links to exactly
// this path for an existing live partner who tries to re-apply - see
// apply.ts line ~194); no token + a valid session cookie renders the
// dashboard; no token + no valid cookie renders the login form. POST
// /affiliate/portal/login takes an email and (uniformly) says "check your
// email". GET /affiliate/portal/data is the optional JSON twin of the
// dashboard, for a cookie-authenticated partner only.

import type { Env, TenantConfig } from '../types';
import { DEFAULT_SELF_SERVE } from '../types';
import type { TenantStore, PartnerPortalSummary } from '../tenant-store';
import { sha256Hex, issueLoginLink } from './apply';
import { defaultFetch } from '../safe-fetch';

// --- Session cookie: HMAC(partnerId|expiry), keyed with the worker's own
// Shopify app secret (same keying convention as gates.ts's signTimestamp and
// retention.ts's unsubscribe token - no new secret needed). Embeds its own
// expiry in the SIGNED payload (not just the cookie's Max-Age attribute) so
// expiry is enforced server-side regardless of what a client does with the
// cookie - this is what makes "an expired cookie is rejected" actually
// testable/verifiable, not just advisory. -----------------------------------

export const SESSION_COOKIE_NAME = 'pawscout_partner';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // Max-Age attribute, same 7 days
export const SESSION_COOKIE_PATH = '/affiliate/portal';

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare (same convention as gates.ts's own
 *  timingSafeEqual) - a session cookie is a bearer credential, so comparing
 *  its MAC must never leak timing information about how many leading bytes
 *  matched. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint a session cookie VALUE (the caller sets it on the response with the
 *  HttpOnly/Secure/SameSite=Lax/Path/Max-Age attributes). Format:
 *  `${partnerId}.${expiryMs}.${mac}` where mac = HMAC-SHA256(`${partnerId}|${expiryMs}`, secret).
 *  partnerId is always a crypto.randomUUID() (no dots), so the 3-part split
 *  in verifySessionCookieValue is unambiguous. */
export async function mintSessionCookieValue(partnerId: string, secret: string, nowMs: number): Promise<string> {
  const expiryMs = nowMs + SESSION_TTL_MS;
  const mac = await hmacHex(`${partnerId}|${expiryMs}`, secret);
  return `${partnerId}.${expiryMs}.${mac}`;
}

/** Verify + parse a session cookie value. Returns the embedded partnerId
 *  when the signature is valid and not expired; null covers every failure
 *  mode alike (missing, malformed, tampered, wrong secret, expired) - the
 *  caller folds all of these into the same "render the login form" outcome,
 *  never a distinguishable error (a tampered cookie must never behave
 *  differently from a merely-expired one). */
export async function verifySessionCookieValue(value: string | undefined | null, secret: string, nowMs: number): Promise<string | null> {
  const parts = (value ?? '').split('.');
  if (parts.length !== 3) return null;
  const [partnerId, expiryStr, mac] = parts;
  if (!partnerId) return null;
  const expiryMs = Number(expiryStr);
  if (!Number.isFinite(expiryMs)) return null;
  const expected = await hmacHex(`${partnerId}|${expiryMs}`, secret);
  if (!timingSafeEqual(expected, mac)) return null;
  if (nowMs >= expiryMs) return null;
  return partnerId;
}

// --- HTML rendering (worker-rendered, no build step, no framework - same
// convention as apply.ts's renderApplyForm) ----------------------------------

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function money(n: number): string {
  return `£${n.toFixed(2)}`;
}

export const PORTAL_DARK_HTML =
  `<!doctype html><html><head><meta charset="utf-8"><title>Active Paw Partner Portal</title></head>` +
  `<body><p>The partner portal is not currently available. Please check back soon.</p></body></html>`;

/** Uniform (no-enumeration) response body for POST /affiliate/portal/login -
 *  EXPORTED so tests can assert byte-identity against it directly. */
export const GENERIC_LOGIN_HTML =
  `<!doctype html><html><head><meta charset="utf-8"><title>Active Paw Partner Portal</title></head>` +
  `<body><p>If that email is a registered partner, we have sent a login link. It is valid for 48 hours.</p></body></html>`;

export const SESSION_EXPIRED_HTML =
  `<!doctype html><html><head><meta charset="utf-8"><title>Active Paw Partner Portal</title></head>` +
  `<body><p>This link has expired or has already been used. Please request a new login link.</p></body></html>`;

function renderLoginForm(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Active Paw Partner Portal</title></head>
<body>
<h1>Partner login</h1>
<p>Enter the email address you applied with and we will send you a login link.</p>
<form method="post" action="/affiliate/portal/login">
  <p><label>Email address<br><input type="email" name="email" maxlength="254" required></label></p>
  <p><button type="submit">Send login link</button></p>
</form>
</body>
</html>`;
}

/** Live/scheduled/revoked display status: a 'live' voucher whose starts_at is
 *  still in the future reads as "scheduled" - the design spec's "deferred-
 *  start date" - without needing a fourth DB status value. */
function voucherDisplayStatus(v: { status: string; starts_at: string }, nowMs: number): string {
  if (v.status === 'live' && Date.parse(v.starts_at) > nowMs) return 'scheduled';
  return v.status;
}

function renderDashboard(summary: PartnerPortalSummary, nowMs: number): string {
  const rows = summary.vouchers.length
    ? summary.vouchers.map((v) =>
        `<tr><td>${escHtml(v.code)}</td><td>${escHtml(voucherDisplayStatus(v, nowMs))}</td>` +
        `<td>${escHtml(v.starts_at)}</td><td>${escHtml(v.ends_at)}</td></tr>`
      ).join('')
    : `<tr><td colspan="4">No codes issued yet.</td></tr>`;
  const lastOrder = summary.last_order_at ? escHtml(summary.last_order_at) : 'None yet';
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Active Paw Partner Portal</title></head>
<body>
<h1>Your Active Paw Partner dashboard</h1>
<table>
  <thead><tr><th>Code</th><th>Status</th><th>Starts</th><th>Ends</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p>Orders tracked: ${summary.orders_count}</p>
<p>Gross face value: ${money(summary.gross_gbp)}</p>
<p>Commission earned: ${money(summary.commission_gbp)}</p>
<p>Paid out: ${money(summary.paid_gbp)}</p>
<p>Pending: ${money(summary.pending_gbp)}</p>
<p>Last order: ${lastOrder}</p>
</body>
</html>`;
}

// --- POST /affiliate/portal/login -------------------------------------------

export interface PortalLoginDeps {
  store: TenantStore; cfg: TenantConfig | null; env: Env; email: string;
  fetchImpl?: typeof fetch; nowMs?: number;
}
export interface PortalLoginResult { status: number; html: string }

/**
 * Email -> if it resolves to a live partner, issue a 'login' claim token
 * (reusing apply.ts's issueLoginLink, so there is exactly one token
 * lifetime, one email template, one URL shape in the whole codebase) and
 * email a magic link. ALWAYS returns the exact same 200 body regardless of
 * whether the email matched a partner, was empty, or the D1/email call
 * threw - no-enumeration contract, identical to handleAffiliateApply's own.
 */
export async function handlePortalLogin(deps: PortalLoginDeps): Promise<PortalLoginResult> {
  const sc = deps.cfg?.selfServe ?? DEFAULT_SELF_SERVE;
  if (!sc.enabled) return { status: 200, html: PORTAL_DARK_HTML };

  const nowMs = deps.nowMs ?? Date.now();
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  try {
    const email = (deps.email ?? '').trim().toLowerCase();
    if (email) {
      const partnerId = await deps.store.partnerIdByEmail(email);
      if (partnerId) {
        await issueLoginLink(deps.store, deps.env, partnerId, '', email, fetchImpl, nowMs);
      }
    }
  } catch (e) {
    // Same uniformity rule as apply.ts: a D1/email hiccup must never read
    // differently from a normal "check your email" outcome - that would
    // itself be an enumeration/oracle leak.
    console.warn(`[affiliate-portal] login failed: ${(e as Error).message}`);
  }
  return { status: 200, html: GENERIC_LOGIN_HTML };
}

// --- GET /affiliate/portal ---------------------------------------------------

export interface PortalGetDeps {
  store: TenantStore; cfg: TenantConfig | null; secret: string;
  token?: string | null; sessionCookie?: string | null; nowMs?: number;
}
export interface PortalGetResult {
  status: number; html: string; setCookie?: string; redirect?: string; headers: Record<string, string>;
}

/**
 * Triple-duty GET, per the module doc comment above: `token` claims a login
 * link and mints the session cookie; otherwise a valid session cookie
 * renders the dashboard; otherwise the login form. `Referrer-Policy:
 * no-referrer` on every response - a URL that ever carried a token (or will
 * carry a Set-Cookie) must never leak via a browser's Referer header,
 * same posture as verify.ts.
 */
export async function handlePortalGet(deps: PortalGetDeps): Promise<PortalGetResult> {
  const headers: Record<string, string> = { 'Referrer-Policy': 'no-referrer' };
  const sc = deps.cfg?.selfServe ?? DEFAULT_SELF_SERVE;
  if (!sc.enabled) return { status: 200, html: PORTAL_DARK_HTML, headers };

  const nowMs = deps.nowMs ?? Date.now();
  const token = (deps.token ?? '').trim();

  if (token) {
    try {
      const tokenHash = await sha256Hex(token);
      const partnerId = await deps.store.claimToken(tokenHash, 'login');
      if (!partnerId) return { status: 200, html: SESSION_EXPIRED_HTML, headers };
      const cookieValue = await mintSessionCookieValue(partnerId, deps.secret, nowMs);
      // Consume the token, then redirect to the CLEAN url (no token in the
      // address bar) - safe here (unlike the App Proxy) because this is the
      // worker's own domain and a real redirect works.
      return { status: 302, html: '', redirect: SESSION_COOKIE_PATH, setCookie: cookieValue, headers };
    } catch (e) {
      console.warn(`[affiliate-portal] session claim failed: ${(e as Error).message}`);
      return { status: 200, html: SESSION_EXPIRED_HTML, headers };
    }
  }

  const partnerId = await verifySessionCookieValue(deps.sessionCookie, deps.secret, nowMs);
  if (!partnerId) return { status: 200, html: renderLoginForm(), headers };
  const summary = await deps.store.partnerPortalSummary(partnerId);
  return { status: 200, html: renderDashboard(summary, nowMs), headers };
}

// --- GET /affiliate/portal/data (optional JSON twin of the dashboard) ------

export interface PortalDataDeps {
  store: TenantStore; cfg: TenantConfig | null; secret: string; sessionCookie?: string | null; nowMs?: number;
}
export interface PortalDataResult {
  status: number;
  body: { ok: true; summary: PartnerPortalSummary } | { ok: false; error: string };
}

export async function handlePortalData(deps: PortalDataDeps): Promise<PortalDataResult> {
  const sc = deps.cfg?.selfServe ?? DEFAULT_SELF_SERVE;
  if (!sc.enabled) return { status: 200, body: { ok: false, error: 'The partner portal is not currently available.' } };
  const nowMs = deps.nowMs ?? Date.now();
  const partnerId = await verifySessionCookieValue(deps.sessionCookie, deps.secret, nowMs);
  if (!partnerId) return { status: 401, body: { ok: false, error: 'Not authenticated.' } };
  const summary = await deps.store.partnerPortalSummary(partnerId);
  return { status: 200, body: { ok: true, summary } };
}
