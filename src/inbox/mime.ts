import PostalMime from 'postal-mime';
import type { ParsedEmail, InboundAttachment } from './types';
import { sanitizeFilename } from './attachments';

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

/** One log line per message: each file part's declared type, disposition,
 * Content-ID, whether it sat in multipart/related, whether the HTML shows it
 * (cid:), and its size. Never a filename (sender-chosen, may be personal).
 * Added after the 2026-11-14 live test, where Gmail rebuilt the MIME in
 * transit and the delivered part headers could not be recovered. */
export function describeParts(p: Pick<ParsedEmail, 'attachments'>): string {
  return (p.attachments ?? []).map((a) => {
    const cid = bareCid(a.contentId);
    const cidOut = cid ? cid.replace(/[^\x21-\x7e]/g, '?').slice(0, 60) : '-';
    return `${a.contentType || '?'} disp=${a.disposition ?? '-'} cid=${cidOut} related=${a.related ? 1 : 0} shown=${a.shown ? 1 : 0} ${a.bytes.byteLength}B`;
  }).join('; ');
}

/** A Content-ID without its angle brackets. */
function bareCid(contentId: string | null | undefined): string {
  return (contentId ?? '').trim().replace(/^<|>$/g, '');
}

/** Every cid: the HTML refers to, percent-decoded and lower-cased (RFC 2392
 * allows encoding; senders vary the case). */
function cidRefsIn(html: string | null | undefined): Set<string> {
  const refs = new Set<string>();
  for (const m of (html ?? '').matchAll(/\bcid:([^"'\s)>]+)/gi)) {
    let ref = m[1];
    try { ref = decodeURIComponent(ref); } catch { /* a malformed escape stays as written */ }
    refs.add(ref.toLowerCase());
  }
  return refs;
}

/** Parse raw RFC822 bytes into a normalized ParsedEmail. Never throws on a
 * malformed body - returns best-effort fields (empty text rather than reject). */
export async function parseInbound(raw: ArrayBuffer | Uint8Array | string): Promise<ParsedEmail> {
  try {
    const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
    const headers = lowerHeaders(email.headers ?? []);
    // File parts (spec 2026-11-14 inbox attachments, 5.1). Judged and stored
    // later, at ingest; here they are only cut out of the MIME.
    const shownCids = cidRefsIn(email.html);
    const attachments: InboundAttachment[] = (email.attachments ?? []).map((a, i) => {
      const contentType = (a.mimeType ?? '').toLowerCase();
      const cid = bareCid(a.contentId).toLowerCase();
      const content = a.content;
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content)
        : content instanceof Uint8Array ? content : new Uint8Array(content);
      return {
        filename: sanitizeFilename(a.filename, contentType, i),
        contentType,
        disposition: a.disposition ?? null,
        contentId: a.contentId ?? null,
        related: !!a.related,
        shown: cid !== '' && shownCids.has(cid),
        bytes,
      };
    });
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
      headers,
      attachments
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
      headers: {},
      attachments: []
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
