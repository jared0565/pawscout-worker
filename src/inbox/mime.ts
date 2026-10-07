import PostalMime from 'postal-mime';
import type { ParsedEmail } from './types';

// Shopify's contact-form notification sender + the address-shaped lines it carries.
const SHOPIFY_SENDER = /@([\w-]+\.)*shopify(?:email)?\.com$/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

// The receiving server adds its Authentication-Results at the TOP, and
// postal-mime lists headers top first. Any copy further down arrived inside
// the message, so the sender wrote it: keep the first one, never the last.
const RECEIVER_FIRST = new Set(['authentication-results']);

function lowerHeaders(headers: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const key = h.key.toLowerCase();
    if (RECEIVER_FIRST.has(key) && key in out) continue;
    out[key] = h.value;
  }
  return out;
}

function splitRefs(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Parse raw RFC822 bytes into a normalized ParsedEmail. Never throws on a
 * malformed body - returns best-effort fields (empty text rather than reject). */
export async function parseInbound(raw: ArrayBuffer | Uint8Array | string): Promise<ParsedEmail> {
  try {
    const email = await PostalMime.parse(raw);
    const headers = lowerHeaders(email.headers ?? []);
    const fromAddr = email.from?.address ?? '';
    return {
      messageId: email.messageId ?? null,
      inReplyTo: email.inReplyTo ?? headers['in-reply-to'] ?? null,
      references: splitRefs(email.references ?? headers['references']),
      from: { email: fromAddr.toLowerCase(), name: email.from?.name || null },
      to: (email.to ?? []).map((a) => (a.address ?? '').toLowerCase()).filter(Boolean),
      subject: email.subject ?? '',
      date: email.date ? new Date(email.date).toISOString() : new Date().toISOString(),
      text: (email.text ?? '').trim(),
      html: email.html ?? null,
      headers
    };
  } catch (e) {
    console.warn(`inbound parse failed: ${(e as Error).message}`);
    return {
      messageId: null,
      inReplyTo: null,
      references: [],
      from: { email: '', name: null },
      to: [],
      subject: '',
      date: new Date().toISOString(),
      text: '',
      html: null,
      headers: {}
    };
  }
}

/** If `p` is a Shopify contact-form notification, pull out the real visitor.
 * Returns null for ordinary mail so the caller uses `p.from` directly. */
export function extractContactForm(
  p: ParsedEmail
): { email: string; name: string | null; phone: string | null; body: string; reason: string | null } | null {
  const looksShopify = SHOPIFY_SENDER.test(p.from.email) ||
    /customer (message|enquiry|inquiry)|contact form/i.test(p.subject);
  if (!looksShopify) return null;

  // Prefer the Reply-To (Shopify sets it to the visitor); fall back to the body.
  const replyTo = p.headers['reply-to'] ?? '';
  const replyEmail = replyTo.match(EMAIL_RE)?.[0]
    ?? p.text.match(/email[:\s]+([^\s]+@[^\s]+)/i)?.[1]
    ?? null;
  if (!replyEmail) return null;

  const name = replyTo.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim()
    ?? p.text.match(/name[:\s]+(.+)/i)?.[1]?.trim()
    ?? null;
  const phone = p.text.match(/phone[:\s]+([+\d][\d\s()-]{5,})/i)?.[1]?.trim() ?? null;
  const body = p.text.match(/message[:\s]+([\s\S]+)$/i)?.[1]?.trim() ?? p.text;

  // Phase 2: a self-declared intent from the contact-form "Reason" dropdown
  // (contact[Reason]). Shopify lists custom fields in the notification body as
  // "Reason: <token>". Anchor to a line start (deviates from spec §5's un-anchored
  // /reason[:\s]*([a-z_]+)/i) so the word "reason" inside the message body cannot be
  // mistaken for the field. Validate against the known token set; anything else
  // (incl. "general", empty, absent, or any unknown string) → null, which degrades to
  // exactly today's behaviour (no auto-routing) - never a regression.
  const DECLARED_INTENTS = new Set(['order', 'partnerships', 'wholesale']);
  const rawReason = (p.text.match(/^\s*reason\b[:\s]*([a-z_]+)/im)?.[1] ?? '').toLowerCase();
  const reason = DECLARED_INTENTS.has(rawReason) ? rawReason : null;

  return { email: replyEmail.toLowerCase(), name, phone, body, reason };
}
