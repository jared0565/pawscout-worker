// A reply that adds no new words (design 2026-11-19, 1c). On the 2026-11-19
// export, 30 inbound messages were nothing but a greeting, the store name or
// punctuation above our quoted email ("Hi active paw", "?", "Hello 👋"), and
// 20 of them came after we had already answered; we still drafted on many.
// The filler list is a CLOSED allowlist: any other word counts as content, so
// in doubt we draft ("Are you there?" is content; "Hello?" is not). A message
// that carries a file is always content, whatever its text.
import { stripQuotedReply } from './quote';
import { normalizeSubject } from './gates';

const FILLER: ReadonlySet<string> = new Set([
  'hi', 'hello', 'hey', 'hiya', 'dear', 'good', 'morning', 'afternoon', 'evening',
  'there', 'team', 'sir', 'madam', 'all', 'buddy', 'friend', 'h',
]);

/** True when the sender's own text has no word beyond a greeting, the store
 * name, a mobile signature line, punctuation or emoji. */
export function hasNoNewWords(ownText: string): boolean {
  const t = ownText
    .replace(/^\s*(?:sent from my|get outlook for)\b.*$/gim, ' ')
    .toLowerCase()
    .replace(/active\s*paw/g, ' ');
  const words = t.match(/\p{L}+/gu) ?? [];
  return words.every((w) => FILLER.has(w));
}

/** True when every inbound since our last reply adds no new words and carries
 * no file. With no reply from us yet, the subject's words count as content. A
 * thread whose last message is ours has nothing open, so it is never a bump. */
export function openBatchHasNoNewWords(
  messages: ReadonlyArray<{ id: string; direction: string; body_text: string | null }>,
  subject: string | null,
  fileMessageIds: ReadonlySet<string> = new Set()
): boolean {
  let lastOutbound = -1;
  messages.forEach((m, i) => { if (m.direction === 'outbound') lastOutbound = i; });
  const open = messages.slice(lastOutbound + 1).filter((m) => m.direction === 'inbound');
  if (!open.length) return false;
  if (open.some((m) => fileMessageIds.has(m.id))) return false;
  if (!open.every((m) => hasNoNewWords(stripQuotedReply(m.body_text ?? '')))) return false;
  if (lastOutbound >= 0) return true;
  return hasNoNewWords(normalizeSubject(subject ?? ''));
}
