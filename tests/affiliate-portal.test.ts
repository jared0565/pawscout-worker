/// <reference types="@cloudflare/vitest-pool-workers" />
// Task 5: partner self-serve portal (worker domain, NOT /proxy). Ships DARK
// behind cfg.selfServe.enabled - exactly like Task 4's verify route and Task
// 0's apply route, cfg.selfServe is NOT wired into the real getConfig() path
// yet (a later task owns that DB column), so every "enabled=true" scenario
// below drives it through app.request via the same TenantStore.prototype
// .getConfig spy trick tests/affiliate-apply.test.ts already established
// (see its "HTTP level: /proxy/affiliate/apply - fault isolation" block).
// The dark-state (enabled=false) tests need no spy: the real path can only
// ever be disabled today, so a plain app.request already exercises it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX,
  DEFAULT_SELF_SERVE, type TenantConfig, type Env
} from '../src/types';
import { app } from '../src/index';
import {
  handlePortalLogin, handlePortalGet, handlePortalData,
  mintSessionCookieValue, verifySessionCookieValue, SESSION_COOKIE_NAME, GENERIC_LOGIN_HTML
} from '../src/affiliate/portal';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const SHOP = 'a.myshopify.com';
const SECRET = 'test-shopify-secret';
const store = () => new TenantStore(env.DB, SHOP);

const ENABLED_CFG: TenantConfig = {
  collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12,
  selfServe: { enabled: true, autoIssueCapPerDay: 5, screenSpendCapGbpPerDay: 2, scoreThreshold: 8, starterUsageLimit: 15 }
};
const DISABLED_CFG: TenantConfig = { ...ENABLED_CFG, selfServe: { ...ENABLED_CFG.selfServe!, enabled: false } };

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB, SHOPIFY_API_KEY: 'k', SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: 'https://pawscout.example.com',
    SHOPIFY_SCOPES: 's', PAWSCOUT_MASTER_KEY: 'x', RESEND_API_KEY: 'resend-key',
    ...overrides
  } as unknown as Env;
}

/** URL-routing fake fetch: Resend is the only outbound call the login flow
 *  makes. Captures every send so tests can pull the magic-link token out of
 *  the emailed body without ever going over the network. */
function fakeFetch(opts: { resendOk?: boolean; sentEmails?: { to: string; subject: string; text?: string }[] } = {}): typeof fetch {
  const { resendOk = true, sentEmails } = opts;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('api.resend.com')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      sentEmails?.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: body.subject, text: body.text });
      return resendOk
        ? new Response(JSON.stringify({ id: 'em_1' }), { status: 200 })
        : new Response(JSON.stringify({ message: 'send failed' }), { status: 500 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as unknown as typeof fetch;
}

function extractToken(text: string | undefined): string {
  const m = (text ?? '').match(/\/affiliate\/portal\?token=([a-f0-9]{64})/);
  if (!m) throw new Error(`no token found in email body: ${text}`);
  return m[1];
}

// ---------------------------------------------------------------------------
// Core-level: cookie mint/verify (fast boundary-condition coverage, kept as a
// supplement to the HTTP-level tests below, not a substitute for them - a
// route bug (wrong cookie name, dark-check ordering) would not show up here).
// ---------------------------------------------------------------------------
describe('mintSessionCookieValue / verifySessionCookieValue', () => {
  const NOW = 2_000_000_000_000;

  it('round-trips a freshly minted cookie', async () => {
    const value = await mintSessionCookieValue('partner-1', SECRET, NOW);
    expect(await verifySessionCookieValue(value, SECRET, NOW)).toBe('partner-1');
  });

  it('rejects a tampered value (flipped mac character)', async () => {
    const value = await mintSessionCookieValue('partner-1', SECRET, NOW);
    const parts = value.split('.');
    const tamperedMac = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1);
    const tampered = `${parts[0]}.${parts[1]}.${tamperedMac}`;
    expect(await verifySessionCookieValue(tampered, SECRET, NOW)).toBeNull();
  });

  it('rejects a value signed with the wrong secret', async () => {
    const value = await mintSessionCookieValue('partner-1', 'other-secret', NOW);
    expect(await verifySessionCookieValue(value, SECRET, NOW)).toBeNull();
  });

  it('rejects an expired cookie (nowMs past the embedded expiry)', async () => {
    const value = await mintSessionCookieValue('partner-1', SECRET, NOW);
    const eightDaysLater = NOW + 8 * 24 * 60 * 60 * 1000;
    expect(await verifySessionCookieValue(value, SECRET, eightDaysLater)).toBeNull();
  });

  it('rejects malformed values (missing parts, empty, null)', async () => {
    expect(await verifySessionCookieValue(null, SECRET, NOW)).toBeNull();
    expect(await verifySessionCookieValue('', SECRET, NOW)).toBeNull();
    expect(await verifySessionCookieValue('only-one-part', SECRET, NOW)).toBeNull();
    expect(await verifySessionCookieValue('a.b', SECRET, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Core-level: handlePortalLogin / handlePortalGet / handlePortalData direct
// dependency-injection tests (same pattern as handleAffiliateApply).
// ---------------------------------------------------------------------------
describe('handlePortalLogin (core): dark by default', () => {
  it('refuses when selfServe.enabled is false', async () => {
    const r = await handlePortalLogin({ store: store(), cfg: DISABLED_CFG, env: baseEnv(), email: 'x@example.com' });
    expect(r.status).toBe(200);
    expect(r.html).not.toBe(GENERIC_LOGIN_HTML);
  });

  it('refuses when cfg.selfServe is entirely absent (the real, unwired production path)', async () => {
    const cfg: TenantConfig = { ...ENABLED_CFG, selfServe: undefined };
    const r = await handlePortalLogin({ store: store(), cfg, env: baseEnv(), email: 'x@example.com' });
    expect(r.html).not.toBe(GENERIC_LOGIN_HTML);
  });
});

describe('handlePortalLogin (core): no-enumeration', () => {
  it('returns byte-identical bodies for a registered partner and a random non-partner', async () => {
    const s = store();
    await s.upsertAffiliatePartner({ contactEmail: 'live@example.com', name: 'Live Partner' });
    const sentEmails: { to: string; subject: string; text?: string }[] = [];

    const registered = await handlePortalLogin({
      store: s, cfg: ENABLED_CFG, env: baseEnv(), email: 'live@example.com',
      fetchImpl: fakeFetch({ sentEmails })
    });
    const unregistered = await handlePortalLogin({
      store: s, cfg: ENABLED_CFG, env: baseEnv(), email: 'nobody@example.com',
      fetchImpl: fakeFetch({ sentEmails })
    });

    expect(registered.status).toBe(unregistered.status);
    expect(registered.html).toBe(unregistered.html);
    // Sanity: the registered branch really did send an email, the other did not.
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('live@example.com');
  });

  it('stays uniform even when the D1 lookup throws', async () => {
    const s = store();
    vi.spyOn(TenantStore.prototype, 'partnerIdByEmail').mockRejectedValue(new Error('D1 boom'));
    const r = await handlePortalLogin({ store: s, cfg: ENABLED_CFG, env: baseEnv(), email: 'whoever@example.com' });
    expect(r.status).toBe(200);
    expect(r.html).toBe(GENERIC_LOGIN_HTML);
  });
});

describe('handlePortalGet (core) + handlePortalData (core)', () => {
  async function seedPartner(email: string, code: string, opts: { gross: number; commission: number; paid?: number }) {
    const s = store();
    const partnerId = await s.upsertAffiliatePartner({ contactEmail: email, name: email });
    const voucherId = await s.createAffiliateVoucher({
      partnerId, code, pctOff: 10, commissionPct: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z'
    });
    await s.upsertAffiliateOrder({
      shopifyOrderId: `order-${code}`, voucherId, orderName: `#SECRET-${code}`,
      grossGbp: opts.gross, discountGbp: 5, commissionGbp: opts.commission,
      financialStatus: 'paid', eligible: true, placedAt: '2026-07-01T00:00:00.000Z',
      buyerEmailHash: `hash-${code}`, selfReferral: false
    });
    if (opts.paid) await s.createAffiliatePayout(voucherId, { method: 'manual' });
    return { partnerId, voucherId };
  }

  it('a valid session identifies the right partner and shows only their aggregates', async () => {
    const a = await seedPartner('a@example.com', 'CODEAAAA', { gross: 100, commission: 10 });
    await seedPartner('b@example.com', 'CODEBBBB', { gross: 200, commission: 20 });
    const cookie = await mintSessionCookieValue(a.partnerId, SECRET, Date.now());

    const r = await handlePortalGet({ store: store(), cfg: ENABLED_CFG, secret: SECRET, sessionCookie: cookie });
    expect(r.status).toBe(200);
    expect(r.html).toContain('CODEAAAA');
    expect(r.html).not.toContain('CODEBBBB');

    const data = await handlePortalData({ store: store(), cfg: ENABLED_CFG, secret: SECRET, sessionCookie: cookie });
    expect(data.status).toBe(200);
    if (!data.body.ok) throw new Error('expected ok');
    expect(data.body.summary.vouchers.map((v) => v.code)).toEqual(['CODEAAAA']);
    expect(data.body.summary.gross_gbp).toBe(100);
    expect(data.body.summary.commission_gbp).toBe(10);
  });

  it('missing/invalid/expired cookie renders the login form, never a dashboard', async () => {
    const a = await seedPartner('a@example.com', 'CODEAAAA', { gross: 100, commission: 10 });

    const noCookie = await handlePortalGet({ store: store(), cfg: ENABLED_CFG, secret: SECRET, sessionCookie: null });
    expect(noCookie.html).not.toContain('CODEAAAA');

    const validCookie = await mintSessionCookieValue(a.partnerId, SECRET, Date.now());
    const tampered = validCookie.slice(0, -1) + (validCookie.endsWith('0') ? '1' : '0');
    const tamperedRes = await handlePortalGet({ store: store(), cfg: ENABLED_CFG, secret: SECRET, sessionCookie: tampered });
    expect(tamperedRes.html).not.toContain('CODEAAAA');

    const expiredCookie = await mintSessionCookieValue(a.partnerId, SECRET, Date.now() - 8 * 24 * 60 * 60 * 1000);
    const expiredRes = await handlePortalGet({ store: store(), cfg: ENABLED_CFG, secret: SECRET, sessionCookie: expiredCookie });
    expect(expiredRes.html).not.toContain('CODEAAAA');

    // Unauthenticated /data calls are rejected outright (401), never a summary leak.
    const dataNoCookie = await handlePortalData({ store: store(), cfg: ENABLED_CFG, secret: SECRET, sessionCookie: null });
    expect(dataNoCookie.status).toBe(401);
    const dataTampered = await handlePortalData({ store: store(), cfg: ENABLED_CFG, secret: SECRET, sessionCookie: tampered });
    expect(dataTampered.status).toBe(401);
  });

  it('never renders buyer PII (order name, buyer email hash) anywhere in the page or JSON payload', async () => {
    const a = await seedPartner('a@example.com', 'CODEAAAA', { gross: 100, commission: 10, paid: 1 });
    const cookie = await mintSessionCookieValue(a.partnerId, SECRET, Date.now());

    const r = await handlePortalGet({ store: store(), cfg: ENABLED_CFG, secret: SECRET, sessionCookie: cookie });
    expect(r.html).not.toContain('SECRET-CODEAAAA'); // the seeded order_name
    expect(r.html).not.toContain('hash-CODEAAAA');   // the seeded buyer_email_hash
    expect(r.html.toLowerCase()).not.toContain('buyer');

    const data = await handlePortalData({ store: store(), cfg: ENABLED_CFG, secret: SECRET, sessionCookie: cookie });
    const raw = JSON.stringify(data.body);
    expect(raw).not.toContain('SECRET-CODEAAAA');
    expect(raw).not.toContain('hash-CODEAAAA');
    expect(raw).not.toContain('order_name');
    expect(raw).not.toContain('buyer_email');
    expect(raw).not.toContain('shopify_order_id');
  });

  it('refuses (dark) regardless of a present cookie when selfServe.enabled is false', async () => {
    const a = await seedPartner('a@example.com', 'CODEAAAA', { gross: 100, commission: 10 });
    const cookie = await mintSessionCookieValue(a.partnerId, SECRET, Date.now());
    const r = await handlePortalGet({ store: store(), cfg: DISABLED_CFG, secret: SECRET, sessionCookie: cookie });
    expect(r.html).not.toContain('CODEAAAA');
    const data = await handlePortalData({ store: store(), cfg: DISABLED_CFG, secret: SECRET, sessionCookie: cookie });
    expect(data.body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP level: app.request against the real Hono app. Point 5 (dark -> refuse)
// needs no mocking - the real getConfig() path can only ever be disabled
// today (selfServe is not DB-wired yet - see Task 1/apply.ts). Points 1-4
// and 6 need the same TenantStore.prototype.getConfig spy tests/
// affiliate-apply.test.ts already established to reach selfServe.enabled=true
// through the real route wiring.
// ---------------------------------------------------------------------------

async function seedActiveTenant(shop: string): Promise<void> {
  const s = new TenantStore(env.DB, shop);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await s.seedConfig({
    collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM,
    addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
  });
}

/** Force selfServe.enabled=true through the real store.getConfig() path -
 *  the exact spy pattern tests/affiliate-apply.test.ts's fault-isolation
 *  block uses, since selfServe has no DB column yet (Task 1's decision;
 *  Task 6 owns that persistence). */
function enableSelfServe(): void {
  const origGetConfig = TenantStore.prototype.getConfig;
  vi.spyOn(TenantStore.prototype, 'getConfig').mockImplementation(async function (this: TenantStore) {
    const cfg = await origGetConfig.call(this);
    return cfg ? { ...cfg, selfServe: { ...DEFAULT_SELF_SERVE, enabled: true } } : cfg;
  });
}

function httpEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: 'https://pawscout.example.com', RESEND_API_KEY: 'resend-key', ...overrides } as unknown as Env;
}

function cookieFromSetCookie(header: string | null): string {
  if (!header) throw new Error('no Set-Cookie header');
  const m = header.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!m) throw new Error(`Set-Cookie did not carry ${SESSION_COOKIE_NAME}: ${header}`);
  return m[1];
}

describe('HTTP level: dark by default (no mocking - the real path today)', () => {
  it('GET /affiliate/portal refuses (no login form, no dashboard)', async () => {
    await seedActiveTenant(SHOP);
    const res = await app.request('/affiliate/portal', {}, httpEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).not.toContain('<form');
  });

  it('POST /affiliate/portal/login refuses and sends no email', async () => {
    await seedActiveTenant(SHOP);
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (url: RequestInfo | URL) => { calls.push(String(url)); throw new Error('should not fetch'); }) as unknown as typeof fetch);
    const res = await app.request('/affiliate/portal/login', { method: 'POST', body: new URLSearchParams({ email: 'x@example.com' }) }, httpEnv());
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('GET /affiliate/portal/data refuses', async () => {
    await seedActiveTenant(SHOP);
    const res = await app.request('/affiliate/portal/data', {}, httpEnv());
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe('HTTP level: enabled - full login -> session -> dashboard round trip', () => {
  it('covers no-enumeration, cookie mint/redirect, per-partner isolation, single-use token, and no buyer PII', async () => {
    await seedActiveTenant(SHOP);
    enableSelfServe();
    const s = new TenantStore(env.DB, SHOP);
    const a = await s.upsertAffiliatePartner({ contactEmail: 'live@example.com', name: 'Live Partner' });
    const voucherId = await s.createAffiliateVoucher({
      partnerId: a, code: 'HTTPCODE', pctOff: 10, commissionPct: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z'
    });
    await s.upsertAffiliateOrder({
      shopifyOrderId: 'order-1', voucherId, orderName: '#SUPER-SECRET-ORDER',
      grossGbp: 150, discountGbp: 15, commissionGbp: 15,
      financialStatus: 'paid', eligible: true, placedAt: '2026-07-01T00:00:00.000Z',
      buyerEmailHash: 'buyer-hash-xyz', selfReferral: false
    });
    // Second, unrelated partner - proves cookie A never leaks partner B's numbers.
    const b = await s.upsertAffiliatePartner({ contactEmail: 'other@example.com', name: 'Other Partner' });
    await s.createAffiliateVoucher({
      partnerId: b, code: 'OTHERCODE', pctOff: 10, commissionPct: 10,
      startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z'
    });

    // --- (1) no-enumeration: registered vs random email, byte-identical body ---
    const sentEmails: { to: string; subject: string; text?: string }[] = [];
    vi.stubGlobal('fetch', fakeFetch({ sentEmails }));
    const loginRegistered = await app.request('/affiliate/portal/login', { method: 'POST', body: new URLSearchParams({ email: 'live@example.com' }) }, httpEnv());
    const loginUnregistered = await app.request('/affiliate/portal/login', { method: 'POST', body: new URLSearchParams({ email: 'ghost@example.com' }) }, httpEnv());
    expect(loginRegistered.status).toBe(loginUnregistered.status);
    expect(await loginRegistered.text()).toBe(await loginUnregistered.text());
    expect(sentEmails).toHaveLength(1);
    const rawToken = extractToken(sentEmails[0].text);

    // --- (6) single-use token + cookie mint via 302 redirect ---
    const first = await app.request(`/affiliate/portal?token=${rawToken}`, {}, httpEnv());
    expect(first.status).toBe(302);
    expect(first.headers.get('Referrer-Policy')).toBe('no-referrer');
    const cookieValue = cookieFromSetCookie(first.headers.get('Set-Cookie'));
    const setCookieHeader = first.headers.get('Set-Cookie') ?? '';
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('Secure');
    expect(setCookieHeader).toContain('SameSite=Lax');

    const second = await app.request(`/affiliate/portal?token=${rawToken}`, {}, httpEnv());
    expect(second.status).toBe(200); // not another redirect - the token is already spent
    expect(await second.text()).toMatch(/expired/i);

    // --- (2) valid cookie -> only THIS partner's aggregates ---
    const dashboard = await app.request('/affiliate/portal', { headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` } }, httpEnv());
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('HTTPCODE');
    expect(dashboardHtml).not.toContain('OTHERCODE');

    const dataRes = await app.request('/affiliate/portal/data', { headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` } }, httpEnv());
    expect(dataRes.status).toBe(200);
    const dataBody = (await dataRes.json()) as { ok: boolean; summary?: { vouchers: { code: string }[]; gross_gbp: number; commission_gbp: number } };
    expect(dataBody.ok).toBe(true);
    expect(dataBody.summary!.vouchers.map((v) => v.code)).toEqual(['HTTPCODE']);
    expect(dataBody.summary!.gross_gbp).toBe(150);

    // --- (3) tampered cookie rejected -> login form, no data ---
    const tamperedValue = cookieValue.slice(0, -1) + (cookieValue.endsWith('0') ? '1' : '0');
    const tamperedRes = await app.request('/affiliate/portal', { headers: { Cookie: `${SESSION_COOKIE_NAME}=${tamperedValue}` } }, httpEnv());
    const tamperedHtml = await tamperedRes.text();
    expect(tamperedHtml).not.toContain('HTTPCODE');
    expect(tamperedHtml.toLowerCase()).toContain('<form');

    const tamperedDataRes = await app.request('/affiliate/portal/data', { headers: { Cookie: `${SESSION_COOKIE_NAME}=${tamperedValue}` } }, httpEnv());
    expect(tamperedDataRes.status).toBe(401);

    // --- (4) no buyer PII anywhere in the dashboard or the JSON payload ---
    expect(dashboardHtml).not.toContain('SUPER-SECRET-ORDER');
    expect(dashboardHtml).not.toContain('buyer-hash-xyz');
    const rawData = JSON.stringify(dataBody);
    expect(rawData).not.toContain('SUPER-SECRET-ORDER');
    expect(rawData).not.toContain('buyer-hash-xyz');
    expect(rawData).not.toContain('order_name');
    expect(rawData).not.toContain('buyer_email');
  });
});
