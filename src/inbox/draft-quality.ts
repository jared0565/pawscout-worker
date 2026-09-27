// src/inbox/draft-quality.ts
//
// RUNTIME draft-quality gate. Pure, deterministic scorers that encode the reply bar
// (owner voice = a WARM, polite wrapper AROUND a grounded answer), plus findDraftIssues
// which turns failures into actionable revision feedback. This runs INSIDE the worker
// on every draft (and Regenerate): the system self-corrects in production rather than
// relying on dev-time tuning. No I/O, no LLM.
//
// Voice policy (owner decision 2026-06-30): courtesy phrases ("thank you for getting in
// touch", "please do not hesitate") are ALLOWED - the prior pass that banned them
// over-corrected against the owner's actual voice. The gate now enforces the failure
// modes the owner actually edits out: a reply with NO substance (only courtesy +
// sign-off), an over-long reply, or a missing direct answer when one is owed.

import { repeatsPriorOutbound } from './repeat';

/** Customer-service courtesy phrases. ALLOWED (the owner's voice is a warm, polite
 * wrapper), so they no longer fail the bar on their own. They carry no substance, so
 * they are STRIPPED when measuring whether a reply actually answers anything. */
const FILLER_PATTERNS: RegExp[] = [
  /\bdo not hesitate\b/i,
  /\bdon't hesitate\b/i,
  /\bthank you for getting in touch\b/i,
  /\bthank you for (?:your )?(?:enquiry|inquiry|reaching out|your message|your kind (?:words|message))\b/i,
  /\bif you have any (?:other |further )?questions[^.]*\.?/i,
  /\bplease feel free to (?:reach out|get in touch|ask)\b/i,
  /\bwe (?:really )?appreciate (?:you|your)[^.]*\.?/i,
];

/** A trailing sign-off block ("Best regards, Active Paw Customer Support") - courtesy,
 * not substance, so it is stripped before measuring substance. */
const SIGNOFF_PATTERN = /\b(?:best (?:regards|wishes)|kind regards|warm regards|many thanks|wishing you)\b[\s\S]*$/i;

/** True if the reply contains a customer-service courtesy phrase. Retained for callers/
 * tests; courtesy is allowed, so this is no longer a fail condition by itself. */
export function hasFillerBookend(text: string): boolean {
  return FILLER_PATTERNS.some((re) => re.test(text));
}

/** Word count (whitespace-separated), for the conciseness bar. */
export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Words of REAL substance: the reply with courtesy phrases + the sign-off block + bare
 * greeting/brand tokens removed. A warm reply that genuinely answers something keeps
 * plenty here; a reply that is only courtesy + sign-off collapses toward zero. (The gate
 * sees the pre-salutation body, so the greeting line is already absent.) */
export function substanceWordCount(text: string): number {
  let t = ' ' + text + ' ';
  for (const re of FILLER_PATTERNS) t = t.replace(new RegExp(re.source, 'gi'), ' ');
  t = t.replace(SIGNOFF_PATTERN, ' ');
  t = t.replace(/\b(?:hi|hello|hey|thanks|thank you|cheers|regards|active\s+paw|customer\s+service|team|best)\b/gi, ' ');
  t = t.replace(/[^\p{L}\s]/gu, ' '); // drop punctuation so stray tokens never count as substance
  return countWords(t);
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

// Business-biography fabrication (2026-07-05, the Azan draft): no grounded fact
// covers the business's age, scale or customer base, so ANY such claim in a
// draft is invented. Sentence-scoped: the sentence must be ABOUT the business
// (we/our/Active Paw/the store) AND make a longevity or scale claim - so a
// product line like "this toy lasts for years" and the compliant privacy
// decline ("how long we have been trading is not something we share") pass.
const BIZ_SUBJECT = /\b(?:we|our|active\s+paw|the (?:store|shop|business))\b/i;
const BIZ_LONGEVITY: RegExp[] = [
  /\bbeen (?:running|trading|operating|open|established|going|around)\b[^.!?]{0,40}\b(?:for|since|over|more than|nearly|almost|years? now)\b/i,
  /\b(?:established|founded|trading|operating|running|in business) (?:since|in) (?:19|20)\d{2}\b/i,
  /\b(?:for|over|more than|nearly|almost) (?:a )?(?:good |couple of |few |several |many |number of )*years\b/i,
  /\byears of (?:experience|trading|business|serving)\b/i,
];
const BIZ_SCALE: RegExp[] = [
  /\bloyal customer(?:s| base)\b/i,
  /\bcustomer base\b/i,
  /\b(?:hundreds|thousands|millions) of (?:happy |satisfied |loyal )?(?:customers|orders|pet owners)\b/i,
  /\b\d[\d,]*\+? (?:happy |satisfied |loyal )?customers\b/i,
];

/** True when a sentence about the business claims longevity or scale - facts no
 * agent is ever given, so their presence means the model invented them. */
export function claimsBusinessBiography(text: string): boolean {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (!BIZ_SUBJECT.test(sentence)) continue;
    if (BIZ_LONGEVITY.some((re) => re.test(sentence)) || BIZ_SCALE.some((re) => re.test(sentence))) return true;
  }
  return false;
}

// A trade decline nobody asked for (2026-09-21, the Sofia draft): "I have 5
// customers who need this product, is it available?" was answered with "we are
// not offering wholesale or trade terms". Owner rule: a quantity is a purchase.
// TRADE_ASK is deliberately GENEROUS (any mention of a discount or a better
// price counts as asking), so this gate only fires when the customer's words
// hold no request for terms at all; TRADE_TALK is what such a reply looks like.
const TRADE_ASK =
  /\b(?:wholesale|trade (?:price|prices|pricing|terms|account|accounts|discount)|discounts?|(?:better|special|cheaper|lower|reduced) (?:price|prices|pricing|rate|rates|deal)|resell(?:er|ers|ing)?|stockists?|distribut(?:or|ors|ion|e)|price ?list|moq|minimum order)\b/i;
const TRADE_TALK =
  /\b(?:wholesale|trade (?:terms|pricing|prices|accounts?)|resellers?|bulk discounts?|individual retail (?:orders|buyers))\b/i;

/** True when the reply talks about wholesale or trade terms although the
 * customer's own words never asked for any. Unknown customer text = false. */
export function volunteersTradeDecline(replyText: string, customerText: string): boolean {
  if (!customerText.trim()) return false;
  return TRADE_TALK.test(replyText) && !TRADE_ASK.test(customerText);
}

// A buyer of several is told where the delivery cost appears (2026-09-21, the
// first real draft after the fix above): the purchase was welcomed but the
// delivery sentence was dropped, because she had not asked about delivery and
// the workflow rule says to answer only what was asked. "orders" is plural on
// purpose: "can I order it in 2 weeks" is a verb, not a quantity.
const QUANTITY_MENTION =
  /\b(?:\d{1,4}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|several|multiple|a few|a couple of|dozens?)\b[^.?!\n]{0,40}\b(?:customers?|clients?|orders|units?|pieces?|items?|packs?|people|friends|of (?:them|these|those|it))\b/i;

/** True when the customer's words hold a quantity and the reply never says that
 * the delivery cost is shown at checkout: the sentence has to name checkout AND
 * be about delivery ("pay at checkout" alone is not it). The caller decides the
 * lane. What the sentence must NOT say is left to the prompts: the live
 * checkout charges one flat rate per order per origin (measured 2026-09-21), so
 * the cost never goes up with the quantity ordered. */
export function owesBasketDelivery(replyText: string, customerText: string): boolean {
  if (!QUANTITY_MENTION.test(customerText)) return false;
  return !(/\bcheckout\b/i.test(replyText) && /\b(?:deliver(?:y|ies|ed)?|shipping|postage)\b/i.test(replyText));
}

/** Context for the runtime gate: the conciseness ceiling and what the customer
 * actually asked, so the gate can demand a direct answer where one is owed. */
export interface DraftQualityContext {
  maxWords?: number;        // conciseness ceiling (default 110: warm wrapper + a grounded answer)
  askedDelivery?: boolean;  // customer asked "do you deliver/ship to X" -> require an up-front yes
  priorOutbound?: ReadonlyArray<string | null>; // our earlier replies on this thread (owner rule 2026-09-04: never the same message twice)
  customerText?: string;    // the customer's open message(s), so a reply can be held against what they actually asked
  buyingLane?: boolean;     // the thread sits on a lane that meets buyers (lead, wholesale, product question)
  supplierLane?: boolean;   // supplier lane: the reply must promise nothing (owner decision 2026-09-27)
}

// Supplier replies promise nothing (owner decision 2026-09-27): no order, review,
// reply, meeting, call, samples, partnership, trial or "at this stage". Asking
// for their link or whether they dropship is information gathering, not a
// promise, so neither is matched here.
//
// `guarded: false` marks the three patterns the controller ruled must flag
// unconditionally regardless of a nearby negation: the partnership pattern, the
// "at this stage"/"for now" pattern, and the affiliate/discount-code/commission
// pattern. Every other pattern is `guarded: true` and gets the negation check
// below (fix round 2, 2026-09-27): a correct refusal ("There is no need to send
// samples.") must not be flagged as a promise.
const SUPPLIER_PROMISE_RULES: { re: RegExp; guarded: boolean }[] = [
  { re: /\bwe(?:['’]ll|['’]d| will| would| shall| can)\s+(?:be\s+)?(?:plac\w*|order\w*|buy\w*|purchas\w*|stock\w*|list\w*|review\w*|contact\w*|reach\w*|get\s+back|follow\s+up|be\s+in\s+touch|in\s+touch|consider\w*|evaluat\w*|arrang\w*|schedul\w*|happy\s+to\s+arrange|happy\s+to\s+schedule)\b/i, guarded: true },
  { re: /\blook(?:ing)?\s+forward\s+to\s+(?:working|partnering|cooperat\w*|collaborat\w*|doing\s+business)/i, guarded: true },
  { re: /\bpartnership\b/i, guarded: false },
  { re: /\b(?:happy|glad|pleased)\s+to\s+(?:arrange|schedule|set\s+up|have|join|hop\s+on|jump\s+on|catch\s+up)\b/i, guarded: true },
  { re: /\bsend\s+(?:us\s+)?(?:a\s+|some\s+|your\s+)?samples?\b/i, guarded: true },
  { re: /\b(?:let(?:['’]s|\s+us)|we(?:['’]ll| will)|happy\s+to|glad\s+to)\b[^.]*\bwhatsapp\b/i, guarded: true },
  { re: /\bat\s+this\s+stage\b|\bfor\s+now\b/i, guarded: false },
  { re: /apps\/pawscout\/affiliate|\baffiliate\b|\bdiscount\s+code\b|\bcommission\b/i, guarded: false },
  { re: /\b(?:jump|hop)\s+on\s+a\s+(?:quick\s+)?(?:call|chat)\b/i, guarded: true },
  { re: /\bset\s+up\s+a\s+(?:quick\s+)?(?:call|meeting|chat|trial)\b/i, guarded: true },
  { re: /\blet(?:['’]s|\s+us)\s+(?:set\s+up|arrange|schedule|start|try|trial|place|book)\b/i, guarded: true },
  { re: /\b(?:try|test)\w*\s+(?:a\s+|some\s+|your\s+)?(?:samples?|products?)\b|\b(?:trial|test)\s+order\b/i, guarded: true },
];

// Curly apostrophe (U+2019) built from its code point, never typed literally.
const CURLY_APOSTROPHE = String.fromCharCode(8217);
/** Word-bounded (never a substring hit inside "noted", "nothing" or "another")
 * negation vocabulary that clears a guarded pattern's match. */
const NEGATION_RE = new RegExp(
  `\\b(?:not|no need|cannot|can't|can${CURLY_APOSTROPHE}t|do not|don't|don${CURLY_APOSTROPHE}t|unable|never)\\b`, 'i'
);
/** How far back (characters) a negation is allowed to reach from a match start. */
const NEGATION_WINDOW_CHARS = 30;
/** Punctuation that ends a clause: a negation from an earlier clause must never
 * bleed across one of these into a later, unrelated clause that happens to fall
 * within the character window (e.g. "We cannot promise anything, but we will
 * review your catalogue." - the second clause is a genuine promise and is not
 * negated by the first clause's "cannot"). */
const CLAUSE_BOUNDARY_CHARS = [',', '.', ';', '!', '?', '\n'];

function precededByNegation(text: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - NEGATION_WINDOW_CHARS);
  let window = text.slice(windowStart, matchIndex);
  let boundary = -1;
  for (const ch of CLAUSE_BOUNDARY_CHARS) {
    const idx = window.lastIndexOf(ch);
    if (idx > boundary) boundary = idx;
  }
  if (boundary !== -1) window = window.slice(boundary + 1);
  return NEGATION_RE.test(window);
}

/** True when a supplier reply promises, suggests or commits to anything. A
 * guarded pattern's match is ignored (not a promise) when negated within its
 * own clause; an unguarded pattern's match always flags. */
export function promisesSupplier(text: string): boolean {
  return SUPPLIER_PROMISE_RULES.some(({ re, guarded }) => {
    if (!guarded) return re.test(text);
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = g.exec(text)) !== null) {
      if (!precededByNegation(text, m.index)) return true;
      if (g.lastIndex === m.index) g.lastIndex += 1; // never loop on a zero-length match
    }
    return false;
  });
}

/** Minimum words of real substance a reply must carry (a warm courtesy wrapper is fine,
 * but it must wrap an actual answer, not replace it). Set so a genuine short answer
 * ("we ship to the US") passes while a courtesy-only reply fails. */
const MIN_SUBSTANCE_WORDS = 4;

/**
 * Inspect a candidate reply against the bar and return a list of concrete,
 * human-readable issues (empty => the draft passes). Each string is written as
 * feedback the reviser can act on directly. PURE - the caller decides whether to
 * revise. This is the deterministic half of the runtime self-correction loop.
 *
 * Voice (owner decision): courtesy is welcome; the failures we flag are no-substance,
 * over-length, and a missing direct answer when the customer asked a yes/no ship Q.
 */
export function findDraftIssues(bodyText: string, ctx: DraftQualityContext = {}): string[] {
  const issues: string[] = [];
  if (substanceWordCount(bodyText) < MIN_SUBSTANCE_WORDS) {
    issues.push("This reply is all courtesy and no substance. Lead with the specific, grounded answer to what the customer actually asked (a warm greeting and close are fine, but they must wrap a real answer, not replace it).");
  }
  const max = ctx.maxWords ?? 110;
  const words = countWords(bodyText);
  if (words > max) {
    issues.push(`Too long (${words} words). Keep it focused and under ${max} words: a warm but concise reply that answers what they asked.`);
  }
  if (ctx.askedDelivery && !affirmsDelivery(bodyText)) {
    issues.push("The customer asked whether we deliver to their location; affirm it directly in the first sentence (e.g. 'Yes, we ship to ...').");
  }
  if (ctx.priorOutbound && ctx.priorOutbound.length > 0 && repeatsPriorOutbound(bodyText, ctx.priorOutbound)) {
    issues.push("This reply repeats a message we already sent on this thread. Never send the same message twice: write a SHORTER reply that acknowledges what they just said and adds only what is new, or points back to the earlier reply in one sentence.");
  }
  if (ctx.customerText && volunteersTradeDecline(bodyText, ctx.customerText)) {
    issues.push("The customer did not ask for wholesale or trade terms, a bulk discount or a reseller arrangement; they want to buy. Remove every mention of wholesale, trade terms, resellers and what we are 'focused on', and do not decline anything. Answer what they asked, say they are welcome to order any quantity through the website, and that the delivery cost depends on their destination and what is in the basket and is shown at checkout before payment.");
  }
  if (ctx.buyingLane && ctx.customerText && owesBasketDelivery(bodyText, ctx.customerText)) {
    issues.push("The customer wants several items or several orders. Keep the reply as it is and add ONE sentence saying that the delivery cost depends on their destination and what is in the basket, and that the exact total for the whole order is shown at checkout before payment. Never quote a delivery figure, and never say the cost goes up with the quantity ordered.");
  }
  if (claimsBusinessBiography(bodyText)) {
    issues.push("This reply states facts about the business itself (how long it has been trading, its size, or its customer base). No such fact exists in the grounded store facts, so it is invented. Remove the claim entirely: say warmly that details about the business are something we keep private, and offer help with products or orders instead.");
  }
  if (ctx.supplierLane && promisesSupplier(bodyText)) {
    issues.push("This is a reply to a supplier and it promises or suggests something: an order, a review, a reply, a meeting, a call, samples, a partnership, the affiliate programme, or 'at this stage'. Remove every promise. Keep only: thanks for what they offered, that they are welcome to email their catalogue or product information, the request for their website or online store link, the question whether they offer dropshipping (goods and packaging only), and that we keep supplier details on file for reference.");
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
