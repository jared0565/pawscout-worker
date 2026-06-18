import { defaultFetch } from './safe-fetch';

// Transactional email via Resend (https://resend.com). The API key lives in the
// RESEND_API_KEY Worker secret — never logged, never sent anywhere but Resend.
// This is the send primitive W5 (marketing) and the awaiting-payment owner alert
// both build on.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Verified sending domain — all outbound mail uses @activepaw.co.uk.
// Set up DKIM + SPF in Resend before deploying (see docs/INBOX_OPS.md).
const DEFAULT_FROM = 'Active Paw <support@activepaw.co.uk>';

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
}

export type EmailResult = { ok: true; id: string } | { ok: false; error: string };

export async function sendEmail(apiKey: string, msg: EmailMessage, fetchImpl: typeof fetch = defaultFetch): Promise<EmailResult> {
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not configured' };
  if (!msg.html && !msg.text) return { ok: false, error: 'email needs html or text' };
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
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {})
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
  return id ? { ok: true, id } : { ok: false, error: 'Resend returned no id' };
}
