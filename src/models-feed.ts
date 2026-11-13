import type { TenantStore } from './tenant-store';
import { defaultFetch } from './safe-fetch';
import { EFFORT_LEVELS } from './types';

/**
 * One OpenRouter model, reduced to what the menu, the save check and the watch
 * read (spec 5.1). Prices are $ per million tokens; `created` is unix seconds.
 */
export interface FeedModel {
  id: string;
  canonicalSlug: string | null;
  name: string;
  created: number;
  expiresOn: string | null;            // expiration_date, 'YYYY-MM-DD'
  inputs: string[];                    // architecture.input_modalities
  outputs: string[];                   // architecture.output_modalities
  promptPriceM: number | null;
  completionPriceM: number | null;
  json: boolean;                       // supported_parameters has response_format or structured_outputs
  efforts: string[];                   // reasoning.supported_efforts ([] when absent)
  defaultEffort: string | null;        // reasoning.default_effort
}

/** v2: the v1 key ('openrouter:models') held a different shape, so a new key
 *  means an old cache entry can never be misread as this one. */
export const FEED_CACHE_KEY = 'openrouter:models:v2';
const FEED_URL = 'https://openrouter.ai/api/v1/models';
const FEED_TTL_DAYS = 1;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** $ per token (string or number) -> $ per million, rounded to 6 decimals:
 *  Number('0.0000001') * 1e6 is 0.09999999999999999 in JavaScript, and the
 *  menu and the price ratio must see 0.1. null when it does not parse. */
function perMillion(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e12) / 1e6 : null;
}

/** An expiration date as YYYY-MM-DD: the date part of an ISO string, else any
 *  other date string read in UTC; null when it is not a readable date. A full
 *  timestamp once reached the watch unparsed and switched its alert off. */
function isoDay(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** Reduce the /api/v1/models payload. Never throws: a malformed row is skipped,
 *  an unparseable price becomes null, unknown effort names are dropped. */
export function reduceFeed(payload: unknown): FeedModel[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const out: FeedModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, any>;
    if (typeof r.id !== 'string' || !Number.isFinite(r.created)) continue;
    const params = strings(r.supported_parameters);
    out.push({
      id: r.id,
      canonicalSlug: typeof r.canonical_slug === 'string' ? r.canonical_slug : null,
      name: typeof r.name === 'string' ? r.name : r.id,
      created: r.created,
      expiresOn: isoDay(r.expiration_date),
      inputs: strings(r.architecture?.input_modalities),
      outputs: strings(r.architecture?.output_modalities),
      promptPriceM: perMillion(r.pricing?.prompt),
      completionPriceM: perMillion(r.pricing?.completion),
      json: params.includes('response_format') || params.includes('structured_outputs'),
      efforts: strings(r.reasoning?.supported_efforts).filter((e) => (EFFORT_LEVELS as readonly string[]).includes(e)),
      defaultEffort: typeof r.reasoning?.default_effort === 'string' ? r.reasoning.default_effort : null,
    });
  }
  return out;
}

/** Input plus output price per million, or null when either is unknown. */
export function feedCost(m: FeedModel): number | null {
  if (m.promptPriceM === null || m.completionPriceM === null) return null;
  return Math.round((m.promptPriceM + m.completionPriceM) * 1e6) / 1e6;
}

/** A feed request that has not answered by then is abandoned (and aborted):
 *  a model save reads the feed, so it must not hang the console. */
export const FEED_TIMEOUT_MS = 10_000;

/**
 * The reduced feed: from the per-shop cache when fresh, else one fetch of the
 * public endpoint (no key needed), cached for a day. Never throws. null means
 * "unavailable": a failed fetch, a non-200, a payload with no usable rows, or
 * no answer within timeoutMs, none of which is cached, so the next call tries
 * again.
 */
export async function loadFeed(
  store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache'>,
  fetchImpl: typeof fetch = defaultFetch,
  timeoutMs: number = FEED_TIMEOUT_MS,
): Promise<FeedModel[] | null> {
  try {
    const cached = await store.getSearchCache(FEED_CACHE_KEY);
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length) return parsed as FeedModel[];
      } catch { /* corrupt entry: treat as a miss */ }
    }
    // Raced as well as aborted, so a fetch that ignores the signal (or a body
    // that stalls mid-read) still gives up on time. The request never rejects
    // past this point, so a late abort error is not an unhandled rejection.
    const controller = new AbortController();
    const request = (async () => {
      const res = await fetchImpl(FEED_URL, { signal: controller.signal });
      return res.ok ? reduceFeed(await res.json()) : null;
    })().catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
    const feed = await Promise.race([request, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (!feed || !feed.length) return null;
    await store.putSearchCache(FEED_CACHE_KEY, JSON.stringify(feed), FEED_TTL_DAYS);
    return feed;
  } catch {
    return null;
  }
}
