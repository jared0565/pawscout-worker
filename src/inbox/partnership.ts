import type { ScreenFacts, ScreenVerdict } from './types';

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
