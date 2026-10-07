/// <reference types="@cloudflare/vitest-pool-workers" />
// Traffic activity (2026-10-07): what the store's visitors did, day by day.
// Shopify's own session table is read through the worker's token
// (shopifyqlQuery, read_reports). A session is AUTOMATED when Shopify labels it
// a bot OR the browser names itself as automation: measured 2026-10-07 over 90
// days, Shopify labelled 96 HeadlessChrome sessions "human" and 101 ordinary
// Chrome sessions "bot", so neither signal alone is the whole answer. Everything
// else is a PERSON: engaged (more than one page) or single-page.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { TenantStore } from '../src/tenant-store';
import { app } from '../src/index';
import type { Env } from '../src/types';
import {
  classifyBrowser, isAutomated, parseWindow, activityQueries, tableRows, enumerateDays,
  buildDailySeries, topPeople, getTrafficActivity, ACTIVITY_WINDOWS, DAILY_LIMIT,
} from '../src/traffic-quality';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

// The live 7-day daily rows read 2026-10-07 (day, label, browser, bounced,
// sessions, cart adds, reached checkout, completed checkout). The 10-07 row is
// TIMESERIES' own empty day: null fields and zero counts.
const LIVE_DAILY: [string, string | null, string | null, boolean | null, string, string, string, string][] = [
  ['2026-10-01', 'bot', 'Spider', false, '94', '0', '44', '0'], ['2026-10-01', 'bot', 'Spider', true, '146', '0', '0', '0'],
  ['2026-10-01', 'bot', 'Chrome', true, '2', '0', '0', '0'],
  ['2026-10-02', 'bot', 'Chrome', true, '1', '0', '0', '0'], ['2026-10-02', 'bot', 'Spider', true, '8', '0', '0', '0'],
  ['2026-10-02', 'bot', 'Spider', false, '2', '0', '2', '0'],
  ['2026-10-03', 'bot', 'Chrome', true, '1', '0', '0', '0'], ['2026-10-03', 'human', 'Chrome', true, '1', '0', '0', '0'],
  ['2026-10-03', 'bot', 'Spider', false, '2', '0', '2', '0'], ['2026-10-03', 'bot', 'Spider', true, '7', '0', '0', '0'],
  ['2026-10-03', 'human', 'Chrome', false, '1', '0', '0', '0'], ['2026-10-03', 'human', 'Mobile Safari', true, '1', '0', '0', '0'],
  ['2026-10-03', 'bot', 'Chrome Mobile', true, '1', '0', '0', '0'],
  ['2026-10-04', 'bot', 'Chrome Mobile', true, '1', '0', '0', '0'], ['2026-10-04', 'bot', 'Spider', false, '2', '0', '2', '0'],
  ['2026-10-04', 'bot', 'Spider', true, '8', '0', '0', '0'],
  ['2026-10-05', 'bot', 'Chrome', true, '1', '0', '0', '0'], ['2026-10-05', 'bot', 'Spider', false, '2', '0', '2', '0'],
  ['2026-10-05', 'bot', 'Spider', true, '8', '0', '0', '0'], ['2026-10-05', 'human', 'Chrome', true, '1', '0', '0', '0'],
  ['2026-10-06', 'human', 'Chrome', false, '1', '1', '1', '0'], ['2026-10-06', 'bot', 'Chrome Mobile', true, '1', '0', '0', '0'],
  ['2026-10-06', 'bot', 'Chrome', true, '1', '0', '0', '0'], ['2026-10-06', 'bot', 'Spider', true, '2', '0', '0', '0'],
  ['2026-10-07', null, null, null, '0', '0', '0', '0'],
];
const DAILY_COLUMNS = ['day', 'human_or_bot_session', 'session_device_browser', 'session_bounced', 'sessions',
  'sessions_with_cart_additions', 'sessions_that_reached_checkout', 'sessions_that_completed_checkout'];
// The DOCUMENTED Admin API shape: rows are objects keyed by column name.
const dailyObjects = LIVE_DAILY.map((cells) => Object.fromEntries(DAILY_COLUMNS.map((c, i) => [c, cells[i]])));
const DAILY_TABLE = { columns: DAILY_COLUMNS.map((name) => ({ name, dataType: 'STRING' })), rows: dailyObjects };

const REFERRER_TABLE = {
  columns: ['referrer_source', 'human_or_bot_session', 'session_device_browser', 'sessions'].map((name) => ({ name, dataType: 'STRING' })),
  rows: [
    { referrer_source: 'direct', human_or_bot_session: 'bot', session_device_browser: 'Spider', sessions: '289' },
    { referrer_source: 'direct', human_or_bot_session: 'human', session_device_browser: 'HeadlessChrome', sessions: '95' },
    { referrer_source: 'direct', human_or_bot_session: 'human', session_device_browser: 'Chrome', sessions: '4' },
    { referrer_source: 'search', human_or_bot_session: 'human', session_device_browser: 'Chrome', sessions: '2' },
    { referrer_source: null, human_or_bot_session: 'human', session_device_browser: 'Chrome', sessions: '1' },
  ],
};
const LANDING_TABLE = {
  columns: ['landing_page_path', 'human_or_bot_session', 'session_device_browser', 'sessions'].map((name) => ({ name, dataType: 'STRING' })),
  rows: [
    { landing_page_path: '/', human_or_bot_session: 'human', session_device_browser: 'HeadlessChrome', sessions: '90' },
    { landing_page_path: '/collections/all', human_or_bot_session: 'bot', session_device_browser: 'Spider', sessions: '56' },
    { landing_page_path: '/', human_or_bot_session: 'human', session_device_browser: 'Chrome', sessions: '3' },
    { landing_page_path: '/products/x', human_or_bot_session: 'human', session_device_browser: 'Mobile Safari', sessions: '2' },
  ],
};

describe('classifyBrowser', () => {
  it('names automation by what the browser calls itself, nothing else', () => {
    for (const b of ['HeadlessChrome', 'Spider', '360Spider', 'Stripebot', 'meta-webindexer', 'Googlebot', 'curl']) expect(classifyBrowser(b)).toBe('automated');
    for (const b of ['Chrome', 'Mobile Safari', 'Other', '', null, undefined]) expect(classifyBrowser(b)).toBe('human-looking');
  });
});

describe('isAutomated', () => {
  it('is automated when Shopify labels it a bot OR the browser names automation', () => {
    expect(isAutomated('human', 'HeadlessChrome')).toBe(true); // Shopify missed it
    expect(isAutomated('bot', 'Chrome')).toBe(true);           // the browser string missed it
    expect(isAutomated('bot', 'Spider')).toBe(true);
    expect(isAutomated('human', 'Chrome')).toBe(false);
    expect(isAutomated('Human', 'Mobile Safari')).toBe(false);
    expect(isAutomated('Bot', 'Mobile Safari')).toBe(true);
  });
});

describe('parseWindow', () => {
  it('accepts only the fixed windows, because the number is written into the query', () => {
    expect(ACTIVITY_WINDOWS).toEqual([7, 30, 90]);
    for (const d of [7, 30, 90]) expect(parseWindow(d)).toBe(d);
    for (const bad of [31, 0, -7, 7.5, '30', '7d UNTIL today', null, undefined, {}]) expect(parseWindow(bad)).toBeNull();
  });
});

describe('activityQueries', () => {
  it('asks for exactly N days ending today, split by both automation signals', () => {
    const q = activityQueries(30);
    expect(q.daily).toContain('SINCE -29d UNTIL today');
    expect(q.daily).toContain('TIMESERIES day');
    expect(q.daily).toContain(`LIMIT ${DAILY_LIMIT}`);
    for (const s of [q.daily, q.referrers, q.landing]) {
      expect(s).toContain('human_or_bot_session');
      expect(s).toContain('session_device_browser');
      expect(s).toContain('SINCE -29d UNTIL today');
    }
    for (const m of ['sessions_with_cart_additions', 'sessions_that_reached_checkout', 'sessions_that_completed_checkout', 'session_bounced']) expect(q.daily).toContain(m);
    expect(q.referrers).toContain('referrer_source');
    expect(q.landing).toContain('landing_page_path');
    expect(activityQueries(7).daily).toContain('SINCE -6d UNTIL today');
  });
});

describe('tableRows', () => {
  it('reads both the documented object rows and the connector array rows, by column name', () => {
    expect(tableRows(DAILY_TABLE)[0]).toMatchObject({ day: '2026-10-01', session_device_browser: 'Spider', sessions: '94' });
    const arrays = { columns: DAILY_TABLE.columns, rows: LIVE_DAILY.map((c) => [...c]) };
    expect(tableRows(arrays)).toEqual(tableRows(DAILY_TABLE));
    expect(tableRows({ columns: [], rows: ['junk', 7] as unknown[] })).toEqual([{}, {}]);
  });
});

describe('enumerateDays', () => {
  it('lists N calendar days ending on the last day, across a month end', () => {
    expect(enumerateDays('2026-10-02', 4)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('buildDailySeries', () => {
  it('reproduces the live week: 295 sessions, 5 people (2 engaged, 3 single-page), 290 automated', () => {
    const { series, totals, topAutomated } = buildDailySeries(tableRows(DAILY_TABLE), 7, '2026-10-07');
    expect(series.map((d) => d.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']);
    expect(series.map((d) => d.people)).toEqual([0, 0, 3, 0, 1, 1, 0]);
    expect(series.map((d) => d.automated)).toEqual([242, 11, 11, 11, 11, 4, 0]);
    expect(series[2]).toMatchObject({ engaged: 1, singlePage: 2 });
    expect(totals).toMatchObject({ sessions: 295, people: 5, engaged: 2, singlePage: 3, automated: 290, cartAdds: 1, reachedCheckout: 1, completedCheckout: 0 });
    expect(totals.automatedShare).toBe(98.3);
    expect(totals.peopleBounceRate).toBe(60);
    expect(totals.rawBounceRate).toBe(64.7); // 191 bounced of 295, as Shopify shows it
    expect(topAutomated[0]).toEqual({ browser: 'Spider', sessions: 281 });
  });

  it('counts checkout progress for people only: 44 Spider sessions "reached checkout" on 1 Oct and none of them is a person', () => {
    const { series } = buildDailySeries(tableRows(DAILY_TABLE), 7, '2026-10-07');
    expect(series[0].reachedCheckout).toBe(0);
    expect(series[5]).toMatchObject({ cartAdds: 1, reachedCheckout: 1 });
  });

  it('fills every day of the window, ending on the last day Shopify reported (the shop\'s own calendar)', () => {
    const only = tableRows(DAILY_TABLE).filter((r) => r.day === '2026-10-03' || r.day === '2026-10-07');
    const { series } = buildDailySeries(only, 7, '2026-12-25');
    expect(series).toHaveLength(7);
    expect(series[6].day).toBe('2026-10-07');
    expect(series.map((d) => d.people)).toEqual([0, 0, 3, 0, 0, 0, 0]);
  });

  it('falls back to the given today when Shopify reported no day at all, with zeros and null rates', () => {
    const { series, totals } = buildDailySeries([], 7, '2026-10-07');
    expect(series[6].day).toBe('2026-10-07');
    expect(totals).toMatchObject({ sessions: 0, people: 0, automatedShare: null, peopleBounceRate: null, rawBounceRate: null });
  });
});

describe('topPeople', () => {
  it('ranks referrers and landing pages by people only; an unnamed referrer is "unknown"', () => {
    expect(topPeople(tableRows(REFERRER_TABLE), 'referrer_source', 6)).toEqual([
      { label: 'direct', people: 4 }, { label: 'search', people: 2 }, { label: 'unknown', people: 1 },
    ]);
    expect(topPeople(tableRows(LANDING_TABLE), 'landing_page_path', 8)).toEqual([
      { label: '/', people: 3 }, { label: '/products/x', people: 2 },
    ]);
  });
});

describe('getTrafficActivity', () => {
  const tableFor = (q: string) => q.includes('referrer_source') ? REFERRER_TABLE : q.includes('landing_page_path') ? LANDING_TABLE : DAILY_TABLE;
  const okAdmin = async (query: string, vars?: Record<string, unknown>) => {
    expect(query).toContain('shopifyqlQuery');
    return { shopifyqlQuery: { tableData: tableFor(String(vars?.q)), parseErrors: [] } };
  };
  const now = new Date('2026-10-07T12:00:00Z');

  it('returns the daily series, totals, referrers and landing pages for the window', async () => {
    const r = await getTrafficActivity(okAdmin, 7, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.activity.days).toBe(7);
    expect(r.activity.from).toBe('2026-10-01');
    expect(r.activity.to).toBe('2026-10-07');
    expect(r.activity.series).toHaveLength(7);
    expect(r.activity.totals.people).toBe(5);
    expect(r.activity.referrers[0]).toEqual({ label: 'direct', people: 4 });
    expect(r.activity.landing[0]).toEqual({ label: '/', people: 3 });
    expect(r.activity.truncated).toBe(false);
    expect(typeof r.at).toBe('string');
  });

  it('says so when the daily table hit its row limit, instead of drawing a short total as the truth', async () => {
    const full = { ...DAILY_TABLE, rows: Array.from({ length: DAILY_LIMIT }, () => dailyObjects[0]) };
    const capped = async (_q: string, vars?: Record<string, unknown>) =>
      ({ shopifyqlQuery: { tableData: String(vars?.q).includes('TIMESERIES') ? full : tableFor(String(vars?.q)), parseErrors: [] } });
    const r = await getTrafficActivity(capped, 90, now);
    expect(r.ok && r.activity.truncated).toBe(true);
  });

  // aramid llm-review 3c22be0b: upstream text never travels to the client.
  it('names the missing scope when Shopify denies the query, and never reads that as "no traffic"', async () => {
    const denying = async () => { throw new Error('Access denied for shopifyqlQuery field. Required access: `read_reports` access scope.'); };
    const r = await getTrafficActivity(denying, 30, now);
    expect(r).toMatchObject({ ok: false, reason: 'scope_missing', scope: 'read_reports' });
    if (!r.ok) expect(r.error).not.toContain('shopifyqlQuery field');
  });

  it('reports a parse error as a query error without echoing the upstream text', async () => {
    const parseFail = async () => ({ shopifyqlQuery: { tableData: null, parseErrors: ['Unknown metric foo'] } });
    const r = await getTrafficActivity(parseFail, 30, now);
    expect(r).toMatchObject({ ok: false, reason: 'query_error' });
    if (!r.ok) expect(r.error).not.toContain('Unknown metric foo');
  });

  it('reports an unreachable Admin API as unavailable, without the upstream text', async () => {
    const down = async () => { throw new Error('Shopify HTTP 503 upstream-host-42'); };
    const r = await getTrafficActivity(down, 30, now);
    expect(r).toMatchObject({ ok: false, reason: 'unavailable' });
    if (!r.ok) expect(r.error).not.toContain('upstream-host-42');
  });

  it('a shop with no token is not connected', async () => {
    expect(await getTrafficActivity(null, 30, now)).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});

// HTTP level: behind shopOf's session-token auth like every console route; a
// window outside the fixed set is refused before anything reaches Shopify.
const TQ_SHOP = 'tq.myshopify.com';
const TQ_SECRET = 'test-shopify-secret';
async function tqBearer(shop: string): Promise<string> {
  const key = new TextEncoder().encode(TQ_SECRET);
  return new SignJWT({ dest: `https://${shop}`, sub: '1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience((env as unknown as Env).SHOPIFY_API_KEY)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}
describe('POST /api/traffic/activity', () => {
  it('requires a session token, refuses a window outside 7/30/90, and answers not_connected without a usable token', async () => {
    const s = new TenantStore(env.DB, TQ_SHOP);
    await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    const e = { ...env, SHOPIFY_API_SECRET: TQ_SECRET } as unknown as Env;
    const post = async (body: unknown, auth = true) => app.request('/api/traffic/activity', {
      method: 'POST',
      headers: { ...(auth ? { Authorization: `Bearer ${await tqBearer(TQ_SHOP)}` } : {}), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, e);
    expect((await post({ days: 30 }, false)).status).toBe(401);
    const bad = await post({ days: 31 });
    expect(bad.status).toBe(400);
    const res = await post({ days: 30 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});
