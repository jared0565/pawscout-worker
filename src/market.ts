// src/market.ts
//
// Zero-LLM competitor market lookup (2026-07-10). The old cron path paid an LLM
// to BE a search engine: the OpenRouter web plugin injected ~200k tokens of page
// content per lookup (~$0.29 each, 98% of all LLM spend). This module replaces
// it with structured data + deterministic code:
//
//   eBay Browse API (free, official)  ->  candidates with REAL item + postage
//   deterministic title matcher       ->  confident estimate, zero tokens
//   tiny LLM title-classifier         ->  ONLY on ambiguous shortlists (~1k
//                                         tokens of titles, never page content)
//
// Ships DORMANT: ebayFromEnv() returns null until the EBAY_CLIENT_ID /
// EBAY_CLIENT_SECRET secrets exist, and callers keep their previous behavior.
// eBay UK marketplace sellers are the real price floor for CJ-class commodity
// goods, and shippingOptions is a structured field - a better delivered-price
// read than a model skimming pages ever was.

import type { Env } from './types';
import { defaultFetch } from './safe-fetch';

export interface MarketCandidate {
  title: string;
  itemGbp: number;
  deliveryGbp: number;   // 0 when the listing is free-postage (or none listed)
  deliveredGbp: number;  // itemGbp + deliveryGbp
  itemId?: string;       // source listing id (drives the seller-credibility lookup)
}

/** A structured market source. `search` returns null when the SOURCE failed
 *  (auth/network/HTTP) - callers may then fall back; an empty array means the
 *  source answered and genuinely found nothing. */
export interface MarketSource {
  name: string; // e.g. 'ebay.co.uk'
  search(query: string): Promise<MarketCandidate[] | null>;
  /** Registered-country lookup for listing sellers (owner rule 2026-07-18:
   *  China-registered direct traders are not a credible market reference even
   *  when their stock sits in a GB warehouse). Returns itemId -> ISO country
   *  of the seller's registered legal address, or null per item when the
   *  source does not disclose it (individual sellers). Optional: sources
   *  without seller data simply skip the exclusion. */
  sellerCountries?(itemIds: string[]): Promise<Map<string, string | null>>;
}

// --- Title normalisation + similarity (pure, deterministic, tested) ---

// Words that carry no product identity; never let them drive a match.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'with', 'for', 'of', 'to', 'in', 'on', 'by', 'per',
  'new', 'hot', 'sale', 'uk', 'free', 'set', 'pet', 'pets', 'premium', 'portable',
  'high', 'quality', 'multi', 'anti', 'pro', 'plus', 'style', 'design', 'colour', 'color'
]);

/** Lowercased content tokens (stopwords + 1-char noise stripped). */
export function titleTokens(title: string): string[] {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+(\.\d+)?$/.test(t));
}

/** Normalised number+unit pairs ("800ml", "3.2 L" -> "3.2l", "pack of 2" -> "2pack",
 *  "x3" -> "3pack") - the strongest disambiguators between size/quantity variants. */
export function numericUnits(title: string): string[] {
  const s = (title || '').toLowerCase();
  const out = new Set<string>();
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ml|l|litre|liter|cm|mm|m|kg|g|inch|in|ft)\b/g)) {
    const unit = m[2] === 'litre' || m[2] === 'liter' ? 'l' : m[2] === 'in' ? 'inch' : m[2];
    out.add(`${m[1]}${unit}`);
  }
  for (const m of s.matchAll(/(?:pack of |x\s?)(\d+)\b|(\d+)\s?(?:pack|pcs|pieces)\b/g)) {
    out.add(`${m[1] ?? m[2]}pack`);
  }
  return [...out];
}

/** Similarity 0..1: Dice overlap of content tokens, with numeric-unit pairs as
 *  hard evidence - agreement rewards, disagreement punishes (an 800ml bottle is
 *  NOT a 500ml bottle at a different price point). */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  let score = (2 * common) / (ta.size + tb.size);
  const ua = numericUnits(a);
  const ub = new Set(numericUnits(b));
  if (ua.length && ub.size) {
    const agree = ua.filter((u) => ub.has(u)).length;
    if (agree > 0) score = Math.min(1, score + 0.15);
    else score = Math.max(0, score - 0.2); // both sized, none agree -> likely a different variant
  }
  return score;
}

/** Search keywords from our (already de-branded) title: the informative tokens,
 *  capped so the query stays a keyword search, not a sentence. */
export function buildMarketQuery(title: string): string {
  return titleTokens(title).slice(0, 8).join(' ');
}

// --- Deterministic candidate matching ---

export type MarketMatch =
  | { kind: 'match'; estimateGbp: number; confidence: 'high' | 'medium'; matched: number; candidates: MarketCandidate[] }
  | { kind: 'ambiguous'; shortlist: MarketCandidate[] }
  | { kind: 'none' };

const STRONG_SIM = 0.6;
const WEAK_SIM = 0.4;
const SHORTLIST_MAX = 15;

/** The credible market reference: sort ascending, drop pathological outliers
 *  (below 55% of the median - junk, parts, wrong item), take the MEDIAN of the
 *  survivors (mean of the middle pair on an even count). Owner recalibration
 *  2026-07-12: the reference is the TYPICAL credible delivered price, not the
 *  single cheapest listing - eBay's cheapest credible seller proved a far
 *  harsher reference than the shop competes against in practice. */
export function credibleMarketGbp(delivered: number[]): number {
  const sorted = [...delivered].sort((x, y) => x - y);
  const rawMedian = sorted[Math.floor(sorted.length / 2)];
  const kept = sorted.filter((v) => v >= 0.55 * rawMedian);
  const s = kept.length ? kept : sorted;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Deterministically match candidates against our title. Plausibility band first
 * (a delivered price wildly off ours is a multipack/part/wrong item), then
 * similarity tiers: >=3 strong matches = high confidence, 2 = medium, else an
 * ambiguous shortlist for the tiny LLM classifier, or none.
 */
export function matchCandidates(ourTitle: string, ourRetailGbp: number, candidates: MarketCandidate[]): MarketMatch {
  const plausible = candidates.filter((c) =>
    c.deliveredGbp > 0
    && (!Number.isFinite(ourRetailGbp) || ourRetailGbp <= 0 || (c.deliveredGbp >= 0.2 * ourRetailGbp && c.deliveredGbp <= 3.5 * ourRetailGbp))
  );
  if (!plausible.length) return { kind: 'none' };

  const scored = plausible
    .map((c) => ({ c, sim: titleSimilarity(ourTitle, c.title) }))
    .sort((a, b) => b.sim - a.sim);
  const strong = scored.filter((s) => s.sim >= STRONG_SIM).map((s) => s.c);

  if (strong.length >= 2) {
    return {
      kind: 'match',
      estimateGbp: Math.round(credibleMarketGbp(strong.map((c) => c.deliveredGbp)) * 100) / 100,
      confidence: strong.length >= 3 ? 'high' : 'medium',
      matched: strong.length,
      candidates: strong
    };
  }
  const weak = scored.filter((s) => s.sim >= WEAK_SIM).map((s) => s.c);
  if (weak.length >= 2) return { kind: 'ambiguous', shortlist: weak.slice(0, SHORTLIST_MAX) };
  return { kind: 'none' };
}

// --- eBay Browse API source (application token, EBAY_GB marketplace) ---

const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

interface EbayItemSummary {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  shippingOptions?: { shippingCost?: { value?: string; currency?: string } }[];
  seller?: { username?: string };
}

/** Sellers whose listings are never a credible market reference (owner rule
 *  2026-07-12: Temu's own eBay storefront undercuts below any price a real UK
 *  shop competes against). Matched against the listing's seller username. */
const BLOCKED_SELLERS = /temu/i;

/** Module-level token cache: worker isolates persist between requests, so one
 *  token serves many sweeps. Refreshed 60s before expiry. */
let ebayToken: { value: string; expiresAt: number } | null = null;

export class EbaySource implements MarketSource {
  readonly name = 'ebay.co.uk';
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = defaultFetch
  ) {}

  private async token(): Promise<string | null> {
    if (ebayToken && ebayToken.expiresAt > Date.now() + 60_000) return ebayToken.value;
    try {
      const resp = await this.fetchImpl(EBAY_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope')
      });
      if (!resp.ok) { console.warn(`ebay token failed: HTTP ${resp.status}`); return null; }
      const data = (await resp.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) return null;
      ebayToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000 };
      return ebayToken.value;
    } catch (e) {
      console.warn(`ebay token error: ${(e as Error).message}`);
      return null;
    }
  }

  /** GB-located, new, fixed-price listings for the keywords. null = source
   *  failure (caller may fall back); [] = answered, nothing found. */
  async search(query: string): Promise<MarketCandidate[] | null> {
    const tok = await this.token();
    if (!tok) return null;
    const url = `${EBAY_BROWSE_URL}?q=${encodeURIComponent(query)}&limit=24&filter=${encodeURIComponent('buyingOptions:{FIXED_PRICE},itemLocationCountry:GB,conditions:{NEW}')}`;
    try {
      const resp = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${tok}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
          'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=GB'
        }
      });
      if (!resp.ok) { console.warn(`ebay search failed: HTTP ${resp.status}`); return null; }
      const data = (await resp.json()) as { itemSummaries?: EbayItemSummary[] };
      const out: MarketCandidate[] = [];
      for (const it of data.itemSummaries ?? []) {
        if (!it.title || it.price?.currency !== 'GBP') continue;
        if (BLOCKED_SELLERS.test(it.seller?.username ?? '')) continue;
        const itemGbp = Number(it.price.value);
        if (!Number.isFinite(itemGbp) || itemGbp <= 0) continue;
        // First shipping option when priced in GBP; a missing/unpriced option is
        // treated as 0 (most GB listings are free-postage; understating delivery
        // biases our estimate LOW, which our undercut policy treats conservatively).
        const ship = it.shippingOptions?.[0]?.shippingCost;
        const deliveryGbp = ship && ship.currency === 'GBP' && Number.isFinite(Number(ship.value)) ? Number(ship.value) : 0;
        out.push({
          title: it.title,
          itemGbp: Math.round(itemGbp * 100) / 100,
          deliveryGbp: Math.round(deliveryGbp * 100) / 100,
          deliveredGbp: Math.round((itemGbp + deliveryGbp) * 100) / 100,
          ...(it.itemId ? { itemId: it.itemId } : {})
        });
      }
      return out;
    } catch (e) {
      console.warn(`ebay search error: ${(e as Error).message}`);
      return null;
    }
  }

  /** Registered-country per listing seller via the full-item read: UK/EU law
   *  obliges BUSINESS sellers to disclose a registered legal address, exposed
   *  as seller.sellerLegalInfo.sellerProvidedLegalAddress.country on getItem
   *  (nested inside the seller container, NOT top-level). An individual seller
   *  (no legal info) or a failed read maps to null (unknown, never excluded).
   *  Called only for the handful of MATCHED candidates, so the extra reads
   *  stay tiny against the Browse quota. */
  async sellerCountries(itemIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const tok = await this.token();
    for (const id of itemIds) {
      if (!tok) { out.set(id, null); continue; }
      try {
        const resp = await this.fetchImpl(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${tok}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
        });
        if (!resp.ok) { out.set(id, null); continue; }
        const data = (await resp.json().catch(() => null)) as {
          seller?: { sellerLegalInfo?: { sellerProvidedLegalAddress?: { country?: string } } };
        } | null;
        const c = data?.seller?.sellerLegalInfo?.sellerProvidedLegalAddress?.country;
        out.set(id, typeof c === 'string' && c ? c.toUpperCase() : null);
      } catch {
        out.set(id, null);
      }
    }
    return out;
  }
}

/** The market source for this deployment, or null while the eBay secrets are
 *  absent (feature dormant; callers keep their legacy behavior). */
export function ebayFromEnv(env: Env, fetchImpl: typeof fetch = defaultFetch): MarketSource | null {
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) return null;
  return new EbaySource(env.EBAY_CLIENT_ID, env.EBAY_CLIENT_SECRET, fetchImpl);
}
