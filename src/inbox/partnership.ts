import type { ScreenFacts, ScreenVerdict } from './types';
import { applySalutation } from './draft';

export const PARTNERSHIP_ADDRESS = 'sales@activepaw.co.uk';
export const PARTNERSHIP_FROM = 'Active Paw Partnerships <sales@activepaw.co.uk>';
export const PASS_THRESHOLD = 8;       // score >= → send the application form (spec §6.4)
export const AUTO_DECLINE_LOW = false; // dial: auto-decline score <= 3 (spec §6.4, default OFF)

const PARTNERSHIP_CATEGORIES = new Set(['affiliate', 'wholesale-b2b']);

/** Three converging on-ramps (OR). Declared intent reinforces but never overrides
 * the classifier; this is purely a routing signal. */
export function isPartnershipLane(opts: {
  inboundToAddrs: string[]; declaredIntent: string | null; primaryCategory: string | null;
}): boolean {
  if (opts.primaryCategory && PARTNERSHIP_CATEGORIES.has(opts.primaryCategory)) return true;
  if (opts.declaredIntent === 'partnerships') return true;
  return opts.inboundToAddrs.some((t) => (t ?? '').toLowerCase() === PARTNERSHIP_ADDRESS);
}

function gateDecline(gate: string, reason: string): ScreenVerdict {
  return { decision: 'decline', score: null, gate, signals: {}, reasons: [reason] };
}

const RELEVANCE: Record<ScreenFacts['audienceRelevance'], number> = { pet_uk: 2, partial: 1, unknown: 1, off: 0 };
const ENGAGEMENT: Record<ScreenFacts['engagement'], number> = { plausible: 2, unclear: 1, implausible: 0 };
const EVIDENCE: Record<ScreenFacts['evidence'], number> = { concrete: 2, vague: 1, none: 0 };
const EXPERIENCE: Record<ScreenFacts['experience'], number> = { strong: 2, some: 1, none: 0 };
const METHOD: Record<ScreenFacts['method'], number> = { content: 2, mixed: 1, unknown: 1, discount: 0 };
const SPECIFICITY: Record<ScreenFacts['specificity'], number> = { specific: 2, partial: 1, vague: 0 };

/** Hard gates → decline. Otherwise a 0–12 score sorts form vs. escalate. The score
 * NEVER causes a decline unless the (default-OFF) auto-decline-low dial is on. */
export function scoreScreen(
  facts: ScreenFacts,
  opts?: { passThreshold?: number; autoDeclineLow?: boolean }
): ScreenVerdict {
  const passThreshold = opts?.passThreshold ?? PASS_THRESHOLD;
  const autoDeclineLow = opts?.autoDeclineLow ?? AUTO_DECLINE_LOW;

  if (!facts.channelUrls || facts.channelUrls.length === 0)
    return gateDecline('G1', 'No channel/URL provided — no basis to evaluate.');
  if (facts.disqualifier === 'coupon_cashback') return gateDecline('G2', 'Coupon/cashback/deal-type channel.');
  if (facts.disqualifier === 'brand_bidding') return gateDecline('G2', 'Plans brand-term bidding / interception.');
  if (facts.audienceRelevance === 'off') return gateDecline('G3', 'Audience not pet- or UK-relevant.');
  if (facts.acceptsTerms === 'no') return gateDecline('G4', 'Rejects performance basis or #ad disclosure.');
  if (facts.disqualifier === 'prohibited_tactics') return gateDecline('G5', 'States prohibited tactics.');

  const signals: Record<string, number> = {
    S1_relevance: RELEVANCE[facts.audienceRelevance],
    S2_engagement: ENGAGEMENT[facts.engagement],
    S3_evidence: EVIDENCE[facts.evidence],
    S4_experience: EXPERIENCE[facts.experience],
    S5_method: METHOD[facts.method],
    S6_specificity: SPECIFICITY[facts.specificity],
  };
  const score = Object.values(signals).reduce((a, b) => a + b, 0);

  if (score >= passThreshold)
    return { decision: 'form', score, gate: null, signals, reasons: [`Score ${score}/12 ≥ ${passThreshold}.`] };
  if (autoDeclineLow && score <= 3)
    return { decision: 'decline', score, gate: 'LOW', signals, reasons: [`Score ${score}/12 ≤ 3 (auto-decline-low on).`] };
  return { decision: 'escalate', score, gate: null, signals, reasons: [`Score ${score}/12 — owner review.`] };
}

// Bodies are written WITHOUT a greeting; applySalutation() prepends "Hi <name>,".
const QUALIFYING_BODY =
`Thanks for reaching out about working together — we'd genuinely like to learn more. We partner with a small number of creators, so we ask everyone the same few questions first. If it looks like a fit, we'll send you our partner application.

1. Where would you promote Active Paw? Please share the link(s) to the channel(s) or site where you'd feature us.
2. Tell us about your audience — roughly how many followers/visitors, your typical engagement (likes/comments/views on a recent post), and which country most of them are in.
3. How would you plan to promote our products? For example a review or video, a "best for dogs" feature, everyday content, a discount-code post, paid ads — whatever you actually have in mind.
4. Have you partnered with brands before? If so, a couple of examples or links we can look at (pet-related especially welcome). If you've mentioned specific results, a past campaign we could see helps a lot.
5. How we work, briefly: partnerships are performance-based (commission on sales from new customers, tracked with your own link), we ask for a clear #ad label, and we don't allow bidding on our brand name or posting codes to coupon sites. Does that suit how you operate?

No rush — whenever you've got a few minutes. We read every reply.

Best regards,
Active Paw Partnerships`;

const DECLINE_BODY =
`Thank you for taking the time to share that with us — we really do appreciate the interest in Active Paw.

At the moment we're keeping our partnerships limited to creators whose audience and approach line up closely with what we're focused on, and it isn't quite the right fit right now. That's no reflection on your work — just where we are.

If things change on your side — a growing pet-focused audience, a campaign you're proud of — we'd be glad to hear from you again.

Wishing you the best with it,
Active Paw Partnerships`;

const FORM_INVITE_BODY =
`Thank you — this looks like a great potential fit, and we'd love to take it further.

The next step is our short partner application, where we'll gather a few details to set things up properly. We'll send that over shortly.

Looking forward to working with you,
Active Paw Partnerships`;

const HOLDING_ACK_BODY =
`Thank you for those details — much appreciated.

We're taking a look and reviewing the fit, and we'll be in touch shortly with the next step.

Best regards,
Active Paw Partnerships`;

export function buildQualifyingEmail(name: string | null): string { return applySalutation(QUALIFYING_BODY, name); }
export function buildPartnershipDecline(name: string | null): string { return applySalutation(DECLINE_BODY, name); }
export function buildFormInvite(name: string | null): string { return applySalutation(FORM_INVITE_BODY, name); }
export function buildHoldingAck(name: string | null): string { return applySalutation(HOLDING_ACK_BODY, name); }
