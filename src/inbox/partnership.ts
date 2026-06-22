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
