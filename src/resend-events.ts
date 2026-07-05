import type { TenantStore } from './tenant-store';
import { defaultFetch } from './safe-fetch';

// Email engagement events (2026-07-05): Resend signs webhook deliveries with
// svix (HMAC-SHA256 over "id.timestamp.body", key = base64 payload of the
// whsec_ secret). We verify manually with WebCrypto - no dependency - then
// store the event and feed hard bounces + spam complaints straight into the
// suppression list, so a bad address is never mailed again.

export const RESEND_API = 'https://api.resend.com';

/** The events we subscribe to. email.sent is deliberately excluded - our own
 * send ledger already records every send; webhook rows would be duplicates. */
export const RESEND_EVENT_TYPES = [
  'email.delivered', 'email.opened', 'email.clicked', 'email.bounced', 'email.complained'
] as const;

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Constant-time string equality (both sides base64 of equal-length MACs). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a svix-signed webhook delivery. Headers come off the request as
 * svix-id / svix-timestamp / svix-signature; body must be the RAW request text
 * (any re-serialisation breaks the MAC). Rejects stale timestamps (replay).
 */
export async function verifySvixSignature(
  secret: string,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  rawBody: string,
  nowMs = Date.now()
): Promise<boolean> {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;
  let keyBytes: Uint8Array;
  try {
    keyBytes = b64ToBytes(secret.startsWith('whsec_') ? secret.slice(6) : secret);
  } catch { return false; }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // Header carries space-separated versioned signatures ("v1,<b64> v1,<b64>").
  for (const part of headers.signature.split(' ')) {
    const [version, sig] = part.split(',');
    if (version === 'v1' && sig && timingSafeEqual(sig, expected)) return true;
  }
  return false;
}

export interface ResendEvent {
  type: string;            // "delivered" | "opened" | "clicked" | "bounced" | "complained" | ...
  resendId: string;
  email: string;           // first recipient, lowercase
  occurredAt: string;
  kind: string | null;     // send-time tag
  campaignId: string | null;
  threadId: string | null;
  link: string | null;     // clicked URL
  permanentBounce: boolean;
}

/** Extract what we store from a verified webhook payload. Null = not an email
 * event we track (unknown type, or no recipient). */
export function parseResendEvent(payload: unknown): ResendEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> };
  if (typeof p.type !== 'string' || !p.type.startsWith('email.')) return null;
  const data = (p.data ?? {}) as {
    email_id?: unknown; to?: unknown; tags?: Record<string, unknown>;
    click?: { link?: unknown }; bounce?: { type?: unknown };
  };
  const resendId = typeof data.email_id === 'string' ? data.email_id : '';
  const to = Array.isArray(data.to) && typeof data.to[0] === 'string' ? data.to[0].trim().toLowerCase() : '';
  if (!resendId || !to) return null;
  const tags = data.tags ?? {};
  const tag = (name: string): string | null => (typeof tags[name] === 'string' && tags[name] ? String(tags[name]) : null);
  return {
    type: p.type.slice('email.'.length),
    resendId,
    email: to,
    occurredAt: typeof p.created_at === 'string' ? p.created_at : new Date().toISOString(),
    kind: tag('kind'),
    campaignId: tag('campaign_id'),
    threadId: tag('thread_id'),
    link: typeof data.click?.link === 'string' ? data.click.link : null,
    permanentBounce: p.type === 'email.bounced' && data.bounce?.type === 'Permanent'
  };
}

/**
 * Store one verified event (svix-id dedups Resend's redeliveries) and apply
 * the deliverability rule: a spam complaint or a PERMANENT bounce puts the
 * address on the shared suppression list - campaigns and reorder reminders
 * skip it from then on. Transactional replies are unaffected (suppression is
 * only consulted on the marketing paths).
 */
export async function applyResendEvent(
  store: TenantStore, svixId: string, event: ResendEvent, nowIso = new Date().toISOString()
): Promise<{ stored: boolean; suppressed: boolean }> {
  const stored = await store.insertEmailEvent({
    svixId, resendId: event.resendId, email: event.email, eventType: event.type,
    kind: event.kind, campaignId: event.campaignId, threadId: event.threadId,
    link: event.link, occurredAt: event.occurredAt
  }, nowIso);
  const suppress = event.type === 'complained' || event.permanentBounce;
  if (suppress) await store.recordUnsubscribe(event.email, nowIso);
  return { stored, suppressed: suppress };
}

// --- Resend management API (worker-side setup; the key never leaves the worker) ---

export interface TrackingStatus {
  domainId: string | null;
  openTracking: boolean;
  clickTracking: boolean;
}

async function resendApi(
  apiKey: string, method: string, path: string, body: unknown, fetchImpl: typeof fetch
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  let resp: Response;
  try {
    resp = await fetchImpl(`${RESEND_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  let data: unknown = null;
  try { data = await resp.json(); } catch { /* some endpoints return empty bodies */ }
  if (!resp.ok) {
    const b = (data ?? {}) as { message?: string; name?: string };
    return { ok: false, error: `Resend ${resp.status}: ${b.message ?? b.name ?? 'request failed'}` };
  }
  return { ok: true, data };
}

/** Whether open/click tracking is on for the sending domain. */
export async function getTrackingStatus(
  apiKey: string, domainName: string, fetchImpl: typeof fetch = defaultFetch
): Promise<{ ok: true; status: TrackingStatus } | { ok: false; error: string }> {
  const list = await resendApi(apiKey, 'GET', '/domains', undefined, fetchImpl);
  if (!list.ok) return list;
  const domains = ((list.data as { data?: { id?: string; name?: string }[] })?.data ?? []);
  const match = domains.find((d) => d.name === domainName);
  if (!match?.id) return { ok: true, status: { domainId: null, openTracking: false, clickTracking: false } };
  const got = await resendApi(apiKey, 'GET', `/domains/${match.id}`, undefined, fetchImpl);
  if (!got.ok) return got;
  const d = got.data as { open_tracking?: boolean; click_tracking?: boolean };
  return { ok: true, status: { domainId: match.id, openTracking: d.open_tracking === true, clickTracking: d.click_tracking === true } };
}

/** Flip open + click tracking on for the domain. Idempotent. */
export async function enableTracking(
  apiKey: string, domainId: string, fetchImpl: typeof fetch = defaultFetch
): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await resendApi(apiKey, 'PATCH', `/domains/${domainId}`, { open_tracking: true, click_tracking: true }, fetchImpl);
  return r.ok ? { ok: true } : r;
}

/**
 * Find-or-create the events webhook pointing at our endpoint. The signing
 * secret is only returned by CREATE, so if a webhook for this endpoint already
 * exists we report that instead of minting a duplicate (secret already stored
 * from the original run, or the owner re-creates it after deleting).
 */
export async function ensureEventsWebhook(
  apiKey: string, endpointUrl: string, fetchImpl: typeof fetch = defaultFetch
): Promise<{ ok: true; created: boolean; signingSecret: string | null } | { ok: false; error: string }> {
  const list = await resendApi(apiKey, 'GET', '/webhooks', undefined, fetchImpl);
  if (list.ok) {
    const hooks = ((list.data as { data?: { endpoint?: string }[] })?.data ?? []);
    if (hooks.some((w) => w.endpoint === endpointUrl)) return { ok: true, created: false, signingSecret: null };
  }
  // List endpoint unavailable or no match: create.
  const created = await resendApi(apiKey, 'POST', '/webhooks', { endpoint: endpointUrl, events: RESEND_EVENT_TYPES }, fetchImpl);
  if (!created.ok) return created;
  const c = created.data as { signing_secret?: string };
  if (!c.signing_secret) return { ok: false, error: 'Resend created the webhook but returned no signing secret' };
  return { ok: true, created: true, signingSecret: c.signing_secret };
}
