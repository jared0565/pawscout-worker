import { defaultFetch } from './safe-fetch';

// Transactional email via Resend (https://resend.com). The API key lives in the
// RESEND_API_KEY Worker secret - never logged, never sent anywhere but Resend.
// This is the send primitive W5 (marketing) and the awaiting-payment owner alert
// both build on.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Verified sending domain - all outbound mail uses @activepaw.co.uk.
// Set up DKIM + SPF in Resend before deploying (see docs/INBOX_OPS.md).
export const SENDING_DOMAIN = 'activepaw.co.uk';
const DEFAULT_FROM = `Active Paw <support@${SENDING_DOMAIN}>`;

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  messageId?: string;
  headers?: Record<string, string>;
  /** Send-time labels echoed back inside every Resend webhook event - how an
   * opened/clicked event finds its campaign or inbox thread again. */
  tags?: { name: string; value: string }[];
}

/** Resend tags allow only ASCII letters, digits, underscores and dashes (both
 * name and value); anything else fails the whole send. Coerce instead. */
export function sanitizeTag(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
}

export type EmailResult = { ok: true; id: string; messageId: string } | { ok: false; error: string };

export async function sendEmail(apiKey: string, msg: EmailMessage, fetchImpl: typeof fetch = defaultFetch): Promise<EmailResult> {
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not configured' };
  if (!msg.html && !msg.text) return { ok: false, error: 'email needs html or text' };
  const messageId = msg.messageId ?? `<inbox-${crypto.randomUUID()}@activepaw.co.uk>`;
  let resp: Response;
  try {
    resp = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: msg.from ?? DEFAULT_FROM,
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.text ? { text: msg.text } : {}),
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        ...(msg.tags?.length ? { tags: msg.tags.map((t) => ({ name: sanitizeTag(t.name), value: sanitizeTag(t.value) })) } : {}),
        headers: { 'Message-ID': messageId, ...(msg.headers ?? {}) }
      })
    });
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  let body: unknown = null;
  try { body = await resp.json(); } catch { /* body may be empty */ }
  if (!resp.ok) {
    const b = (body ?? {}) as { message?: string; name?: string };
    return { ok: false, error: `Resend ${resp.status}: ${b.message ?? b.name ?? 'send failed'}` };
  }
  const id = String((body as { id?: string } | null)?.id ?? '');
  return id ? { ok: true, id, messageId } : { ok: false, error: 'Resend returned no id' };
}
