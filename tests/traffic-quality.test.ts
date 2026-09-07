/// <reference types="@cloudflare/vitest-pool-workers" />
// Traffic quality (2026-09-05): the honest answer to "your store has a high
// bounce rate" pitches. Shopify's own session table is read through the
// worker's token (shopifyqlQuery, read_reports), and every session is put in
// one of three buckets: automated (the browser says so), engaged (human-looking,
// more than one pageview), single-page unattributed (human-looking, one
// pageview - a real one-page visit and a bot with a normal user agent are
// indistinguishable here, so it is labelled unknown rather than guessed).
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { TenantStore } from '../src/tenant-store';
import { app } from '../src/index';
import type { Env } from '../src/types';
import {
  classifyBrowser, buildTrafficQuery, parseTrafficTable, summarizeTraffic, getTrafficQuality,
  TRAFFIC_QUALITY_SCOPE, TRAFFIC_WINDOWS,
} from '../src/traffic-quality';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

// The live 90-day rows measured 2026-09-05 (browser, bounced, sessions, carts).
const LIVE_CELLS = [
  ['HeadlessChrome', 'true', '214', '0'], ['Chrome', 'true', '137', '0'], ['Mobile Safari', 'true', '31', '0'],
  ['Chrome Mobile', 'true', '29', '0'], ['Chrome', 'false', '26', '11'], ['Stripebot', 'true', '10', '0'],
  ['Chrome Mobile', 'false', '9', '4'], ['Other', 'true', '8', '0'], ['Edge', 'false', '5', '2'],
  ['Edge', 'true', '4', '0'], ['360Spider', 'true', '4', '0'], ['Chrome Mobile iOS', 'true', '4', '0'],
  ['Firefox', 'true', '3', '0'], ['Safari', 'true', '3', '0'], ['Mobile Safari', 'false', '2', '1'],
  ['Other', 'false', '2', '0'], ['meta-webindexer', 'true', '2', '0'],
];
const COLUMNS = [
  { name: 'session_device_browser', dataType: 'STRING' }, { name: 'session_bounced', dataType: 'BOOLEAN' },
  { name: 'sessions', dataType: 'INTEGER' }, { name: 'sessions_with_cart_additions', dataType: 'INTEGER' },
];
// The DOCUMENTED Admin API shape (ShopifyqlTableData.rows is JSON: an array of
// objects keyed by column name). The first live call on 2026-09-05 returned
// success with zero sessions because the parser assumed arrays of cells, the
// shape the analytics connector uses; both are accepted now, this one first.
const LIVE_ROWS = LIVE_CELLS.map(([b, bounced, s, c]) => ({ session_device_browser: b, session_bounced: bounced, sessions: s, sessions_with_cart_additions: c }));
const LIVE_TABLE = { columns: COLUMNS, rows: LIVE_ROWS };

describe('classifyBrowser', () => {
  it('names automation by what the browser calls itself, nothing else', () => {
    for (const b of ['HeadlessChrome', 'Stripebot', '360Spider', 'meta-webindexer', 'Googlebot', 'AhrefsBot', 'PhantomJS', 'python-requests', 'curl', 'bingbot', 'Applebot', 'facebookexternalhit', 'Screaming Frog SEO Spider', 'HeadlessEdge']) {
      expect(classifyBrowser(b), b).toBe('automated');
    }
    for (const b of ['Chrome', 'Chrome Mobile', 'Mobile Safari', 'Safari', 'Edge', 'Firefox', 'Samsung Internet', 'Chrome Mobile iOS', 'Other', '', null, undefined]) {
      expect(classifyBrowser(b as string), String(b)).toBe('human-looking');
    }
  });
});

describe('buildTrafficQuery', () => {
  it('asks the sessions table for sessions and cart adds by browser and bounced flag over the window', () => {
    const q = buildTrafficQuery(30);
    expect(q).toMatch(/^FROM sessions SHOW sessions, sessions_with_cart_additions GROUP BY session_device_browser, session_bounced SINCE -30d UNTIL today$/);
    expect(buildTrafficQuery(90)).toContain('SINCE -90d');
    expect(TRAFFIC_WINDOWS).toEqual([30, 90]);
    expect(TRAFFIC_QUALITY_SCOPE).toBe('read_reports');
  });
});

describe('parseTrafficTable', () => {
  it('reads the documented Admin API shape: rows as objects keyed by column name', () => {
    const rows = parseTrafficTable({
      columns: COLUMNS,
      rows: [
        { session_device_browser: 'Chrome', session_bounced: 'false', sessions: '7', sessions_with_cart_additions: '3' },
        { session_device_browser: 'HeadlessChrome', session_bounced: true, sessions: 5, sessions_with_cart_additions: 0 },
      ],
    });
    expect(rows).toEqual([
      { browser: 'Chrome', bounced: false, sessions: 7, cartAdds: 3 },
      { browser: 'HeadlessChrome', bounced: true, sessions: 5, cartAdds: 0 },
    ]);
  });
  it('still reads rows as arrays of cells (the analytics connector shape), mapped by column name', () => {
    const rows = parseTrafficTable({
      columns: [{ name: 'sessions' }, { name: 'session_bounced' }, { name: 'session_device_browser' }, { name: 'sessions_with_cart_additions' }],
      rows: [['7', 'false', 'Chrome', '3'], ['5', 'true', 'HeadlessChrome', '0']],
    });
    expect(rows).toEqual([
      { browser: 'Chrome', bounced: false, sessions: 7, cartAdds: 3 },
      { browser: 'HeadlessChrome', bounced: true, sessions: 5, cartAdds: 0 },
    ]);
  });
  it('tolerates a missing cart column and non-numeric cells (never throws on a table)', () => {
    const rows = parseTrafficTable({ columns: [{ name: 'session_device_browser' }, { name: 'session_bounced' }, { name: 'sessions' }], rows: [['Chrome', 'true', 'n/a']] });
    expect(rows).toEqual([{ browser: 'Chrome', bounced: true, sessions: 0, cartAdds: 0 }]);
  });
});

describe('summarizeTraffic', () => {
  it('reproduces the 2026-09-05 measurement: 493 sessions, 230 automated, 44 engaged, 219 single-page', () => {
    const s = summarizeTraffic(90, parseTrafficTable(LIVE_TABLE));
    expect(s.days).toBe(90);
    expect(s.sessions).toBe(493);              // the fixture's own total
    expect(s.automated).toBe(230);             // 214 + 10 + 4 + 2
    expect(s.engaged).toBe(44);                // human-looking, not bounced: 26+9+5+2+2
    expect(s.singlePage).toBe(219);            // human-looking, bounced: 137+31+29+8+4+4+3+3
    expect(s.cartAdds).toBe(18);
    expect(s.automatedShare).toBe(46.7);       // 230 / 493
    expect(s.rawBounceRate).toBe(91.1);        // (230 + 219) / 493, what Shopify shows
    expect(s.humanBounceRate).toBe(83.3);      // 219 / (44 + 219)
    expect(s.topAutomated).toEqual([
      { browser: 'HeadlessChrome', sessions: 214 }, { browser: 'Stripebot', sessions: 10 },
      { browser: '360Spider', sessions: 4 }, { browser: 'meta-webindexer', sessions: 2 },
    ]);
  });
  it('an empty window reports zeros and null rates, never NaN', () => {
    const s = summarizeTraffic(30, []);
    expect(s.sessions).toBe(0);
    expect(s.rawBounceRate).toBeNull();
    expect(s.humanBounceRate).toBeNull();
    expect(s.automatedShare).toBeNull();
    expect(s.topAutomated).toEqual([]);
  });
  it('caps the automated list at five entries, largest first', () => {
    const rows = ['a-bot', 'b-bot', 'c-bot', 'd-bot', 'e-bot', 'f-bot'].map((b, i) => ({ browser: b, bounced: true, sessions: 10 - i, cartAdds: 0 }));
    expect(summarizeTraffic(30, rows).topAutomated).toHaveLength(5);
    expect(summarizeTraffic(30, rows).topAutomated[0]).toEqual({ browser: 'a-bot', sessions: 10 });
  });
});

describe('getTrafficQuality', () => {
  const okAdmin = async (query: string, vars?: Record<string, unknown>) => {
    expect(query).toContain('shopifyqlQuery');
    const q = String(vars?.q);
    // The 30-day window returns a smaller table so the two windows are distinguishable.
    const table = q.includes('-30d') ? { ...LIVE_TABLE, rows: LIVE_ROWS.slice(0, 2) } : LIVE_TABLE;
    return { shopifyqlQuery: { tableData: table, parseErrors: [] } };
  };

  it('runs one query per window and returns both summaries', async () => {
    const r = await getTrafficQuality(okAdmin);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows.map((w) => w.days)).toEqual([30, 90]);
    expect(r.windows[0].sessions).toBe(351); // 214 + 137
    expect(r.windows[1].sessions).toBe(493);
    expect(typeof r.at).toBe('string');
  });

  // aramid llm-review 3c22be0b (fixed 2026-09-07): the raw upstream exception
  // text used to travel to the console client. Each failure now carries a
  // stable message of ours (the reason code decides the console state); the
  // upstream text goes to the server log only.
  it('names the missing scope when Shopify denies the query, and never reads that as "no traffic"', async () => {
    const denying = async () => { throw new Error('Access denied for shopifyqlQuery field. Required access: `read_reports` access scope.'); };
    const r = await getTrafficQuality(denying);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('scope_missing');
    expect(r.scope).toBe('read_reports');
    expect(r.error).toContain('read_reports');
    expect(r.error).not.toContain('shopifyqlQuery field');
  });

  it('reports a parse error as a query error without echoing the upstream text', async () => {
    const parseFail = async () => ({ shopifyqlQuery: { tableData: null, parseErrors: ['Unknown metric foo'] } });
    const r = await getTrafficQuality(parseFail);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('query_error');
    expect(r.error).not.toContain('Unknown metric foo');
    expect(r.error).toMatch(/sessions query/i);
  });

  it('reports an unreachable Admin API as unavailable, distinct from a missing scope, without the upstream text', async () => {
    const down = async () => { throw new Error('Shopify HTTP 503 upstream-host-42'); };
    const r = await getTrafficQuality(down);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unavailable');
    expect(r.error).not.toContain('upstream-host-42');
    expect(r.error).toMatch(/analytics/i);
  });

  it('a shop with no token is not connected', async () => {
    const r = await getTrafficQuality(null);
    expect(r).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});

// HTTP level: the route sits behind shopOf's session-token auth like every
// other console route, and a tenant without a token gets the honest
// not_connected answer rather than a 500.
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
describe('POST /api/traffic/quality', () => {
  it('requires a session token, and answers not_connected when the stored token cannot be opened', async () => {
    const s = new TenantStore(env.DB, TQ_SHOP);
    // An opaque placeholder token (as the other HTTP-level tests seed): the
    // install handshake sees a tenant and skips token exchange, and the Admin
    // client cannot open the token, which is the not_connected path.
    await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    const e = { ...env, SHOPIFY_API_SECRET: TQ_SECRET } as unknown as Env;
    const anon = await app.request('/api/traffic/quality', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, e);
    expect(anon.status).toBe(401);
    const res = await app.request('/api/traffic/quality', {
      method: 'POST', headers: { Authorization: `Bearer ${await tqBearer(TQ_SHOP)}`, 'content-type': 'application/json' }, body: '{}',
    }, e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'not_connected' });
  });
});
