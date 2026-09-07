/**
 * Traffic quality (2026-09-05): how much of the store's traffic is human.
 *
 * WHY THIS EXISTS. A cold pitch on 2026-09-04 said "your site has a high bounce
 * rate". Measured, it was true as a number (91% over 90 days) and false as a
 * diagnosis: 214 of the 454 bounced sessions came from HeadlessChrome, another
 * 16 from named crawlers, and 455 of 500 sessions lasted 0 seconds. Shopify's
 * analytics cannot exclude those, so the only honest bounce figure is one
 * computed on human-looking traffic. This module computes it from the same
 * session table, through the worker's own token (the worker is the system).
 *
 * THREE BUCKETS, and what each can and cannot claim:
 * - automated: the browser NAMES itself as automation (HeadlessChrome, *bot,
 *   *spider, *crawler, *indexer, curl and friends). Provable from the row.
 * - engaged: a human-looking browser with more than one pageview. A bot with a
 *   normal user agent that clicks around would land here; rare, and it is the
 *   conservative direction (it makes the human bounce rate LOWER, not higher).
 * - single-page, unattributed: a human-looking browser that viewed one page.
 *   A real one-page visit and a bot with a normal user agent are
 *   indistinguishable in this table, so the label says unknown; it never says
 *   "shoppers left".
 *
 * Reads through shopifyqlQuery (GraphQL Admin API, available since 2025-10),
 * which requires the read_reports scope. A denial is reported as scope_missing
 * with the scope named, never as "no traffic": an unreachable API and a
 * missing scope are different facts (same rule as shopify-scopes.ts).
 */
import type { AdminGraphql } from './shopify-admin';

export const TRAFFIC_QUALITY_SCOPE = 'read_reports';
export const TRAFFIC_WINDOWS = [30, 90] as const;

export type BrowserClass = 'automated' | 'human-looking';

/** Automation is named by the browser string itself. Anything else, including
 *  Shopify's catch-all "Other", is human-LOOKING: not provably human. */
export function classifyBrowser(name: string | null | undefined): BrowserClass {
  const n = (name ?? '').trim();
  if (n === '') return 'human-looking';
  if (/headless|bot\b|spider|crawler|indexer|phantomjs|python-requests|\bcurl\b|wget|externalhit|slurp|scrapy|httpclient|okhttp|java\/|go-http/i.test(n)) return 'automated';
  return 'human-looking';
}

export function buildTrafficQuery(days: number): string {
  return `FROM sessions SHOW sessions, sessions_with_cart_additions GROUP BY session_device_browser, session_bounced SINCE -${days}d UNTIL today`;
}

const SHOPIFYQL = `query pawscoutTrafficQuality($q: String!) {
  shopifyqlQuery(query: $q) {
    tableData { columns { name dataType } rows }
    parseErrors
  }
}`;

export interface TrafficRow { browser: string; bounced: boolean; sessions: number; cartAdds: number }

/** ShopifyqlTableData.rows is typed JSON in the Admin API and is DOCUMENTED as
 *  an array of objects keyed by column name. The analytics connector used to
 *  measure this feature returns arrays of cells instead. Both are read; the
 *  first live call (2026-09-05) answered "0 sessions" because only the array
 *  shape was handled, which is why a table must never be assumed to be one. */
interface TableData { columns: { name: string }[]; rows: unknown[] }

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function bool(v: unknown): boolean {
  return v === true || String(v ?? '').trim().toLowerCase() === 'true';
}

/** Columns are mapped by NAME (ShopifyQL's column order is not a contract). A
 *  cell that is not a number counts as 0; the table never throws. */
export function parseTrafficTable(table: TableData): TrafficRow[] {
  const idx = (name: string) => table.columns.findIndex((c) => c.name === name);
  const iBrowser = idx('session_device_browser');
  const iBounced = idx('session_bounced');
  const iSessions = idx('sessions');
  const iCarts = idx('sessions_with_cart_additions');
  const cell = (r: unknown, name: string, i: number): unknown => {
    if (Array.isArray(r)) return i >= 0 ? r[i] : undefined;
    if (r && typeof r === 'object') return (r as Record<string, unknown>)[name];
    return undefined;
  };
  return (table.rows ?? []).map((r) => ({
    browser: String(cell(r, 'session_device_browser', iBrowser) ?? ''),
    bounced: bool(cell(r, 'session_bounced', iBounced)),
    sessions: num(cell(r, 'sessions', iSessions)),
    cartAdds: num(cell(r, 'sessions_with_cart_additions', iCarts)),
  }));
}

export interface TrafficSummary {
  days: number;
  sessions: number;
  automated: number;
  engaged: number;
  singlePage: number;
  cartAdds: number;
  /** automated / sessions, in percent (one decimal); null when there are no sessions. */
  automatedShare: number | null;
  /** What Shopify shows: bounced / sessions, all traffic. */
  rawBounceRate: number | null;
  /** singlePage / (engaged + singlePage): the bounce rate on human-looking traffic. */
  humanBounceRate: number | null;
  topAutomated: { browser: string; sessions: number }[];
}

function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function summarizeTraffic(days: number, rows: TrafficRow[]): TrafficSummary {
  let sessions = 0, automated = 0, engaged = 0, singlePage = 0, cartAdds = 0, bounced = 0;
  const byBot = new Map<string, number>();
  for (const r of rows) {
    sessions += r.sessions;
    cartAdds += r.cartAdds;
    if (r.bounced) bounced += r.sessions;
    if (classifyBrowser(r.browser) === 'automated') {
      automated += r.sessions;
      byBot.set(r.browser, (byBot.get(r.browser) ?? 0) + r.sessions);
    } else if (r.bounced) singlePage += r.sessions;
    else engaged += r.sessions;
  }
  const topAutomated = [...byBot.entries()]
    .map(([browser, n]) => ({ browser, sessions: n }))
    .sort((a, b) => b.sessions - a.sessions || a.browser.localeCompare(b.browser))
    .slice(0, 5);
  return {
    days, sessions, automated, engaged, singlePage, cartAdds,
    automatedShare: pct(automated, sessions),
    rawBounceRate: pct(bounced, sessions),
    humanBounceRate: pct(singlePage, engaged + singlePage),
    topAutomated,
  };
}

export type TrafficQualityResult =
  | { ok: true; windows: TrafficSummary[]; at: string }
  | { ok: false; reason: 'not_connected' | 'scope_missing' | 'query_error' | 'unavailable'; error: string; scope?: typeof TRAFFIC_QUALITY_SCOPE };

function isReportsScopeDenial(message: string): boolean {
  return /access denied|ACCESS_DENIED|not approved|required access|read_reports/i.test(message);
}

/** One ShopifyQL query per window. Never throws: every failure is a typed
 *  reason the console can render as a state rather than an error. */
export async function getTrafficQuality(
  admin: AdminGraphql | null, windows: readonly number[] = TRAFFIC_WINDOWS
): Promise<TrafficQualityResult> {
  if (!admin) return { ok: false, reason: 'not_connected', error: 'Shopify is not connected for this shop' };
  const out: TrafficSummary[] = [];
  for (const days of windows) {
    let data: { shopifyqlQuery?: { tableData?: TableData | null; parseErrors?: string[] | null } };
    // Upstream text is logged here and never returned: the reason code is what
    // the console renders, and a vendor error can carry operational detail that
    // has no business on a client (aramid review 3c22be0b).
    try {
      data = await admin(SHOPIFYQL, { q: buildTrafficQuery(days) }) as typeof data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[traffic-quality] sessions query (${days}d) failed: ${msg}`);
      if (isReportsScopeDenial(msg)) {
        return { ok: false, reason: 'scope_missing', scope: TRAFFIC_QUALITY_SCOPE, error: `Shopify has not granted the ${TRAFFIC_QUALITY_SCOPE} scope to this app yet` };
      }
      return { ok: false, reason: 'unavailable', error: 'Shopify analytics could not be reached; try again in a few minutes' };
    }
    const q = data.shopifyqlQuery;
    const parseErrors = (q?.parseErrors ?? []).filter((p) => typeof p === 'string' && p.length > 0);
    if (parseErrors.length > 0) {
      console.warn(`[traffic-quality] sessions query (${days}d) rejected: ${parseErrors.join('; ')}`);
      return { ok: false, reason: 'query_error', error: 'Shopify rejected the sessions query; the worker logs carry the detail' };
    }
    if (!q?.tableData) return { ok: false, reason: 'query_error', error: 'Shopify returned no table for the sessions query' };
    out.push(summarizeTraffic(days, parseTrafficTable(q.tableData)));
  }
  return { ok: true, windows: out, at: new Date().toISOString() };
}
