/**
 * Traffic activity (2026-10-07): what the store's visitors did, day by day.
 *
 * WHY THIS EXISTS. A cold pitch on 2026-09-04 said "your site has a high bounce
 * rate". Measured, it was true as a number and false as a diagnosis: most of the
 * bounced sessions were automation. The first version of this module (09-05)
 * answered with two fixed windows of totals; this one answers with the days
 * themselves, because a total hides that 242 of a month's sessions came on one
 * day from one crawler.
 *
 * WHO IS A PERSON. A session is AUTOMATED when Shopify labels it a bot
 * (human_or_bot_session) OR the browser names itself as automation
 * (HeadlessChrome, *bot, *spider, curl and friends). Measured 2026-10-07 over 90
 * days: Shopify labelled 96 HeadlessChrome sessions "human" and 101 ordinary
 * Chrome sessions "bot", so each signal misses what the other catches. Every
 * other session is a PERSON, split into engaged (more than one page) and
 * single-page. A person here is "not provably automated", never "a shopper".
 *
 * Shopping actions (cart additions, reached checkout, completed checkout) count
 * PEOPLE only: on 2026-10-01, 44 crawler sessions "reached checkout".
 *
 * Reads through shopifyqlQuery (GraphQL Admin API), which requires the
 * read_reports scope. A denial is reported as scope_missing with the scope
 * named, never as "no traffic": an unreachable API and a missing scope are
 * different facts (same rule as shopify-scopes.ts).
 */
import type { AdminGraphql } from './shopify-admin';

export const TRAFFIC_QUALITY_SCOPE = 'read_reports';
export const ACTIVITY_WINDOWS = [7, 30, 90] as const;
export type ActivityWindow = (typeof ACTIVITY_WINDOWS)[number];
export const DAILY_LIMIT = 5000;
const BREAKDOWN_LIMIT = 1000;

export type BrowserClass = 'automated' | 'human-looking';

/** Automation named by the browser string itself. Anything else, including
 *  Shopify's catch-all "Other", is human-LOOKING: not provably human. */
export function classifyBrowser(name: string | null | undefined): BrowserClass {
  const n = (name ?? '').trim();
  if (n === '') return 'human-looking';
  if (/headless|bot\b|spider|crawler|indexer|phantomjs|python-requests|\bcurl\b|wget|externalhit|slurp|scrapy|httpclient|okhttp|java\/|go-http/i.test(n)) return 'automated';
  return 'human-looking';
}

/** Shopify's bot label OR the browser's own name: either one makes it automated. */
export function isAutomated(label: unknown, browser: unknown): boolean {
  if (String(label ?? '').trim().toLowerCase() === 'bot') return true;
  return classifyBrowser(typeof browser === 'string' ? browser : null) === 'automated';
}

/** The window is written into the query text, so only the fixed set passes. */
export function parseWindow(v: unknown): ActivityWindow | null {
  return typeof v === 'number' && (ACTIVITY_WINDOWS as readonly number[]).includes(v) ? (v as ActivityWindow) : null;
}

/** Exactly N days ending today (today counts as one), in the shop's calendar. */
export function activityQueries(days: ActivityWindow): { daily: string; referrers: string; landing: string } {
  const range = `SINCE -${days - 1}d UNTIL today`;
  const who = 'human_or_bot_session, session_device_browser';
  return {
    daily: `FROM sessions SHOW sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout GROUP BY ${who}, session_bounced TIMESERIES day ${range} ORDER BY day ASC LIMIT ${DAILY_LIMIT}`,
    referrers: `FROM sessions SHOW sessions GROUP BY referrer_source, ${who} ${range} ORDER BY sessions DESC LIMIT ${BREAKDOWN_LIMIT}`,
    landing: `FROM sessions SHOW sessions GROUP BY landing_page_path, ${who} ${range} ORDER BY sessions DESC LIMIT ${BREAKDOWN_LIMIT}`,
  };
}

const SHOPIFYQL = `query pawscoutTrafficActivity($q: String!) {
  shopifyqlQuery(query: $q) {
    tableData { columns { name dataType } rows }
    parseErrors
  }
}`;

/** ShopifyqlTableData.rows is typed JSON in the Admin API and is DOCUMENTED as
 *  an array of objects keyed by column name. The analytics connector returns
 *  arrays of cells instead. Both are read, by column NAME (column order is not
 *  a contract); the first live call (2026-09-05) answered "0 sessions" because
 *  only the array shape was handled. */
interface TableData { columns: { name: string }[]; rows: unknown[] }
type Row = Record<string, unknown>;

export function tableRows(table: TableData): Row[] {
  const names = (table.columns ?? []).map((c) => c.name);
  return (table.rows ?? []).map((r) => {
    if (Array.isArray(r)) return Object.fromEntries(names.map((n, i) => [n, r[i]]));
    return r && typeof r === 'object' ? { ...(r as Row) } : {};
  });
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function bool(v: unknown): boolean {
  return v === true || String(v ?? '').trim().toLowerCase() === 'true';
}
function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/** N calendar days ending on lastDay (YYYY-MM-DD), oldest first. */
export function enumerateDays(lastDay: string, n: number): string[] {
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86400_000).toISOString().slice(0, 10));
}

export interface DayActivity {
  day: string;
  people: number; engaged: number; singlePage: number; automated: number;
  cartAdds: number; reachedCheckout: number; completedCheckout: number;
}
export interface ActivityTotals {
  sessions: number; people: number; engaged: number; singlePage: number; automated: number;
  cartAdds: number; reachedCheckout: number; completedCheckout: number;
  /** automated / sessions, percent with one decimal; null with no sessions. */
  automatedShare: number | null;
  /** single-page / people: the bounce rate of people only. */
  peopleBounceRate: number | null;
  /** bounced / sessions, all traffic: what Shopify shows. */
  rawBounceRate: number | null;
}

/** Every day of the window, ending on the last day Shopify reported (its
 *  TIMESERIES emits the range end even when empty, in the shop's own calendar);
 *  `today` (UTC) only when Shopify reported no day at all. */
export function buildDailySeries(rows: Row[], days: ActivityWindow, today: string): {
  series: DayActivity[]; totals: ActivityTotals; topAutomated: { browser: string; sessions: number }[];
} {
  const dayOf = (r: Row) => String(r.day ?? '').slice(0, 10);
  const reported = rows.map(dayOf).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const last = reported.length ? reported[reported.length - 1] : today;
  const series = enumerateDays(last, days).map((day): DayActivity =>
    ({ day, people: 0, engaged: 0, singlePage: 0, automated: 0, cartAdds: 0, reachedCheckout: 0, completedCheckout: 0 }));
  const byDay = new Map(series.map((d) => [d.day, d]));
  let sessions = 0, bounced = 0;
  const bots = new Map<string, number>();
  for (const r of rows) {
    const n = num(r.sessions);
    const d = byDay.get(dayOf(r));
    if (!n || !d) continue;
    sessions += n;
    if (bool(r.session_bounced)) bounced += n;
    if (isAutomated(r.human_or_bot_session, r.session_device_browser)) {
      d.automated += n;
      const b = String(r.session_device_browser ?? 'Unknown');
      bots.set(b, (bots.get(b) ?? 0) + n);
      continue;
    }
    d.people += n;
    if (bool(r.session_bounced)) d.singlePage += n; else d.engaged += n;
    d.cartAdds += num(r.sessions_with_cart_additions);
    d.reachedCheckout += num(r.sessions_that_reached_checkout);
    d.completedCheckout += num(r.sessions_that_completed_checkout);
  }
  const sum = (k: keyof Omit<DayActivity, 'day'>) => series.reduce((a, d) => a + d[k], 0);
  const people = sum('people'), singlePage = sum('singlePage'), automated = sum('automated');
  return {
    series,
    totals: {
      sessions, people, engaged: sum('engaged'), singlePage, automated,
      cartAdds: sum('cartAdds'), reachedCheckout: sum('reachedCheckout'), completedCheckout: sum('completedCheckout'),
      automatedShare: pct(automated, sessions), peopleBounceRate: pct(singlePage, people), rawBounceRate: pct(bounced, sessions),
    },
    topAutomated: [...bots.entries()].map(([browser, s]) => ({ browser, sessions: s }))
      .sort((a, b) => b.sessions - a.sessions || a.browser.localeCompare(b.browser)).slice(0, 5),
  };
}

/** People per referrer source or landing page, largest first. */
export function topPeople(rows: Row[], key: 'referrer_source' | 'landing_page_path', limit: number): { label: string; people: number }[] {
  const by = new Map<string, number>();
  for (const r of rows) {
    const n = num(r.sessions);
    if (!n || isAutomated(r.human_or_bot_session, r.session_device_browser)) continue;
    const label = String(r[key] ?? '').trim() || 'unknown';
    by.set(label, (by.get(label) ?? 0) + n);
  }
  return [...by.entries()].map(([label, people]) => ({ label, people }))
    .sort((a, b) => b.people - a.people || a.label.localeCompare(b.label)).slice(0, limit);
}

export interface TrafficActivity {
  days: ActivityWindow; from: string; to: string;
  series: DayActivity[]; totals: ActivityTotals;
  referrers: { label: string; people: number }[];
  landing: { label: string; people: number }[];
  topAutomated: { browser: string; sessions: number }[];
  /** A table came back at its row limit: totals may be short, and the card says so. */
  truncated: boolean;
}

export type TrafficActivityResult =
  | { ok: true; activity: TrafficActivity; at: string }
  | { ok: false; reason: 'not_connected' | 'scope_missing' | 'query_error' | 'unavailable'; error: string; scope?: typeof TRAFFIC_QUALITY_SCOPE };

type Failure = Extract<TrafficActivityResult, { ok: false }>;

function isReportsScopeDenial(message: string): boolean {
  return /access denied|ACCESS_DENIED|not approved|required access|read_reports/i.test(message);
}

/** One ShopifyQL read. Upstream text is logged and never returned: the reason
 *  code is what the console renders, and a vendor error can carry operational
 *  detail that has no business on a client (aramid review 3c22be0b). */
async function readTable(admin: AdminGraphql, label: string, q: string): Promise<TableData | Failure> {
  let data: { shopifyqlQuery?: { tableData?: TableData | null; parseErrors?: string[] | null } };
  try {
    data = await admin(SHOPIFYQL, { q }) as typeof data;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[traffic-activity] ${label} query failed: ${msg}`);
    if (isReportsScopeDenial(msg)) {
      return { ok: false, reason: 'scope_missing', scope: TRAFFIC_QUALITY_SCOPE, error: `Shopify has not granted the ${TRAFFIC_QUALITY_SCOPE} scope to this app yet` };
    }
    return { ok: false, reason: 'unavailable', error: 'Shopify analytics could not be reached; try again in a few minutes' };
  }
  const parseErrors = (data.shopifyqlQuery?.parseErrors ?? []).filter((p) => typeof p === 'string' && p.length > 0);
  if (parseErrors.length > 0) {
    console.warn(`[traffic-activity] ${label} query rejected: ${parseErrors.join('; ')}`);
    return { ok: false, reason: 'query_error', error: 'Shopify rejected the sessions query; the worker logs carry the detail' };
  }
  const table = data.shopifyqlQuery?.tableData;
  if (!table) return { ok: false, reason: 'query_error', error: 'Shopify returned no table for the sessions query' };
  return table;
}

/** The daily series and the two people-only breakdowns for one window. Never
 *  throws: every failure is a typed reason the console renders as a state. */
export async function getTrafficActivity(admin: AdminGraphql | null, days: ActivityWindow, now: Date = new Date()): Promise<TrafficActivityResult> {
  if (!admin) return { ok: false, reason: 'not_connected', error: 'Shopify is not connected for this shop' };
  const q = activityQueries(days);
  const daily = await readTable(admin, 'daily', q.daily);
  if ('ok' in daily) return daily;
  const referrers = await readTable(admin, 'referrers', q.referrers);
  if ('ok' in referrers) return referrers;
  const landing = await readTable(admin, 'landing', q.landing);
  if ('ok' in landing) return landing;
  const { series, totals, topAutomated } = buildDailySeries(tableRows(daily), days, now.toISOString().slice(0, 10));
  return {
    ok: true,
    at: now.toISOString(),
    activity: {
      days, from: series[0].day, to: series[series.length - 1].day, series, totals,
      referrers: topPeople(tableRows(referrers), 'referrer_source', 6),
      landing: topPeople(tableRows(landing), 'landing_page_path', 8),
      topAutomated,
      truncated: (daily.rows ?? []).length >= DAILY_LIMIT
        || (referrers.rows ?? []).length >= BREAKDOWN_LIMIT || (landing.rows ?? []).length >= BREAKDOWN_LIMIT,
    },
  };
}
