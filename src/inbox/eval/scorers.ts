// src/inbox/eval/scorers.ts
//
// Pure, deterministic scorers that encode the reply-quality bar (warm + direct,
// answer-first, no filler, grounded). Used by the real-thread eval harness to
// MEASURE drafter output instead of eyeballing it. No I/O, no LLM.

/** Banned customer-service filler bookends - the generic padding that made every
 * reply read the same regardless of category. A reply that contains any of these
 * fails the bar. */
const FILLER_PATTERNS: RegExp[] = [
  /\bdo not hesitate\b/i,
  /\bdon't hesitate\b/i,
  /\bthank you for getting in touch\b/i,
  /\bif you have any (?:other |further )?questions\b/i,
  /\bplease feel free to (?:reach out|get in touch)\b/i,
];

/** True if the reply contains any banned filler bookend. */
export function hasFillerBookend(text: string): boolean {
  return FILLER_PATTERNS.some((re) => re.test(text));
}

/** Word count (whitespace-separated), for the conciseness bar. */
export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** The reply's first sentence (up to the first sentence-ending punctuation). */
function firstSentence(text: string): string {
  const m = text.trim().match(/^[^.!?]*[.!?]?/);
  return (m ? m[0] : text).trim();
}

/** True when the reply AFFIRMS delivery up front (first sentence), not buried. The
 * customer asked "do you deliver to X" and deserves a direct yes in sentence one. */
export function affirmsDelivery(text: string): boolean {
  return /\b(?:yes|we (?:do|can|ship|deliver))\b/i.test(firstSentence(text));
}

/** True when a grounded delivery day-range ("N-M days") is stated. */
export function statesDayRange(text: string): boolean {
  return /\b\d{1,3}\s*-\s*\d{1,3}\s*days?\b/i.test(text);
}
