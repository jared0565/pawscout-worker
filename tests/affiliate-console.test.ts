/// <reference types="@cloudflare/vitest-pool-workers" />
// Task 6: console visibility + owner overrides for the self-serve affiliate
// funnel. Three things live here: (1) the /api/affiliate/config validator
// (reject NaN/negative caps -> error, like every other config saver in
// validate.ts), (2) the Applications list/approve/decline functions the
// console routes call directly (this repo's convention: no test drives a
// session-token-authed /api route through app.request - see
// tests/partners-routes.test.ts, tests/profit-console.test.ts - so these are
// tested as plain functions, with the Hono route left as a thin wrapper),
// and (3) the GDPR customers/redact webhook wiring: the one-line index.ts fix
// that makes the webhook actually compute+pass hashBuyerEmail so
// buyer_email_hash on affiliate_orders can be nulled (Task 1 built the store
// method + the emailHash param; Task 2 built hashBuyerEmail; nothing wired
// them together until now).
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  TenantStore, AFFILIATE_STAGE_SUBMITTED, AFFILIATE_STAGE_VERIFIED, AFFILIATE_STAGE_APPROVED,
  AFFILIATE_STAGE_DEFLECTED, AFFILIATE_STAGE_DECLINED, AFFILIATE_STAGE_OWNER_QUEUE, type AffiliateApplicationRow
} from '../src/tenant-store';
import {
  DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX,
  DEFAULT_SELF_SERVE, type TenantConfig, type Env
} from '../src/types';
import { validateSelfServePayload } from '../src/validate';
import { LlmClient } from '../src/llm';
import { defaultFetch } from '../src/safe-fetch';
import { getApplicationsConsole, approveApplicationAnyway, declineApplicationById } from '../src/affiliate/console';
import type { ScreenDeps } from '../src/affiliate/screen';
import { hashBuyerEmail } from '../src/affiliate-attribution';
import { app } from '../src/index';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const store = () => new TenantStore(env.DB, SHOP);

const CFG: TenantConfig = {
  collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: { ...DEFAULT_INBOX, alertEmail: 'owner@example.com' }, target: 12,
  selfServe: { enabled: true, autoIssueCapPerDay: 5, screenSpendCapGbpPerDay: 2, scoreThreshold: 8, starterUsageLimit: 15 }
};

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB, SHOPIFY_API_KEY: 'k', SHOPIFY_API_SECRET: 'sec', SHOPIFY_APP_URL: 'https://pawscout.example.com',
    SHOPIFY_SCOPES: 's', PAWSCOUT_MASTER_KEY: 'x',
    // No RESEND_API_KEY: sendEmail short-circuits to {ok:false} without a
    // network call (src/email.ts), so approve/decline emails are safe no-ops
    // here - no fetch mocking needed for these tests.
    ...overrides
  } as unknown as Env;
}

function depsFor(admin: AdminGraphql | null, cfg: TenantConfig = CFG): ScreenDeps {
  return {
    env: baseEnv(), store: store(), cfg,
    llm: new LlmClient({}), admin, fetchImpl: defaultFetch
  };
}

function fakeAdmin(opts: { createError?: string } = {}): AdminGraphql {
  return (async (q: string) => {
    if (q.includes('pawscoutActivePromos')) return { automaticDiscountNodes: { nodes: [] }, codeDiscountNodes: { nodes: [] } };
    if (q.includes('pawscoutVoucherCreate')) {
      if (opts.createError) return { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: opts.createError }] } };
      return { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } };
    }
    return {};
  }) as unknown as AdminGraphql;
}

async function seedApp(overrides: { email?: string; name?: string | null; channelUrl?: string; stage?: string; score?: number } = {}): Promise<AffiliateApplicationRow> {
  const s = store();
  const id = await s.insertApplication({
    email: overrides.email ?? 'star@example.com',
    name: overrides.name === undefined ? 'Star Creator' : overrides.name,
    channelUrl: overrides.channelUrl ?? 'https://petstar.example.com',
    stage: overrides.stage ?? AFFILIATE_STAGE_OWNER_QUEUE,
  });
  if (overrides.score !== undefined) await s.updateApplicationStage(id, overrides.stage ?? AFFILIATE_STAGE_OWNER_QUEUE, { score: overrides.score });
  const row = await s.getApplication(id);
  if (!row) throw new Error('seed failed');
  return row;
}

describe('validateSelfServePayload', () => {
  const VALID = { enabled: true, autoIssueCapPerDay: 5, screenSpendCapGbpPerDay: 2, scoreThreshold: 8, starterUsageLimit: 15 };

  it('accepts a fully-populated, in-range payload', () => {
    const v = validateSelfServePayload(VALID);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toEqual(VALID);
  });

  it('rejects a non-boolean enabled', () => {
    const v = validateSelfServePayload({ ...VALID, enabled: 'yes' });
    expect(v.ok).toBe(false);
  });

  it('rejects NaN caps', () => {
    const v = validateSelfServePayload({ ...VALID, autoIssueCapPerDay: NaN });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('autoIssueCapPerDay');
  });

  it('rejects a negative cap', () => {
    const v = validateSelfServePayload({ ...VALID, screenSpendCapGbpPerDay: -1 });
    expect(v.ok).toBe(false);
  });

  it('rejects a score threshold outside 0-12', () => {
    expect(validateSelfServePayload({ ...VALID, scoreThreshold: 13 }).ok).toBe(false);
    expect(validateSelfServePayload({ ...VALID, scoreThreshold: -1 }).ok).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(validateSelfServePayload(null).ok).toBe(false);
    expect(validateSelfServePayload('nope').ok).toBe(false);
  });
});

describe('getApplicationsConsole', () => {
  it('lists applications mapped for the UI and echoes the effective selfServe config', async () => {
    await seedApp({ email: 'a@x.com', stage: AFFILIATE_STAGE_SUBMITTED });
    await seedApp({ email: 'b@x.com', stage: AFFILIATE_STAGE_OWNER_QUEUE, score: 6 });
    const r = await getApplicationsConsole(store(), CFG);
    expect(r.applications).toHaveLength(2);
    expect(r.applications.map((a) => a.email).sort()).toEqual(['a@x.com', 'b@x.com']);
    expect(r.selfServe).toEqual(CFG.selfServe);
  });

  it('falls back to DEFAULT_SELF_SERVE when cfg has none', async () => {
    const r = await getApplicationsConsole(store(), { ...CFG, selfServe: undefined });
    expect(r.selfServe).toEqual(DEFAULT_SELF_SERVE);
  });

  it('summarizes flags_json into a short human string', async () => {
    const app0 = await seedApp({ email: 'c@x.com', stage: AFFILIATE_STAGE_DEFLECTED });
    await store().updateApplicationStage(app0.id, AFFILIATE_STAGE_DEFLECTED, { flagsJson: JSON.stringify({ channelJudge: 'parked page' }) });
    const r = await getApplicationsConsole(store(), CFG);
    const row = r.applications.find((a) => a.email === 'c@x.com');
    expect(row?.flagsSummary).toContain('parked page');
  });
});

describe('approveApplicationAnyway', () => {
  it('issues the bounded starter voucher (through issueVoucher) for an owner_queue application', async () => {
    const a = await seedApp({ email: 'owner-queue@x.com', stage: AFFILIATE_STAGE_OWNER_QUEUE, score: 5 });
    const r = await approveApplicationAnyway(depsFor(fakeAdmin()), a.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.application.stage).toBe(AFFILIATE_STAGE_APPROVED);
    const vouchers = await store().listAffiliateVouchers();
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0].pct_off).toBe(5);
    expect(vouchers[0].commission_pct).toBe(2);
    // bounded starter tier, never an unlimited code (usage_limit is not on
    // the console-facing listAffiliateVouchers row - read it back raw).
    const raw = await env.DB.prepare(`SELECT usage_limit FROM affiliate_vouchers WHERE shop = ?1`)
      .bind(SHOP).first<{ usage_limit: number | null }>();
    expect(raw?.usage_limit).toBe(CFG.selfServe!.starterUsageLimit);
  });

  it('also approves a deflected application', async () => {
    const a = await seedApp({ email: 'deflected@x.com', stage: AFFILIATE_STAGE_DEFLECTED, score: 3 });
    const r = await approveApplicationAnyway(depsFor(fakeAdmin()), a.id);
    expect(r.ok).toBe(true);
  });

  it('refuses to approve an application in an ineligible stage', async () => {
    const a = await seedApp({ email: 'verified@x.com', stage: AFFILIATE_STAGE_VERIFIED });
    const r = await approveApplicationAnyway(depsFor(fakeAdmin()), a.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/owner_queue|deflected/);
    expect(await store().listAffiliateVouchers()).toHaveLength(0);
  });

  it('reports the Shopify error and issues no voucher when issueVoucher fails', async () => {
    const a = await seedApp({ email: 'fails@x.com', stage: AFFILIATE_STAGE_OWNER_QUEUE });
    const r = await approveApplicationAnyway(depsFor(fakeAdmin({ createError: 'code already exists' })), a.id);
    expect(r.ok).toBe(false);
    expect(await store().listAffiliateVouchers()).toHaveLength(0);
  });

  it('returns an error for an unknown application id', async () => {
    const r = await approveApplicationAnyway(depsFor(fakeAdmin()), 'nope');
    expect(r.ok).toBe(false);
  });
});

describe('declineApplicationById', () => {
  it('declines an owner_queue application', async () => {
    const a = await seedApp({ email: 'decline-me@x.com', stage: AFFILIATE_STAGE_OWNER_QUEUE });
    const r = await declineApplicationById(depsFor(null), a.id);
    expect(r.ok).toBe(true);
    const after = await store().getApplication(a.id);
    expect(after?.stage).toBe(AFFILIATE_STAGE_DECLINED);
  });

  it('refuses to decline an already-approved application', async () => {
    const a = await seedApp({ email: 'already-approved@x.com', stage: AFFILIATE_STAGE_APPROVED });
    const r = await declineApplicationById(depsFor(null), a.id);
    expect(r.ok).toBe(false);
  });

  it('refuses to decline an already-declined application', async () => {
    const a = await seedApp({ email: 'already-declined@x.com', stage: AFFILIATE_STAGE_DECLINED });
    const r = await declineApplicationById(depsFor(null), a.id);
    expect(r.ok).toBe(false);
  });

  it('returns an error for an unknown application id', async () => {
    const r = await declineApplicationById(depsFor(null), 'nope');
    expect(r.ok).toBe(false);
  });
});

// --- GDPR wiring: customers/redact webhook computes+passes the buyer hash ---
// Task 1 built redactContact(email, emailHash?) and the store-level null-out
// (tests/affiliate-selfserve-store.test.ts). Task 2 built hashBuyerEmail. This
// is the missing wire: src/index.ts's /webhooks/customers-redact handler must
// actually call hashBuyerEmail and pass it through, or buyer_email_hash could
// never be redacted from a live GDPR request. Drives the REAL Hono app with a
// correctly-HMAC-signed request (base64 HMAC-SHA256 of the raw body, matching
// @shopify/shopify-api's webhooks.validate - see node_modules/@shopify/shopify-api
// /dist/cjs/lib/utils/hmac-validator.js).
async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  let binary = '';
  for (const b of new Uint8Array(sig)) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe('GDPR: customers/redact webhook wiring (HTTP level)', () => {
  const WEBHOOK_SECRET = 'test-webhook-secret';

  function webhookEnv(): Env {
    return { ...env, SHOPIFY_API_SECRET: WEBHOOK_SECRET, SHOPIFY_APP_URL: 'https://pawscout.example.com' } as unknown as Env;
  }

  it('nulls buyer_email_hash on a matching affiliate_orders row', async () => {
    const s = store();
    const email = 'buyer@example.com';
    const emailHash = await hashBuyerEmail(email, WEBHOOK_SECRET);
    const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'partner@x.com' });
    const voucherId = await s.createAffiliateVoucher({ partnerId, code: 'HOOK10', pctOff: 10, commissionPct: 5, endsAt: '2099-01-01T00:00:00.000Z' });
    await s.upsertAffiliateOrder({
      shopifyOrderId: 'ord-hook-1', voucherId, orderName: '#1', grossGbp: 20, discountGbp: 2, commissionGbp: 1,
      financialStatus: 'paid', eligible: true, placedAt: '2026-07-01T00:00:00.000Z', buyerEmailHash: emailHash,
    });

    const payload = JSON.stringify({ orders_to_redact: [], customer: { email } });
    const hmac = await hmacBase64(WEBHOOK_SECRET, payload);
    const res = await app.request('https://pawscout.example.com/webhooks/customers-redact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': hmac,
        'X-Shopify-Topic': 'customers/redact',
        'X-Shopify-Shop-Domain': SHOP,
        'X-Shopify-Webhook-Id': 'whk-1',
        'X-Shopify-API-Version': '2025-07',
      },
      body: payload,
    }, webhookEnv());
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(`SELECT buyer_email_hash FROM affiliate_orders WHERE shop = ?1 AND shopify_order_id = 'ord-hook-1'`)
      .bind(SHOP).first<{ buyer_email_hash: string | null }>();
    expect(row?.buyer_email_hash).toBeNull();
  });
});
