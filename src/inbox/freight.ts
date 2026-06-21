import type { CjClient } from '../cj';
import type { TenantConfig } from '../types';

/**
 * Freight-grounded delivery replies (Task [7]).
 *
 * When a customer asks about international shipping, the worker computes a REAL
 * CJ freight quote and appends a single claim-safe line to the drafted reply.
 * The figure is injected DETERMINISTICALLY in code — the LLM never sees or emits
 * it (standing rule: the model must never state prices/SKUs/variant ids/discounts).
 *
 * Governing principle: precision over recall. A wrong number is worse than the
 * existing vague hedge, so we inject ONLY when the destination is unambiguous and
 * CJ returns a real quote; on ANY doubt we return null and the drafter falls back
 * to "we can ship there — we'll confirm the exact cost and timeframe". Never throw.
 */

// --- representative variant (FLAG FOR ORCHESTRATOR REVIEW) -----------------
//
// The freight quote needs a real CJ variant id (weight drives freight), but the
// drafter has no specific product in hand for a generic "do you ship to X?"
// enquiry. We therefore quote ONE representative in-stock variant as a proxy for
// "a typical small pet item" — the same shape the storefront sells most of.
//
// The vid is supplied at runtime via env (INBOX_FREIGHT_REP_VID) so the
// orchestrator can ACTIVATE the feature with a config change, not a code edit —
// mirroring the CJ_RELAY_* env pattern. UNSET = feature dormant: buildShippingLine
// returns null and the drafter keeps the existing safe hedge. This is intentional;
// the feature is dormant-safe until grounded in a real variant.
//
// Using one fixed vid (vs. a live getDetailPreferWarehouse round-trip per draft)
// is a deliberate trade: less latency, fewer failure modes, no origin guesswork in
// the hot sweep loop. The figure is a PROXY — it is not the freight of the specific
// product the customer asked about (flagged for review). Origin 'CN' is the
// conservative default dispatch country (the long pole on time + cost — quoting it
// never under-promises).
export const REP_ORIGIN = 'CN';

/** Shipping/delivery enquiry categories that warrant a freight lookup. */
export function isShippingIntent(category: string | null | undefined, subject: string, conversation: string): boolean {
  if ((category ?? '').toLowerCase() === 'shipping-returns') return true;
  // Category can be coarse ('product-question'/'lead'); also catch obvious
  // shipping language in the subject/body so a delivery question routed elsewhere
  // still gets grounded.
  return /\b(ship|shipping|deliver|delivery|postage|courier|freight|dispatch|despatch)\b/i.test(`${subject}\n${conversation}`);
}

/**
 * Curated destination name/code → ISO-3166-1 alpha-2. Deliberately small and
 * unambiguous: common Active Paw international markets + the obvious aliases.
 * We do NOT try to cover every country — an unknown destination falls back to
 * the safe hedge, which is fine.
 */
const COUNTRY_NAMES: Record<string, string> = {
  ireland: 'IE', eire: 'IE',
  france: 'FR', germany: 'DE', deutschland: 'DE', spain: 'ES', espana: 'ES',
  portugal: 'PT', italy: 'IT', italia: 'IT', netherlands: 'NL', holland: 'NL',
  belgium: 'BE', luxembourg: 'LU', austria: 'AT', switzerland: 'CH',
  denmark: 'DK', sweden: 'SE', norway: 'NO', finland: 'FI', iceland: 'IS',
  poland: 'PL', 'czech republic': 'CZ', czechia: 'CZ', slovakia: 'SK',
  hungary: 'HU', romania: 'RO', bulgaria: 'BG', greece: 'GR', croatia: 'HR',
  slovenia: 'SI', estonia: 'EE', latvia: 'LV', lithuania: 'LT', malta: 'MT',
  cyprus: 'CY',
  'united states': 'US', 'united states of america': 'US', usa: 'US',
  canada: 'CA', mexico: 'MX',
  australia: 'AU', 'new zealand': 'NZ',
  japan: 'JP', china: 'CN', 'hong kong': 'HK', singapore: 'SG',
  'south korea': 'KR', korea: 'KR', india: 'IN', 'united arab emirates': 'AE',
  uae: 'AE', 'saudi arabia': 'SA', 'south africa': 'ZA', israel: 'IL',
  brazil: 'BR', argentina: 'AR', chile: 'CL'
};

/**
 * In-scope destinations for the synced CJ logistics matrix (owner decision
 * 2026-06-21: full markets). GB (home) + every unique ISO-2 the store recognises,
 * minus the origin (CN). The nightly fetch-once-fan-out sync quotes each of these.
 */
export const LOGISTICS_DESTINATIONS: string[] = [
  ...new Set<string>(['GB', ...Object.values(COUNTRY_NAMES)]),
].filter((c) => c !== 'CN');

/** ccTLD → ISO-2 for the few that are unambiguous and worth trusting. Generic
 * TLDs (.com/.org/.net) and gmail/outlook addresses tell us nothing → skipped. */
const CCTLD: Record<string, string> = {
  ie: 'IE', fr: 'FR', de: 'DE', es: 'ES', pt: 'PT', it: 'IT', nl: 'NL', be: 'BE',
  at: 'AT', ch: 'CH', dk: 'DK', se: 'SE', no: 'NO', fi: 'FI', pl: 'PL', gr: 'GR',
  ca: 'CA', au: 'AU', nz: 'NZ', jp: 'JP', sg: 'SG', za: 'ZA', us: 'US', in: 'IN'
};

/**
 * Best-effort destination country (ISO-2) from the conversation, then subject,
 * then the customer's email ccTLD. Pure (no I/O). Returns null when ambiguous or
 * unknown so the caller falls back to safe language.
 *
 * - An explicitly NAMED country in the text wins over the email ccTLD.
 * - If two DIFFERENT countries are named, it's ambiguous → null.
 * - GB/UK is treated as the home market and returns 'GB' (caller skips the quote
 *   for GB — UK delivery is already covered by STORE_FACTS).
 */
export function deriveDestinationCountry(conversation: string, subject: string, email: string): string | null {
  const text = `${subject}\n${conversation}`.toLowerCase();

  // UK home market — recognised so the caller can explicitly skip a CJ quote.
  const ukNamed = /\b(uk|u\.k\.|united kingdom|britain|great britain|england|scotland|wales|northern ireland)\b/i.test(text);

  const found = new Set<string>();
  if (ukNamed) found.add('GB');
  // Multi-word names first (longest match wins for overlapping phrases).
  const names = Object.keys(COUNTRY_NAMES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    // Word-boundary match; escape any regex metachars in the curated key.
    const re = new RegExp(`(?:^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z]|$)`, 'i');
    if (re.test(text)) found.add(COUNTRY_NAMES[name]);
  }

  if (found.size === 1) return [...found][0];
  if (found.size > 1) return null; // ambiguous — multiple destinations named

  // Fall back to the email ccTLD (only the unambiguous ones).
  const tld = (email.split('@')[1] ?? '').trim().toLowerCase().split('.').pop() ?? '';
  return CCTLD[tld] ?? null;
}

/** ISO-2 → friendly display label for the customer-facing line. Falls back to the
 * raw code for any destination we derived from a ccTLD but did not name. */
const COUNTRY_LABELS: Record<string, string> = {
  GB: 'the UK', IE: 'Ireland', FR: 'France', DE: 'Germany', ES: 'Spain', PT: 'Portugal',
  IT: 'Italy', NL: 'the Netherlands', BE: 'Belgium', LU: 'Luxembourg', AT: 'Austria',
  CH: 'Switzerland', DK: 'Denmark', SE: 'Sweden', NO: 'Norway', FI: 'Finland', IS: 'Iceland',
  PL: 'Poland', CZ: 'Czech Republic', SK: 'Slovakia', HU: 'Hungary', RO: 'Romania',
  BG: 'Bulgaria', GR: 'Greece', HR: 'Croatia', SI: 'Slovenia', EE: 'Estonia', LV: 'Latvia',
  LT: 'Lithuania', MT: 'Malta', CY: 'Cyprus', US: 'the United States', CA: 'Canada',
  MX: 'Mexico', AU: 'Australia', NZ: 'New Zealand', JP: 'Japan', CN: 'China', HK: 'Hong Kong',
  SG: 'Singapore', KR: 'South Korea', IN: 'India', AE: 'the UAE', SA: 'Saudi Arabia',
  ZA: 'South Africa', IL: 'Israel', BR: 'Brazil', AR: 'Argentina', CL: 'Chile'
};

export function countryLabel(iso2: string): string {
  return COUNTRY_LABELS[iso2] ?? iso2;
}

const FREIGHT_TIMEOUT_MS = 6000;

/**
 * Build ONE claim-safe shipping-estimate line for a confidently-derived NON-GB
 * destination from a real CJ freight quote, FX-converted to GBP using the SAME
 * formula as POST /api/freight-quote. Resilient: timeout/CJ error/empty result/
 * unset representative variant all return null (→ caller keeps the safe hedge).
 * Never throws.
 *
 * @returns e.g. "Delivery to France: shipping from approx £4.10, est. 8-12 working days."
 */
export async function buildShippingLine(
  cj: Pick<CjClient, 'freightEstimate'>,
  cfg: TenantConfig,
  country: string,
  countryLabelText: string,
  repVid: string
): Promise<string | null> {
  if (!repVid) return null;                // representative variant not configured → degrade
  if (!country || country === 'GB') return null; // home market handled by STORE_FACTS
  try {
    const est = await withTimeout(
      cj.freightEstimate(repVid, REP_ORIGIN, country, 1),
      FREIGHT_TIMEOUT_MS
    );
    if (!est || !(est.priceUsd > 0)) return null;
    const fx = cfg.pricing.fxUsdToGbp * (1 + cfg.pricing.fxBufferPct / 100);
    const gbp = est.priceUsd * fx;
    if (!(gbp > 0) || !Number.isFinite(gbp)) return null;
    const days = sanitizeDays(est.days);
    const label = countryLabelText || country;
    const daysClause = days ? `, est. ${days} working days` : '';
    return `Delivery to ${label}: shipping from approx £${gbp.toFixed(2)}${daysClause}.`;
  } catch (e) {
    console.warn(`inbox freight line failed for ${country}: ${(e as Error).message}`);
    return null;
  }
}

/** CJ's logisticAging is a free-text range like "8-12" or "8~12 days". Keep only
 * a clean N or N-N day range; anything unexpected is dropped (claim-safe). */
function sanitizeDays(raw: string): string {
  const m = String(raw ?? '').replace(/[~–—]/g, '-').match(/^\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?/);
  if (!m) return '';
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('freight lookup timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
