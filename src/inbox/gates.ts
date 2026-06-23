import type { ParsedEmail } from './types';
import { stripQuotedReply } from './quote';

export interface AuthResults {
  spf: 'pass' | 'fail' | 'none';
  dkim: 'pass' | 'fail' | 'none';
  dmarc: 'pass' | 'fail' | 'none';
}

function verdict(blob: string, key: string): 'pass' | 'fail' | 'none' {
  const m = blob.match(new RegExp(`(?<![\\w-])${key}(?![\\w-])=(\\w+)`, 'i'));
  if (!m) return 'none';
  const v = m[1].toLowerCase();
  return v === 'pass' ? 'pass' : v === 'fail' || v === 'softfail' ? 'fail' : 'none';
}

/** Read SPF/DKIM/DMARC out of the Authentication-Results header Email Routing adds. */
export function parseAuthResults(headers: Record<string, string>): AuthResults {
  const blob = headers['authentication-results'] ?? '';
  return { spf: verdict(blob, 'spf'), dkim: verdict(blob, 'dkim'), dmarc: verdict(blob, 'dmarc') };
}

/** Auto-responders, bulk/list mail, and no-reply senders: store + label, never reply/alert. */
export function isAutomated(p: ParsedEmail): boolean {
  const h = p.headers;
  if (/^auto-/i.test((h['auto-submitted'] ?? '').trim())) return true;
  if (/\b(bulk|list|junk)\b/i.test(h['precedence'] ?? '')) return true;
  if (h['list-unsubscribe'] || h['list-id']) return true;
  if (/no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|bounce/i.test(p.from.email)) return true;
  return false;
}

/** Hard spam signal: DMARC failure means the sender domain is likely spoofed. */
export function isHardSpam(auth: AuthResults): boolean {
  return auth.dmarc === 'fail';
}

/** True when an inbound carries nothing to action: no readable text once the quoted
 * reply chain is stripped, no meaningful HTML text, and no attachment. There is no
 * point drafting a reply to an empty email, and the owner should not have to triage it.
 *
 * Conservative by design - ANY letter or digit in the customer's new text or in the
 * HTML body, or ANY attachment, makes it NOT blank. So a real inquiry is never hidden,
 * including an attachment-only "my order arrived damaged" photo with no typed text. We
 * would rather show a near-empty email than bury a genuine one. */
export function isContentless(
  bodyText: string | null | undefined,
  html: string | null | undefined,
  hasAttachments: boolean
): boolean {
  if (hasAttachments) return false;
  const fromText = stripQuotedReply(bodyText ?? '');
  const htmlPlain = (html ?? '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ');
  const fromHtml = stripQuotedReply(htmlPlain);
  return !/[\p{L}\p{N}]/u.test(`${fromText} ${fromHtml}`);
}

/** Re:/Fwd:/AW:/SV: prefix-stripped, lowercased subject for thread matching. */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|sv)\s*:\s*)+/i, '').trim().toLowerCase().slice(0, 200);
}
