import type { DayRange } from '../logistics';

/**
 * Freight-grounded delivery replies.
 *
 * When a customer asks about shipping to a confidently-derived destination, the
 * drafter reads the SYNCED CJ logistics matrix from D1 (NO live CJ call) and
 * appends a single claim-safe, TIME-ONLY line. The figure is injected
 * DETERMINISTICALLY in code — the LLM never emits it (standing rule: the model
 * never states prices/SKUs/variant ids/discounts/dates).
 *
 * Governing rule [[customer-facing-only-real-defensible]]: only surface a real,
 * defensible number. The matrix row must be present AND fresh (the accessor
 * enforces staleness) and the destination unambiguous; on ANY doubt we return null
 * and the drafter falls back to "we can ship there — we'll confirm the timeframe".
 * Never throws. Price is omitted (customer shipping is the store's flat card, not
 * CJ-derived); the line is delivery-time only.
 */

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
 * - GB/UK is recognised and returns 'GB'; the caller reads the CN->GB matrix row
 *   like any other destination (the drafter grounds UK delivery in D1 too).
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

/**
 * Format ONE claim-safe, TIME-ONLY delivery line from the synced-matrix order->door
 * band (CALENDAR days, produced by doorToDoorBand). Price is deliberately omitted
 * (flat decoupled store rates). Null band → null so the caller keeps the safe hedge.
 * Pure.
 *
 * @returns e.g. "Delivery to France: estimated 11-19 days."
 */
export function buildShippingLine(label: string, band: DayRange | null): string | null {
  if (!band) return null;
  const range = band.min === band.max ? `${band.min}` : `${band.min}-${band.max}`;
  return `Delivery to ${label}: estimated ${range} days.`;
}
