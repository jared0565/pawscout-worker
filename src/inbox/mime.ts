import PostalMime from 'postal-mime';
import type { ParsedEmail } from './types';

// Shopify's contact-form notification sender + the address-shaped lines it carries.
const SHOPIFY_SENDER = /shopifyemail\.com|shopify\.com/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

function lowerHeaders(headers: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.key.toLowerCase()] = h.value;
  return out;
}

function splitRefs(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Parse raw RFC822 bytes into a normalized ParsedEmail. Never throws on a
 * malformed body — returns best-effort fields (empty text rather than reject). */
export async function parseInbound(raw: ArrayBuffer | Uint8Array | string): Promise<ParsedEmail> {
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
}

/** If `p` is a Shopify contact-form notification, pull out the real visitor.
 * Returns null for ordinary mail so the caller uses `p.from` directly. */
export function extractContactForm(
  p: ParsedEmail
): { email: string; name: string | null; phone: string | null; body: string } | null {
  const looksShopify = SHOPIFY_SENDER.test(p.from.email) ||
    /customer (message|enquiry|inquiry)|contact form|new message/i.test(p.subject);
  if (!looksShopify) return null;

  // Prefer the Reply-To (Shopify sets it to the visitor); fall back to the body.
  const replyTo = p.headers['reply-to'] ?? '';
  const replyEmail = replyTo.match(EMAIL_RE)?.[0]
    ?? p.text.match(/email[:\s]+([^\s]+@[^\s]+)/i)?.[1]
    ?? p.text.match(EMAIL_RE)?.[0]
    ?? null;
  if (!replyEmail) return null;

  const name = replyTo.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim()
    ?? p.text.match(/name[:\s]+(.+)/i)?.[1]?.trim()
    ?? null;
  const phone = p.text.match(/phone[:\s]+([+\d][\d\s()-]{5,})/i)?.[1]?.trim() ?? null;
  const body = p.text.match(/message[:\s]+([\s\S]+)$/i)?.[1]?.trim() ?? p.text;

  return { email: replyEmail.toLowerCase(), name, phone, body };
}
