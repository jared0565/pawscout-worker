// A reply that adds no new words (design 2026-11-19, 1c). On the 2026-11-19
// export, 30 inbound messages were nothing but a greeting, the store name or
// punctuation above our quoted email ("Hi active paw", "?", "Hello 👋"), and
// 20 of them came after we had already answered; we still drafted on many.
// The filler list is a CLOSED allowlist: any other word counts as content, so
// in doubt we draft ("Are you there?" is content; "Hello?" is not). A number
// is a word too: "#1043" answers our own "could you share your order number?"
// (final review, 2026-11-20). A message that carries a file, or whose HTML
// shows an inline image, is always content, whatever its text.
import { stripQuotedReply } from './quote';
import { normalizeSubject } from './gates';
import { HTML_INPUT_MAX_CHARS } from './html-text';

const FILLER: ReadonlySet<string> = new Set([
  'hi', 'hello', 'hey', 'hiya', 'dear', 'good', 'morning', 'afternoon', 'evening',
  'there', 'team', 'sir', 'madam', 'all', 'buddy', 'friend', 'h',
]);

/** True when the sender's own text has no word beyond a greeting, the store
 * name, a mobile signature line, punctuation or emoji. Digits are words. */
export function hasNoNewWords(ownText: string): boolean {
  const t = ownText
    .replace(/^\s*(?:sent from my|get outlook for)\b.*$/gim, ' ')
    .toLowerCase()
    .replace(/active\s*paw/g, ' ');
  const words = t.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.every((w) => FILLER.has(w));
}

// The same Gmail / Apple Mail attribution stripQuotedReply cuts at.
const GMAIL_ATTRIBUTION = /(?:^|\n)\s*On\s[\s\S]{0,300}?\bwrote:\s*(?:\n|$)/i;

/** The sender's own text, for this check only. stripQuotedReply cuts at a
 * Gmail attribution and drops everything after it, so an answer written BELOW
 * the quote ("Large please") or between quoted lines would read as no words.
 * Gmail prefixes every quoted line with ">", so the unprefixed lines after the
 * attribution are the sender's. Only for that attribution: an Outlook quote is
 * unprefixed, and its lines must not count as theirs. */
function ownText(body: string): string {
  const head = stripQuotedReply(body);
  const t = body.replace(/\r\n/g, '\n');
  const m = t.match(GMAIL_ATTRIBUTION);
  if (!m || m.index === undefined) return head;
  const below = t.slice(m.index + m[0].length).split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
  return `${head}\n${below}`;
}

/** True when the HTML shows an inline (cid:) image. A small pasted photo is
 * dropped at ingest like a signature logo, leaving no attachment row, so the
 * HTML is the only evidence the sender sent a picture. In doubt, we draft. */
function showsInlineImage(html: string | null | undefined): boolean {
  return !!html && /\bsrc\s*=\s*["']?\s*cid:/i.test(html.slice(0, HTML_INPUT_MAX_CHARS));
}

/** True when every inbound since our last reply adds no new words and carries
 * no file. With no reply from us yet, the subject's words count as content. A
 * thread whose last message is ours has nothing open, so it is never a bump. */
export function openBatchHasNoNewWords(
  messages: ReadonlyArray<{ id: string; direction: string; body_text: string | null; body_html?: string | null }>,
  subject: string | null,
  fileMessageIds: ReadonlySet<string> = new Set()
): boolean {
  let lastOutbound = -1;
  messages.forEach((m, i) => { if (m.direction === 'outbound') lastOutbound = i; });
  const open = messages.slice(lastOutbound + 1).filter((m) => m.direction === 'inbound');
  if (!open.length) return false;
  if (open.some((m) => fileMessageIds.has(m.id) || showsInlineImage(m.body_html))) return false;
  if (!open.every((m) => hasNoNewWords(ownText(m.body_text ?? '')))) return false;
  if (lastOutbound >= 0) return true;
  return hasNoNewWords(normalizeSubject(subject ?? ''));
}
