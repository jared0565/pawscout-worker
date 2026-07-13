// Stage 0 apply route: the PUBLIC, unauthenticated affiliate self-serve
// signup surface. Deterministic gates only - no LLM, no judging spend (see
// docs/superpowers/specs/2026-07-12-affiliate-self-serve-marketplace-design.md,
// "Stage 0"). Ships DARK behind cfg.selfServe.enabled (default false).
//
// This module exports a testable CORE (`handleAffiliateApply`,
// `renderApplyForm`) that takes its dependencies as plain arguments (store,
// cfg, env, fetchImpl) rather than a Hono Context. src/index.ts wires a thin
// adapter on top via proxyCtx(). The core is what tests/affiliate-apply.test.ts
// drives directly for the `selfServe.enabled=true` scenarios - cfg.selfServe
// has no DB persistence yet (a later task owns that; see src/types.ts), so
// there is no way to reach an enabled state through the real
// proxyCtx -> store.getConfig() path today. Two HTTP-level tests
// (app.request + a signed proxy signature) cover what the real, currently-dark
// wiring can exercise: a bad signature, and the enabled=false refusal.

import type { Env, TenantConfig } from '../types';
import { DEFAULT_SELF_SERVE } from '../types';
import {
  TenantStore, AFFILIATE_STAGE_SUBMITTED, AFFILIATE_STAGE_OWNER_QUEUE, AFFILIATE_STAGE_VERIFIED,
  AFFILIATE_STAGE_JUDGING, AFFILIATE_STAGE_APPROVED_PENDING_ISSUE
} from '../tenant-store';
import { defaultFetch } from '../safe-fetch';
import { sendEmail } from '../email';
import { sanitizeOutbound } from '../inbox/draft';
import { PARTNERSHIP_FROM } from '../inbox/partnership';
import {
  validEmailSyntax, isDisposableDomain, isMainstreamEmailDomain, channelHostAllowed,
  honeypotOk, signTimestamp, verifyTimestamp, validateFields, type ApplicationFieldsInput
} from './gates';

// --- Rate-limit + token-lifetime constants --------------------------------

const IP_DAILY_CAP = 5;
const DOMAIN_DAILY_CAP_DEFAULT = 8;
// Mainstream consumer providers (gmail.com etc.) share one domain across
// thousands of unrelated legitimate applicants - a much higher bucket so the
// domain counter can never DoS them (see gates.ts's isMainstreamEmailDomain).
const DOMAIN_DAILY_CAP_MAINSTREAM = 500;
// do not re-send a verify link more than once per 5 minutes. Exported so
// tests can compute a safely-past-cooldown offset without hardcoding a
// duplicate magic number.
export const RESEND_COOLDOWN_MS = 5 * 60 * 1000;
const VERIFY_TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48h, per the design spec's Stage 1
const LOGIN_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

const NON_TERMINAL_RESEND_STAGES: ReadonlySet<string> = new Set([
  AFFILIATE_STAGE_SUBMITTED, AFFILIATE_STAGE_VERIFIED, AFFILIATE_STAGE_JUDGING, AFFILIATE_STAGE_APPROVED_PENDING_ISSUE
]);

// --- Uniform (no-enumeration) response -------------------------------------

export const GENERIC_APPLY_MESSAGE = 'Thanks - check your email for next steps.';
const GENERIC_OK: ApplyResult = { status: 200, body: { ok: true, message: GENERIC_APPLY_MESSAGE } };

// --- Types ------------------------------------------------------------------

/** Raw form fields as submitted by the HTML <form> (all strings; a plain HTML
 *  form POST has no booleans/numbers). Field names match the GET-rendered form. */
export interface ApplyFields {
  name?: string;
  email?: string;
  channel_url?: string;
  audience?: string;
  plan?: string;
  terms?: string;   // 'on' when the checkbox is checked, absent otherwise
  website?: string; // honeypot - must stay empty
  ts?: string;       // signed form-render timestamp (gates.ts signTimestamp)
  'cf-turnstile-response'?: string; // injected by the Turnstile widget
}

export interface ApplyDeps {
  store: TenantStore;
  cfg: TenantConfig;
  env: Env;
  fields: ApplyFields;
  ip: string; // client IP (cf-connecting-ip); '' if unavailable
  nowMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ApplyResult {
  status: number;
  body: { ok: boolean; error?: string; message?: string };
}

// --- Small crypto/network helpers -------------------------------------------

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomTokenHex(): string {
  const bytes = new Uint8Array(32); // 256 bits, per the design spec's Stage 1
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MxResult { exists: boolean; failOpen: boolean }

/** MX existence via DNS-over-HTTPS (cloudflare-dns.com). Any network/parse
 *  failure, or a malformed response, FAILS OPEN (exists:true, failOpen:true) -
 *  a DoH outage must never block a legitimate applicant; the flag records
 *  that the check did not actually run so it can be reviewed later. */
export async function mxExists(domain: string, fetchImpl: typeof fetch = defaultFetch): Promise<MxResult> {
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`;
    const resp = await fetchImpl(url, { headers: { Accept: 'application/dns-json' } });
    if (!resp.ok) return { exists: true, failOpen: true };
    const data = (await resp.json()) as { Status?: number; Answer?: { type: number }[] };
    if (typeof data.Status !== 'number') return { exists: true, failOpen: true };
    const mxAnswers = (data.Answer ?? []).filter((a) => a.type === 15); // DNS type 15 = MX
    return { exists: mxAnswers.length > 0, failOpen: false };
  } catch {
    return { exists: true, failOpen: true };
  }
}

/** Server-side Cloudflare Turnstile verification. Never throws - a network
 *  failure here reads as "not verified" (reject), the safe direction for a
 *  bot gate (unlike mxExists, which fails open by design). */
export async function verifyTurnstile(
  token: string, secret: string, ip: string, fetchImpl: typeof fetch = defaultFetch
): Promise<boolean> {
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const resp = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

// --- Outbound email ----------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function buildVerifyEmail(name: string, url: string): { subject: string; html: string; text: string } {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const subject = 'Verify your email to continue your Active Paw Partner application';
  const text = `${greeting}\n\nThanks for applying to the Active Paw Partner Program. Click the link below within 48 hours to verify your email and continue your application.\n\n${url}\n\nIf you did not request this, you can safely ignore this email.\n\n- Active Paw Partnerships`;
  const html = `<p>${escHtml(greeting)}</p><p>Thanks for applying to the Active Paw Partner Program. Click below within 48 hours to verify your email and continue your application.</p><p><a href="${url}">Verify your email</a></p><p>If you did not request this, you can safely ignore this email.</p><p>- Active Paw Partnerships</p>`;
  return { subject, html, text };
}

function buildLoginEmail(name: string, url: string): { subject: string; html: string; text: string } {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const subject = 'Log in to your Active Paw Partner dashboard';
  const text = `${greeting}\n\nYou already have an Active Paw Partner account. Click the link below within 48 hours to log in to your dashboard.\n\n${url}\n\nIf you did not request this, you can safely ignore this email.\n\n- Active Paw Partnerships`;
  const html = `<p>${escHtml(greeting)}</p><p>You already have an Active Paw Partner account. Click below within 48 hours to log in to your dashboard.</p><p><a href="${url}">Log in</a></p><p>If you did not request this, you can safely ignore this email.</p><p>- Active Paw Partnerships</p>`;
  return { subject, html, text };
}

/** Every applicant-facing send bypasses the inbox pipeline, so this is the
 *  ONE call site: sanitizeOutbound on every field, From/Reply-To =
 *  PARTNERSHIP_FROM (so a reply routes into isPartnershipLane). */
async function sendApplicantEmail(
  env: Env, email: string, msg: { subject: string; html: string; text: string }, fetchImpl: typeof fetch
): Promise<void> {
  const result = await sendEmail(env.RESEND_API_KEY ?? '', {
    to: email,
    subject: sanitizeOutbound(msg.subject),
    html: sanitizeOutbound(msg.html),
    text: sanitizeOutbound(msg.text),
    from: PARTNERSHIP_FROM,
    replyTo: PARTNERSHIP_FROM
  }, fetchImpl);
  if (!result.ok) console.warn(`[affiliate-apply] outbound email failed: ${result.error}`);
}

async function issueVerifyLink(
  store: TenantStore, env: Env, applicationId: string, name: string, email: string, fetchImpl: typeof fetch, nowMs: number
): Promise<void> {
  const raw = randomTokenHex();
  const tokenHash = await sha256Hex(raw);
  await store.insertToken({ tokenHash, kind: 'verify', subjectId: applicationId, expiresAt: new Date(nowMs + VERIFY_TOKEN_TTL_MS).toISOString() });
  const url = `${env.SHOPIFY_APP_URL}/affiliate/verify?token=${raw}`;
  await sendApplicantEmail(env, email, buildVerifyEmail(name, url), fetchImpl);
}

/** Exported so src/affiliate/portal.ts's `POST /affiliate/portal/login` (Task 5)
 *  can issue the exact same 'login' token + magic-link email as the
 *  "existing live partner tries to re-apply" branch above - one token
 *  lifetime, one email template, one URL shape
 *  (`${SHOPIFY_APP_URL}/affiliate/portal?token=...`), never duplicated. */
export async function issueLoginLink(
  store: TenantStore, env: Env, partnerId: string, name: string, email: string, fetchImpl: typeof fetch, nowMs: number
): Promise<void> {
  const raw = randomTokenHex();
  const tokenHash = await sha256Hex(raw);
  await store.insertToken({ tokenHash, kind: 'login', subjectId: partnerId, expiresAt: new Date(nowMs + LOGIN_TOKEN_TTL_MS).toISOString() });
  const url = `${env.SHOPIFY_APP_URL}/affiliate/portal?token=${raw}`;
  await sendApplicantEmail(env, email, buildLoginEmail(name, url), fetchImpl);
}

// --- The core handler ---------------------------------------------------------

/**
 * Stage 0: validate, gate, dedupe, rate-limit, then admit a new application.
 * Gate order: Turnstile -> honeypot/timestamp -> field validation -> email
 * gates -> channel FORMAT gate -> former-partner -> dedupe by email
 * (uniform response) -> channel-REGISTERED DB check (new applicant only) ->
 * rate-limit (uniform response) -> insert + issue verify token + send one
 * email. The channel-registered DB check runs AFTER the email-keyed dedupe
 * decision, not alongside the other channel gates: `channelUrlRegistered`
 * matches a submitter's OWN prior application/partner row too (loose
 * substring dedupe, see tenant-store.ts), so a real applicant retrying with
 * the same email AND the same channel_url must be identified by email FIRST
 * or the mid-application/live-partner branches below are unreachable, always
 * shadowed by a "channel already linked" rejection against themselves. Every
 * branch that depends on whether this email has any account/application
 * history returns the exact same `GENERIC_OK` body (live partner,
 * mid-application, new applicant, former partner, and over-rate-limit) so
 * the endpoint is never an enumeration oracle - only the emailed content
 * differs.
 */
export async function handleAffiliateApply(deps: ApplyDeps): Promise<ApplyResult> {
  const { store, cfg, env } = deps;
  const nowMs = deps.nowMs ?? Date.now();
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const fields = deps.fields ?? {};
  const sc = cfg.selfServe ?? DEFAULT_SELF_SERVE;

  // Everything ships dark behind cfg.selfServe.enabled.
  if (!sc.enabled) {
    return { status: 200, body: { ok: false, error: 'Applications are not currently open.' } };
  }

  // 1. Turnstile - MANDATORY once enabled. A missing secret hard-fails (never
  //    silently skips the bot gate); this is an owner-alert-worthy misconfig.
  if (!env.TURNSTILE_SECRET) {
    console.error(
      `[affiliate-apply] TURNSTILE_SECRET is unset while selfServe.enabled=true for ${store.shop} - ` +
      `hard-failing the apply route (owner action required to restore self-serve signups)`
    );
    return { status: 200, body: { ok: false, error: 'Applications are temporarily unavailable. Please try again later.' } };
  }
  const turnstileOk = await verifyTurnstile(fields['cf-turnstile-response'] ?? '', env.TURNSTILE_SECRET, deps.ip, fetchImpl);
  if (!turnstileOk) {
    return { status: 200, body: { ok: false, error: 'We could not verify you are human. Please try again.' } };
  }

  // 2. Honeypot + signed min-time-to-submit. Both failure modes are SILENT -
  //    the bot sees the exact same body a real success would return.
  const formRenderedAtMs = await verifyTimestamp(fields.ts ?? '', env.SHOPIFY_API_SECRET, nowMs);
  if (formRenderedAtMs === null || !honeypotOk({ honeypot: fields.website, formRenderedAtMs }, nowMs)) {
    return GENERIC_OK;
  }

  // 3. Field validation (required + length caps).
  const termsAccepted = fields.terms === 'on' || fields.terms === 'true' || fields.terms === '1';
  const fieldsIn: ApplicationFieldsInput = {
    name: fields.name, email: fields.email, channelUrl: fields.channel_url,
    audience: fields.audience, plan: fields.plan, termsAccepted
  };
  const fv = validateFields(fieldsIn);
  if (!fv.ok) return { status: 200, body: { ok: false, error: `Please check the ${fv.reason} field.` } };

  const name = fields.name!.trim();
  const email = fields.email!.trim().toLowerCase();
  const channelUrlRaw = fields.channel_url!.trim();

  // 4. Email gates: syntax, disposable-domain blocklist, MX (fail-open).
  if (!validEmailSyntax(email)) return { status: 200, body: { ok: false, error: 'Please enter a valid email address.' } };
  const emailDomain = email.split('@')[1] ?? '';
  if (isDisposableDomain(emailDomain)) return { status: 200, body: { ok: false, error: 'Please use a permanent email address.' } };
  const mx = await mxExists(emailDomain, fetchImpl);
  if (!mx.exists && !mx.failOpen) return { status: 200, body: { ok: false, error: 'Please enter a valid email address.' } };
  const dohFailOpen = mx.failOpen;

  // 5. Channel URL FORMAT gate only: http(s)+parseable, not coupon/deal/
  //    cashback, not an activepaw domain. The DB "already registered to
  //    someone else" check is deliberately NOT run here - see step 8.
  const ch = channelHostAllowed(channelUrlRaw);
  if (!ch.ok || !ch.host) return { status: 200, body: { ok: false, error: 'Please enter a valid channel URL.' } };

  const ipHash = deps.ip ? await sha256Hex(deps.ip) : null;
  const answersJson = JSON.stringify({ audience: fields.audience!.trim(), plan: fields.plan!.trim() });
  const flagsJson = JSON.stringify(dohFailOpen ? { doh_failopen: true } : {});

  // 6. Former-partner gate: NEVER auto-approve later - route straight to
  //    owner_queue regardless of anything else. Uniform response. Skips a
  //    second owner_queue insert if one is already pending for this email
  //    (a repeat submission from a former partner shouldn't flood the queue).
  const poolState = await store.partnerPoolState(email);
  if (poolState === 'former') {
    const pendingQueue = await store.applicationByEmail(email);
    if (!pendingQueue || pendingQueue.stage !== AFFILIATE_STAGE_OWNER_QUEUE) {
      await store.insertApplication({ email, name, channelUrl: channelUrlRaw, answersJson, stage: AFFILIATE_STAGE_OWNER_QUEUE, flagsJson, ipHash });
    }
    return GENERIC_OK;
  }

  // 7. Dedupe: live partner / mid-application / new applicant. This MUST run
  //    before any channel-registered lookup (step 8) - a real applicant's
  //    retry submits the SAME email AND the SAME channel_url, and
  //    channelUrlRegistered() matches their own prior application/partner
  //    row, so deciding identity by email FIRST is the only way the
  //    mid-application resend path (and the live-partner login path) is ever
  //    reachable rather than dead code shadowed by "channel already linked".
  //    The first two branches short-circuit here with the SAME uniform
  //    response; only the emailed content differs (login link vs resend vs
  //    new-application verify link).
  if (poolState === 'live') {
    const partnerId = await store.partnerIdByEmail(email);
    if (partnerId) await issueLoginLink(store, env, partnerId, name, email, fetchImpl, nowMs);
    return GENERIC_OK;
  }

  const existing = await store.applicationByEmail(email);
  if (existing) {
    if (existing.stage === AFFILIATE_STAGE_OWNER_QUEUE) {
      return GENERIC_OK; // already pending mandatory human review - no new token, no new email
    }
    if (NON_TERMINAL_RESEND_STAGES.has(existing.stage)) {
      const lastUpdateMs = Date.parse(existing.updated_at);
      if (!Number.isFinite(lastUpdateMs) || nowMs - lastUpdateMs >= RESEND_COOLDOWN_MS) {
        await issueVerifyLink(store, env, existing.id, name, email, fetchImpl, nowMs);
      }
      return GENERIC_OK;
    }
    // Terminal (approved/declined/deflected) - fall through and treat this as
    // a brand new application (their circumstances may have changed).
  }

  // 8. Channel-registered DB check - ONLY reached for a genuinely new
  //    applicant (no former/live/in-flight record under their own email), so
  //    a hit here means the channel belongs to SOMEONE ELSE. This branch is
  //    also reached via the terminal-stage fallthrough (step 7's "approved/
  //    declined/deflected -> treat as new" comment) - excludeEmail=email
  //    keeps that path from matching the submitter's OWN prior terminal row
  //    (which would otherwise leak a distinguishable "already linked" body,
  //    an enumeration oracle - see tenant-store.ts's channelUrlRegistered doc).
  if (await store.channelUrlRegistered(ch.host, email)) {
    return { status: 200, body: { ok: false, error: 'This channel is already linked to another application.' } };
  }

  // 9. Rate limits (new-applicant path only - the expensive, abusable action).
  //    Mainstream providers get a much higher domain bucket (gates.ts).
  const sinceIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  if (ipHash) {
    const ipCount = await store.countApplicationsToday(sinceIso, { ipHash });
    if (ipCount >= IP_DAILY_CAP) return GENERIC_OK;
  }
  const domainCap = isMainstreamEmailDomain(emailDomain) ? DOMAIN_DAILY_CAP_MAINSTREAM : DOMAIN_DAILY_CAP_DEFAULT;
  const domainCount = await store.countApplicationsToday(sinceIso, { emailDomain });
  if (domainCount >= domainCap) return GENERIC_OK;

  // 10. New applicant: insert (stage submitted), issue a verify token, send one email.
  const applicationId = await store.insertApplication({
    email, name, channelUrl: channelUrlRaw, answersJson, stage: AFFILIATE_STAGE_SUBMITTED, flagsJson, ipHash
  });
  await issueVerifyLink(store, env, applicationId, name, email, fetchImpl, nowMs);
  return GENERIC_OK;
}

// --- GET: the worker-rendered apply form -------------------------------------

/** Worker-rendered HTML string (no build step, no framework) - the Turnstile
 *  widget, honeypot field, and signed timestamp all live here. Always 200 -
 *  Shopify's App Proxy replaces any non-2xx response with a generic error page. */
export async function renderApplyForm(cfg: TenantConfig, env: Env, nowMs: number = Date.now()): Promise<string> {
  const sc = cfg.selfServe ?? DEFAULT_SELF_SERVE;
  if (!sc.enabled) {
    return (
      `<!doctype html><html><head><meta charset="utf-8"><title>Active Paw Partner Program</title></head>` +
      `<body><p>Applications are not currently open. Please check back soon.</p></body></html>`
    );
  }
  const tsToken = await signTimestamp(nowMs, env.SHOPIFY_API_SECRET);
  const siteKey = env.TURNSTILE_SITE_KEY ?? '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Active Paw Partner Program</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</head>
<body>
<h1>Join the Active Paw Partner Program</h1>
<p>Tell us about your channel and how you would promote Active Paw. We review every application automatically, then by email.</p>
<form method="post">
  <p><label>Your name<br><input type="text" name="name" maxlength="120" required></label></p>
  <p><label>Email address<br><input type="email" name="email" maxlength="254" required></label></p>
  <p><label>Channel URL (blog, YouTube, Instagram, etc.)<br><input type="url" name="channel_url" maxlength="500" required></label></p>
  <p><label>Tell us about your audience<br><textarea name="audience" maxlength="2000" required></textarea></label></p>
  <p><label>How would you promote Active Paw?<br><textarea name="plan" maxlength="2000" required></textarea></label></p>
  <p><label><input type="checkbox" name="terms" required> I agree to the Active Paw Partner Program terms.</label></p>
  <div style="position:absolute;left:-9999px" aria-hidden="true">
    <label>Leave this field blank<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
  </div>
  <input type="hidden" name="ts" value="${escHtml(tsToken)}">
  <div class="cf-turnstile" data-sitekey="${escHtml(siteKey)}"></div>
  <p><button type="submit">Apply</button></p>
</form>
</body>
</html>`;
}
