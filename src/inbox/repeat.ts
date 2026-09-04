/**
 * Repeat-message detection for the inbox (owner rule 2026-09-04): a sender who
 * keeps sending the SAME message is spam, and their later messages are blocked.
 *
 * "The same message" is deliberately narrow. The live inbox on 2026-09-04 held
 * two repeat shapes: 12 senders re-sending a near-identical pitch (mass mail or
 * copy-paste), and 151 senders whose follow-ups were reworded ("just following
 * up on my last message"). Only the first shape is a repeat here - a reworded
 * nudge is answered by the funnel like any other message, never blocked.
 *
 * Pure and deterministic. Grounded in the sender's NEW text only: the quoted
 * chain is stripped first, so quoting our own reply back never counts as
 * repeating oneself, and an all-quote message ("nothing new") is never a repeat.
 */
import { stripQuotedReply } from './quote';

/** Threads in these lanes belong to customers (or trade buyers), and a contact
 * with any such thread is never auto-blocked, however often they repeat
 * themselves. 'lead' is included on purpose: a prospective buyer matters more
 * than the occasional vendor the classifier files there. */
export const PROTECTED_CATEGORIES = ['order-status', 'shipping-returns', 'product-question', 'complaint', 'wholesale-b2b', 'lead'] as const;

/** Texts shorter than this (in words) are never repeats: "Okay", "Thanks",
 * "Yes please" recur legitimately in real conversations. */
const MIN_WORDS = 8;
/** Word-shingle size for the overlap measure. */
const SHINGLE = 4;
/** Jaccard overlap at or above this counts as the same message. */
const DEFAULT_THRESHOLD = 0.8;

/** Lowercased, quote-stripped, URL-free, punctuation-free, single-spaced. */
export function normalizeForRepeat(text: string | null | undefined): string {
  const own = stripQuotedReply(text ?? '').toLowerCase();
  return own
    .replace(/https?:\/\/\S+|www\.\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shingles(words: string[]): Set<string> {
  const out = new Set<string>();
  if (words.length < SHINGLE) { out.add(words.join(' ')); return out; }
  for (let i = 0; i + SHINGLE <= words.length; i++) out.add(words.slice(i, i + SHINGLE).join(' '));
  return out;
}

/** True when `candidate` is the same message as `earlier`: identical after
 * normalisation, or sharing at least `threshold` of their 4-word shingles. */
export function isRepeatOf(candidate: string | null | undefined, earlier: string | null | undefined, threshold = DEFAULT_THRESHOLD): boolean {
  const a = normalizeForRepeat(candidate);
  const b = normalizeForRepeat(earlier);
  const wa = a ? a.split(' ') : [];
  const wb = b ? b.split(' ') : [];
  if (wa.length < MIN_WORDS || wb.length < MIN_WORDS) return false;
  if (a === b) return true;
  const sa = shingles(wa);
  const sb = shingles(wb);
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  const union = sa.size + sb.size - inter;
  return union > 0 && inter / union >= threshold;
}

export interface EarlierInbound {
  /** The earlier message's body (quoted chain may be present; it is stripped). */
  text: string | null;
  /** Whether we sent an outbound reply on that message's thread AFTER it arrived. */
  repliedAfter: boolean;
}

/** The owner's threshold (2026-09-04): a sender is spam on the 2nd copy of a
 * message we have already replied to, or on the 3rd copy overall (a mass-mailer
 * that never waits for an answer). Earlier messages that are not the same text
 * are ignored entirely. */
export function repeatVerdict(newText: string | null | undefined, earlier: EarlierInbound[]): boolean {
  const copies = earlier.filter((e) => isRepeatOf(newText, e.text));
  if (copies.length === 0) return false;
  if (copies.some((c) => c.repliedAfter)) return true;
  return copies.length >= 2;
}

// --- No-repeat guard against our OWN earlier replies (owner rule 2026-09-04) ---
// "We never send the same message multiple times. If you need to send the same
// message at least make it shorter and more concise the second time."

/** Our own messages on a thread, oldest first: what the guard compares against. */
export function outboundBodies(messages: ReadonlyArray<{ direction: string; body_text: string | null }>): (string | null)[] {
  return messages.filter((m) => m.direction === 'outbound').map((m) => m.body_text);
}

/** True when the candidate would repeat something we already sent on the thread. */
export function repeatsPriorOutbound(candidate: string | null | undefined, prior: ReadonlyArray<string | null>): boolean {
  return prior.some((p) => isRepeatOf(candidate, p));
}

export type TouchKind = 'first' | 'second' | 'pointer';

/** Picks the full body while it is new to the thread, the concise second touch
 * once the full body has gone out, and the one-line pointer back to the earlier
 * reply once both have. The pointer is the terminal touch (owner's choice): it is
 * drafted again rather than leaving the thread without a reply. */
export function chooseTouch(
  prior: ReadonlyArray<string | null>,
  bodies: { first: string; second: string; pointer: string }
): { body: string; touch: TouchKind } {
  if (!repeatsPriorOutbound(bodies.first, prior)) return { body: bodies.first, touch: 'first' };
  if (!repeatsPriorOutbound(bodies.second, prior)) return { body: bodies.second, touch: 'second' };
  return { body: bodies.pointer, touch: 'pointer' };
}
