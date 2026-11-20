import { isNewsletterShaped } from './html-text';
import type { ParsedEmail } from './types';

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
  // A formatted-only platform newsletter carries no list headers (the 19
  // TikTok Shop mails on the 2026-11-19 export had none). Once its HTML is
  // read, the classifier could take it for a person, so its shape decides
  // (design 2026-11-19, 1a). Only formatted-only mail is judged this way.
  if (p.textFromHtml && p.html && isNewsletterShaped(p.html)) return true;
  return false;
}

/** Hard spam signal: DMARC failure means the sender domain is likely spoofed. */
export function isHardSpam(auth: AuthResults): boolean {
  return auth.dmarc === 'fail';
}

/** Re:/Fwd:/AW:/SV: prefix-stripped, lowercased subject for thread matching. */
export function normalizeSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|sv)\s*:\s*)+/i, '').trim().toLowerCase().slice(0, 200);
}
