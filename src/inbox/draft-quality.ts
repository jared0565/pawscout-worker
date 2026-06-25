// src/inbox/draft-quality.ts
//
// RUNTIME draft-quality gate. Pure, deterministic scorers that encode the reply
// bar (warm + direct, answer-first, no filler, grounded), plus findDraftIssues
// which turns failures into actionable revision feedback. This runs INSIDE the
// worker on every draft (and Regenerate): the system self-corrects in production
// rather than relying on dev-time tuning. No I/O, no LLM.

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

/** True when the customer asked a yes/no "do you deliver to X" question (so the
 * reply owes a direct affirmation). Anchored on an auxiliary + "you" + a ship/
 * deliver verb so a delivery-TIME question ("how long does shipping take") and the
 * "thank you, shipping..." red herring do NOT trigger it. */
export function asksDoYouDeliver(text: string): boolean {
  return /\b(?:do|does|did|can|could|will|would)\s+you\b[^.?!]{0,40}\b(?:ship|deliver|send|post|shipping|delivery)\b/i.test(text);
}

/** Context for the runtime gate: the conciseness ceiling and what the customer
 * actually asked, so the gate can demand a direct answer where one is owed. */
export interface DraftQualityContext {
  maxWords?: number;        // conciseness ceiling (default 80)
  askedDelivery?: boolean;  // customer asked "do you deliver/ship to X" -> require an up-front yes
}

/**
 * Inspect a candidate reply against the bar and return a list of concrete,
 * human-readable issues (empty => the draft passes). Each string is written as
 * feedback the reviser can act on directly. PURE - the caller decides whether to
 * revise. This is the deterministic half of the runtime self-correction loop.
 */
export function findDraftIssues(bodyText: string, ctx: DraftQualityContext = {}): string[] {
  const issues: string[] = [];
  if (hasFillerBookend(bodyText)) {
    issues.push("Remove generic filler ('thank you for getting in touch', 'do not hesitate', 'if you have any other questions'); keep only specific, useful sentences.");
  }
  const max = ctx.maxWords ?? 80;
  const words = countWords(bodyText);
  if (words > max) {
    issues.push(`Too long (${words} words). Be concise: under ${max} words, 2 to 3 sentences, answer first.`);
  }
  if (ctx.askedDelivery && !affirmsDelivery(bodyText)) {
    issues.push("The customer asked whether we deliver to their location; affirm it directly in the first sentence (e.g. 'Yes, we ship to ...').");
  }
  return issues;
}

/**
 * Runtime self-correction loop. Check the draft against the bar; while it fails,
 * ask `revise` (the LLM-backed reviser, injected so this stays pure/testable) to
 * fix it, handing over the concrete issues as feedback. Returns the BEST candidate
 * seen (fewest issues), so a revision that makes things worse never wins, and a
 * reviser failure (null) degrades to the current draft. Bounded by `maxAttempts`.
 */
export async function refineUntilClean<T extends { bodyText: string }>(
  initial: T,
  revise: (prev: T, issues: string[]) => Promise<T | null>,
  ctx: DraftQualityContext = {},
  maxAttempts = 2
): Promise<T> {
  let best = initial;
  let bestCount = findDraftIssues(initial.bodyText, ctx).length;
  let current = initial;
  let currentIssues = findDraftIssues(current.bodyText, ctx);

  for (let i = 0; i < maxAttempts && currentIssues.length > 0; i++) {
    const revised = await revise(current, currentIssues);
    if (!revised) break; // reviser unavailable -> keep the best so far
    current = revised;
    currentIssues = findDraftIssues(current.bodyText, ctx);
    if (currentIssues.length < bestCount) { best = current; bestCount = currentIssues.length; }
  }
  return best;
}
