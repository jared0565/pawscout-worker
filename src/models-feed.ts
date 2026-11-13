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

/** v3 holds { fetchedAt, models } (v1 and v2 held other shapes, so a new key
 *  means an old cache entry can never be misread as this one). */
export const FEED_CACHE_KEY = 'openrouter:models:v3';
const FEED_URL = 'https://openrouter.ai/api/v1/models';
/** A copy is fresh for a day; after that the next read fetches again. */
export const FEED_FRESH_MS = 86_400_000;
/** The copy is kept 30 days as the last good list (spec 5.11), for when
 *  OpenRouter cannot be reached or sends a list that is cut short. */
export const FEED_KEEP_DAYS = 30;
/** A list with fewer rows is not a whole catalogue (470 rows on 2026-11-13). */
export const MIN_FEED_ROWS = 100;
/** While the copy is younger than this, a fetch with under half its rows is
 *  refused as cut short. After it, only MIN_FEED_ROWS applies, so a real cut
 *  to OpenRouter's catalogue cannot freeze the menu on an ageing copy. */
export const FEED_SHRINK_WINDOW_MS = 3 * 86_400_000;

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

/** A list as read: `stale` when it is the last good copy, older than a day,
 *  because a fresh fetch failed or was refused as cut short. */
export interface Feed { models: FeedModel[]; fetchedAt: number; stale: boolean }

type FeedStore = Pick<TenantStore, 'getSearchCache' | 'putSearchCache'>;

/** The cached copy as stored under FEED_CACHE_KEY. */
export function feedCacheEntry(models: FeedModel[], fetchedAt: number): string {
  return JSON.stringify({ fetchedAt, models });
}

function readCopy(raw: string | null): { models: FeedModel[]; fetchedAt: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { fetchedAt?: unknown; models?: unknown };
    if (v && typeof v.fetchedAt === 'number' && Number.isFinite(v.fetchedAt) && Array.isArray(v.models) && v.models.length) {
      return { models: v.models as FeedModel[], fetchedAt: v.fetchedAt };
    }
  } catch { /* corrupt entry: treat as a miss */ }
  return null;
}

/** One fetch of the public endpoint (no key needed), reduced. null on a
 *  throw, a non-200 or no answer within timeoutMs. */
async function fetchFeed(fetchImpl: typeof fetch, timeoutMs: number): Promise<FeedModel[] | null> {
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
  return feed;
}

/**
 * The reduced feed for the menu and the save check (spec 5.11). A copy under a
 * day old is used as it is. Otherwise one fetch: a whole list replaces the
 * copy (kept 30 days); a failed fetch, or one refused as cut short (under
 * MIN_FEED_ROWS rows, or under half the rows of a copy younger than 3 days),
 * caches nothing and returns the old copy marked stale. null only when there
 * is no copy at all. Never throws.
 */
export async function readFeed(
  store: FeedStore,
  fetchImpl: typeof fetch = defaultFetch,
  timeoutMs: number = FEED_TIMEOUT_MS,
  nowMs: number = Date.now(),
): Promise<Feed | null> {
  try {
    const copy = readCopy(await store.getSearchCache(FEED_CACHE_KEY));
    if (copy && nowMs - copy.fetchedAt < FEED_FRESH_MS) return { ...copy, stale: false };
    const fetched = await fetchFeed(fetchImpl, timeoutMs);
    if (fetched && fetched.length) {
      const recentCopy = copy && nowMs - copy.fetchedAt < FEED_SHRINK_WINDOW_MS ? copy : null;
      const cutShort = fetched.length < MIN_FEED_ROWS || (recentCopy !== null && fetched.length * 2 < recentCopy.models.length);
      if (!cutShort) {
        await store.putSearchCache(FEED_CACHE_KEY, feedCacheEntry(fetched, nowMs), FEED_KEEP_DAYS);
        return { models: fetched, fetchedAt: nowMs, stale: false };
      }
      // Logged every time, with both counts, so a list stuck on refusal shows in Workers Logs.
      const age = copy ? `${Math.round((nowMs - copy.fetchedAt) / 3_600_000)}h` : 'none';
      console.warn(`models.feed.refused rows=${fetched.length} copy=${copy?.models.length ?? 0} copyAge=${age} (cut short: under ${MIN_FEED_ROWS} rows or under half a recent copy)`);
    }
    return copy ? { ...copy, stale: true } : null;
  } catch {
    return null;
  }
}

/** The feed for the daily watch: fresh only. The watch never judges a model
 *  delisted or retiring from an old copy, so a stale copy reads as null and
 *  the watch skips that day. */
export async function loadFeed(
  store: FeedStore,
  fetchImpl: typeof fetch = defaultFetch,
  timeoutMs: number = FEED_TIMEOUT_MS,
  nowMs: number = Date.now(),
): Promise<FeedModel[] | null> {
  const feed = await readFeed(store, fetchImpl, timeoutMs, nowMs);
  return feed && !feed.stale ? feed.models : null;
}
