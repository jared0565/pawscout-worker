/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import {
  DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX,
  DEFAULT_SELF_SERVE, type TenantConfig, type Env
} from '../src/types';
import { signTimestamp, MIN_SUBMIT_MS } from '../src/affiliate/gates';
import { handleAffiliateApply, renderApplyForm, renderTermsPage, mxExists, verifyTurnstile, GENERIC_APPLY_MESSAGE, RESEND_COOLDOWN_MS, type ApplyFields } from '../src/affiliate/apply';
import { app } from '../src/index';
import { signAppProxy } from '../src/proxy/verify';
import { hmacHex } from '../src/retention';

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
    SHOPIFY_SCOPES: 's', PAWSCOUT_MASTER_KEY: 'x', TURNSTILE_SECRET: 'turnstile-secret', RESEND_API_KEY: 'resend-key',
    ...overrides
  } as unknown as Env;
}

/** URL-routing fake fetch: Turnstile siteverify, Cloudflare DoH, and Resend
 *  are the only three outbound calls the happy path makes. */
function fakeFetch(opts: { turnstileOk?: boolean; mxOk?: boolean; dohFail?: boolean; resendOk?: boolean; calls?: string[] } = {}): typeof fetch {
  const { turnstileOk = true, mxOk = true, dohFail = false, resendOk = true, calls } = opts;
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    calls?.push(u);
    if (u.includes('challenges.cloudflare.com/turnstile')) {
      return new Response(JSON.stringify({ success: turnstileOk }), { status: 200 });
    }
    if (u.includes('cloudflare-dns.com/dns-query')) {
      if (dohFail) return new Response('', { status: 500 });
      return new Response(JSON.stringify({ Status: 0, Answer: mxOk ? [{ type: 15, data: 'mx.example.com' }] : [] }), { status: 200 });
    }
    if (u.includes('api.resend.com')) {
      return resendOk
        ? new Response(JSON.stringify({ id: 'em_1' }), { status: 200 })
        : new Response(JSON.stringify({ message: 'send failed' }), { status: 500 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as unknown as typeof fetch;
}

const NOW = 2_000_000_000_000;

async function validFields(overrides: Partial<ApplyFields> = {}, nowMs = NOW): Promise<ApplyFields> {
  const ts = await signTimestamp(nowMs - MIN_SUBMIT_MS - 1000, SECRET);
  return {
    name: 'Jane Doe', email: 'jane@example.com', channel_url: 'https://mypetblog.com/reviews',
    audience: 'A pet-focused blog with about 5000 monthly readers interested in dog care.',
    plan: 'I will write a review post and share it across my newsletter and social channels.',
    terms: 'on', website: '', ts, 'cf-turnstile-response': 'tok',
    ...overrides
  };
}

describe('mxExists', () => {
  it('reports MX presence on a normal DoH response', async () => {
    expect(await mxExists('example.com', fakeFetch({ mxOk: true }))).toEqual({ exists: true, failOpen: false });
  });
  it('reports no MX (not fail-open) when DoH answers cleanly with none', async () => {
    expect(await mxExists('example.com', fakeFetch({ mxOk: false }))).toEqual({ exists: false, failOpen: false });
  });
  it('fails OPEN on a DoH outage', async () => {
    expect(await mxExists('example.com', fakeFetch({ dohFail: true }))).toEqual({ exists: true, failOpen: true });
  });
  it('fails OPEN on a network throw', async () => {
    const throwing = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await mxExists('example.com', throwing)).toEqual({ exists: true, failOpen: true });
  });
});

describe('verifyTurnstile', () => {
  it('accepts a successful verification', async () => {
    expect(await verifyTurnstile('tok', 's', '1.2.3.4', fakeFetch({ turnstileOk: true }))).toBe(true);
  });
  it('rejects a failed verification', async () => {
    expect(await verifyTurnstile('tok', 's', '1.2.3.4', fakeFetch({ turnstileOk: false }))).toBe(false);
  });
  it('rejects an empty token without calling out', async () => {
    const calls: string[] = [];
    expect(await verifyTurnstile('', 's', '1.2.3.4', fakeFetch({ calls }))).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('handleAffiliateApply: dark by default', () => {
  it('refuses when selfServe.enabled is false', async () => {
    const fields = await validFields();
    const r = await handleAffiliateApply({ store: store(), cfg: DISABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r).toEqual({ status: 200, body: { ok: false, error: 'Applications are not currently open.' } });
    expect(await store().applicationByEmail('jane@example.com')).toBeNull();
  });

  it('refuses when cfg.selfServe is entirely absent (the real, unwired production path)', async () => {
    const cfg: TenantConfig = { ...ENABLED_CFG, selfServe: undefined };
    const fields = await validFields();
    const r = await handleAffiliateApply({ store: store(), cfg, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r.body.ok).toBe(false);
  });
});

describe('handleAffiliateApply: Turnstile', () => {
  it('HARD-FAILS (never silently skips) when TURNSTILE_SECRET is unset and selfServe.enabled is true', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fields = await validFields();
    const calls: string[] = [];
    const r = await handleAffiliateApply({
      store: store(), cfg: ENABLED_CFG, env: baseEnv({ TURNSTILE_SECRET: undefined }), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch({ calls })
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain('TURNSTILE_SECRET');
    expect(calls).toHaveLength(0); // never even attempted a Turnstile call
    expect(await store().applicationByEmail('jane@example.com')).toBeNull();
    errSpy.mockRestore();
  });

  it('rejects an invalid Turnstile token as a normal (non-uniform) error', async () => {
    const fields = await validFields();
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch({ turnstileOk: false }) });
    expect(r.body.ok).toBe(false);
    expect(await store().applicationByEmail('jane@example.com')).toBeNull();
  });
});

describe('handleAffiliateApply: honeypot + timestamp (silent reject)', () => {
  it('a filled honeypot returns the SAME body as a real success, with nothing recorded', async () => {
    const fields = await validFields({ website: 'http://spam.example' });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r).toEqual({ status: 200, body: { ok: true, message: GENERIC_APPLY_MESSAGE } });
    expect(await store().applicationByEmail('jane@example.com')).toBeNull();
  });

  it('a too-fast submit (under the 3s minimum) is silently rejected the same way', async () => {
    const ts = await signTimestamp(NOW - 500, SECRET); // 0.5s ago, under MIN_SUBMIT_MS
    const fields = await validFields({ ts });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r).toEqual({ status: 200, body: { ok: true, message: GENERIC_APPLY_MESSAGE } });
    expect(await store().applicationByEmail('jane@example.com')).toBeNull();
  });

  it('a tampered/missing timestamp token is silently rejected', async () => {
    const fields = await validFields({ ts: 'garbage' });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r.body).toEqual({ ok: true, message: GENERIC_APPLY_MESSAGE });
    expect(await store().applicationByEmail('jane@example.com')).toBeNull();
  });
});

describe('handleAffiliateApply: field validation', () => {
  it('rejects a missing required field with a distinguishable error', async () => {
    const fields = await validFields({ name: '' });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('name');
  });
});

describe('handleAffiliateApply: email gates', () => {
  it('rejects invalid email syntax', async () => {
    const fields = await validFields({ email: 'not-an-email' });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r.body.ok).toBe(false);
  });

  it('rejects a disposable email domain', async () => {
    const fields = await validFields({ email: 'bob@mailinator.com' });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r.body.ok).toBe(false);
    expect(await store().applicationByEmail('bob@mailinator.com')).toBeNull();
  });

  it('rejects when DoH cleanly reports no MX records', async () => {
    const fields = await validFields({ email: 'nomx@example.com' });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch({ mxOk: false }) });
    expect(r.body.ok).toBe(false);
    expect(await store().applicationByEmail('nomx@example.com')).toBeNull();
  });

  it('fails OPEN on a DoH outage: admits the application and flags doh_failopen', async () => {
    const fields = await validFields({ email: 'carol@example.com' });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '9.9.9.9', nowMs: NOW, fetchImpl: fakeFetch({ dohFail: true }) });
    expect(r.body).toEqual({ ok: true, message: GENERIC_APPLY_MESSAGE });
    const row = await store().applicationByEmail('carol@example.com');
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.flags_json ?? '{}')).toEqual({ doh_failopen: true });
  });
});

describe('handleAffiliateApply: channel URL gates', () => {
  it('rejects an unparseable / non-http(s) channel URL', async () => {
    const fields = await validFields({ channel_url: 'not a url' });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r.body.ok).toBe(false);
  });

  it('rejects a coupon/deal/cashback host', async () => {
    const fields = await validFields({ channel_url: 'https://www.retailmenot.com/some-page', email: 'coupon-applicant@example.com' });
    const r = await handleAffiliateApply({ store: store(), cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r.body.ok).toBe(false);
    expect(await store().applicationByEmail('coupon-applicant@example.com')).toBeNull();
  });

  it('rejects a channel already registered to another application', async () => {
    const s = store();
    await s.insertApplication({ email: 'first@example.com', channelUrl: 'https://takenblog.com/x', stage: 'submitted' });
    const fields = await validFields({ channel_url: 'https://takenblog.com/y', email: 'second@example.com' });
    const r = await handleAffiliateApply({ store: s, cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch() });
    expect(r.body.ok).toBe(false);
    expect(await s.applicationByEmail('second@example.com')).toBeNull();
  });
});

describe('handleAffiliateApply: former-partner gate', () => {
  it('routes a former partner to owner_queue and returns the generic uniform body (no email sent)', async () => {
    const s = store();
    await s.upsertAffiliatePartner({ contactEmail: 'exformer@example.com' }); // no live voucher -> partnerPoolState === 'former'
    expect(await s.partnerPoolState('exformer@example.com')).toBe('former');

    const calls: string[] = [];
    const fields = await validFields({ email: 'exformer@example.com' });
    const r = await handleAffiliateApply({ store: s, cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '1.1.1.1', nowMs: NOW, fetchImpl: fakeFetch({ calls }) });

    expect(r).toEqual({ status: 200, body: { ok: true, message: GENERIC_APPLY_MESSAGE } });
    const row = await s.applicationByEmail('exformer@example.com');
    expect(row).not.toBeNull();
    expect(row!.stage).toBe('owner_queue');
    expect(calls.some((u) => u.includes('api.resend.com'))).toBe(false); // never auto-approve later - no magic link issued
  });
});

describe('handleAffiliateApply: dedupe uniformity (no enumeration)', () => {
  // channelUrlRegistered() matches a submitter's OWN prior application/partner
  // row too (it is a loose global dedupe, not scoped to "someone else's"), so
  // every fixture here deliberately carries the SAME channel_url the
  // resubmission's fields also send - this is what a real "I didn't get the
  // email, let me try again" retry looks like. Without this, the channel gate
  // would shadow the dedupe branches and this test would pass for the wrong
  // reason (a prior, buggy version of apply.ts ran the channel-registered
  // check before the email-keyed dedupe decision and rejected every one of
  // these as "channel already linked" instead of reaching the uniform body).
  const SHARED_CHANNEL = 'https://mypetblog.com/reviews';

  it('live partner, mid-application, and new applicant ALL return the exact same body', async () => {
    const s = store();

    // Live partner: a partner row with a currently-live voucher AND the same
    // channel_url the resubmission below will send.
    const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'livepartner@example.com', channelUrl: SHARED_CHANNEL });
    await s.createAffiliateVoucher({ partnerId, code: 'LIVE10', pctOff: 10, commissionPct: 2, endsAt: '2099-01-01T00:00:00.000Z' });
    expect(await s.partnerPoolState('livepartner@example.com')).toBe('live');

    // Mid-application: an existing 'submitted' application with that same channel_url.
    await s.insertApplication({ email: 'midapp@example.com', channelUrl: SHARED_CHANNEL, stage: 'submitted' });

    const liveCalls: string[] = [];
    const midCalls: string[] = [];
    const newCalls: string[] = [];

    const liveRes = await handleAffiliateApply({
      store: s, cfg: ENABLED_CFG, env: baseEnv(), ip: '1.1.1.1', nowMs: NOW,
      fields: await validFields({ email: 'livepartner@example.com', channel_url: SHARED_CHANNEL }), fetchImpl: fakeFetch({ calls: liveCalls })
    });
    const midRes = await handleAffiliateApply({
      store: s, cfg: ENABLED_CFG, env: baseEnv(), ip: '2.2.2.2', nowMs: NOW,
      fields: await validFields({ email: 'midapp@example.com', channel_url: SHARED_CHANNEL }), fetchImpl: fakeFetch({ calls: midCalls })
    });
    // Brand-new applicant with their OWN, genuinely unclaimed channel - NOT
    // SHARED_CHANNEL, which is deliberately already claimed by the live
    // partner and the mid-application fixtures above (two different people
    // can't both own the same channel; that collision is a real, distinct
    // rejection this test does not exercise).
    const newRes = await handleAffiliateApply({
      store: s, cfg: ENABLED_CFG, env: baseEnv(), ip: '3.3.3.3', nowMs: NOW,
      fields: await validFields({ email: 'brandnew@example.com', channel_url: 'https://a-totally-different-blog.example' }),
      fetchImpl: fakeFetch({ calls: newCalls })
    });

    expect(liveRes).toEqual({ status: 200, body: { ok: true, message: GENERIC_APPLY_MESSAGE } });
    expect(midRes).toEqual(liveRes);
    expect(newRes).toEqual(liveRes);

    // Each branch still sent exactly one differentiated email under the hood.
    expect(liveCalls.filter((u) => u.includes('api.resend.com'))).toHaveLength(1);
    expect(midCalls.filter((u) => u.includes('api.resend.com'))).toHaveLength(1);
    expect(newCalls.filter((u) => u.includes('api.resend.com'))).toHaveLength(1);

    // The mid-application case did NOT create a second application row.
    const allForMid = await s.applicationByEmail('midapp@example.com');
    expect(allForMid?.stage).toBe('submitted');
  });

  it('an end-to-end resubmission (same email, same channel) reaches the resend path, not "channel already linked"', async () => {
    // The discriminating regression test: drive the FIRST submission through
    // the real handler (so the application's channel_url is populated
    // exactly the way production does it), then resubmit with the identical
    // email + channel a safe distance past the resend cooldown.
    const s = store();
    const t0 = Date.now();
    const first = await handleAffiliateApply({
      store: s, cfg: ENABLED_CFG, env: baseEnv(), ip: '10.10.10.10', nowMs: t0,
      fields: await validFields({ email: 'retry@example.com', channel_url: SHARED_CHANNEL }, t0), fetchImpl: fakeFetch()
    });
    expect(first.body).toEqual({ ok: true, message: GENERIC_APPLY_MESSAGE });
    const afterFirst = await s.applicationByEmail('retry@example.com');
    expect(afterFirst?.stage).toBe('submitted');
    expect(afterFirst?.channel_url).toBe(SHARED_CHANNEL);

    const t1 = t0 + RESEND_COOLDOWN_MS + 1000;
    const calls: string[] = [];
    const second = await handleAffiliateApply({
      store: s, cfg: ENABLED_CFG, env: baseEnv(), ip: '10.10.10.10', nowMs: t1,
      fields: await validFields({ email: 'retry@example.com', channel_url: SHARED_CHANNEL }, t1), fetchImpl: fakeFetch({ calls })
    });
    // Must be the uniform GENERIC_OK (mid-application resend), never the
    // distinguishable "This channel is already linked" error.
    expect(second.body).toEqual({ ok: true, message: GENERIC_APPLY_MESSAGE });
    expect(second.body.error).toBeUndefined();
    expect(calls.filter((u) => u.includes('api.resend.com'))).toHaveLength(1); // the resend actually fired
    // Still exactly one application row for this email - no duplicate created.
    const stillOne = await s.applicationByEmail('retry@example.com');
    expect(stillOne?.id).toBe(afterFirst!.id);
  });

  it('a resubmission after a TERMINAL stage (declined) reaches the uniform body, not the channel-registered oracle', async () => {
    // Regression for the latent enumeration oracle flagged in the security
    // review of cd596b2: when the existing row is in a TERMINAL stage
    // (approved/declined/deflected), apply.ts's step 7 deliberately falls
    // through and treats the submission as a brand-new application (someone's
    // circumstances may have changed), then step 8 runs
    // channelUrlRegistered(host). That check does a global LIKE match across
    // affiliate_partners.channel_url AND affiliate_applications.channel_url
    // with no owner/stage filter, so - without excludeEmail - it matches the
    // submitter's OWN prior terminal row and returns the distinguishable
    // `{ok:false, error:'This channel is already linked to another
    // application.'}` body instead of the uniform GENERIC_OK. That is itself
    // a body-level enumeration oracle: an attacker whose earlier application
    // was declined could tell their email+channel combination is already
    // known to the system. Task 3 only ever writes 'submitted'/'owner_queue'
    // stages, so this was latent (unreachable) at the time of that commit,
    // but becomes live the moment any later stage (judging/review) writes a
    // terminal stage - this test seeds one directly to prove the gate itself
    // is closed regardless of what writes the terminal row.
    const s = store();
    await s.insertApplication({ email: 'declined@example.com', channelUrl: SHARED_CHANNEL, stage: 'declined' });

    const calls: string[] = [];
    const r = await handleAffiliateApply({
      store: s, cfg: ENABLED_CFG, env: baseEnv(), ip: '11.11.11.11', nowMs: NOW,
      fields: await validFields({ email: 'declined@example.com', channel_url: SHARED_CHANNEL }, NOW),
      fetchImpl: fakeFetch({ calls })
    });

    expect(r.body).toEqual({ ok: true, message: GENERIC_APPLY_MESSAGE });
    expect(r.body.error).toBeUndefined();
    // A genuinely new application row was created (terminal -> treated as a
    // fresh applicant), not silently rejected as "already linked" to itself.
    const row = await s.applicationByEmail('declined@example.com');
    expect(row?.stage).toBe('submitted');
    expect(calls.filter((u) => u.includes('api.resend.com'))).toHaveLength(1);
  });

  it('a resubmission within the resend cooldown does not send a second email', async () => {
    const s = store();
    await s.insertApplication({ email: 'cooldown@example.com', channelUrl: SHARED_CHANNEL, stage: 'submitted' }); // stamps updated_at with the real wall clock
    const now = Date.now(); // must be close to the row's real updated_at for the cooldown window to apply
    const calls: string[] = [];
    const r = await handleAffiliateApply({
      store: s, cfg: ENABLED_CFG, env: baseEnv(), ip: '4.4.4.4', nowMs: now,
      fields: await validFields({ email: 'cooldown@example.com', channel_url: SHARED_CHANNEL }, now), fetchImpl: fakeFetch({ calls })
    });
    expect(r.body).toEqual({ ok: true, message: GENERIC_APPLY_MESSAGE });
    expect(calls.filter((u) => u.includes('api.resend.com'))).toHaveLength(0);
  });
});

describe('handleAffiliateApply: rate limits (uniform response)', () => {
  // insertApplication always stamps created_at with the REAL wall clock (no
  // override param), so these tests use the real Date.now() as "now" too -
  // the fixed-future NOW constant used elsewhere is fine for gate tests that
  // never compare against a stored created_at/updated_at, but the 24h
  // countApplicationsToday window needs the seeded rows to actually fall
  // inside it.
  it('an IP over its daily cap gets the generic body with no new application created', async () => {
    const s = store();
    const now = Date.now();
    const ip = '77.77.77.77';
    // Minor fix (2026-07-13 final review): ip_hash is now a KEYED HMAC
    // (hmacHex(ip, SHOPIFY_API_SECRET)), not a bare SHA-256 - a raw hash of
    // an IP is brute-forceable offline back to the plaintext address across
    // the whole IPv4 space. baseEnv()'s SHOPIFY_API_SECRET is SECRET.
    const ipHash = await hmacHex(ip, SECRET);
    for (let i = 0; i < 5; i++) {
      await s.insertApplication({ email: `bulk${i}@example.com`, stage: 'submitted', ipHash });
    }
    const calls: string[] = [];
    const fields = await validFields({ email: 'onemore@example.com' }, now);
    const r = await handleAffiliateApply({ store: s, cfg: ENABLED_CFG, env: baseEnv(), fields, ip, nowMs: now, fetchImpl: fakeFetch({ calls }) });
    expect(r).toEqual({ status: 200, body: { ok: true, message: GENERIC_APPLY_MESSAGE } });
    expect(await s.applicationByEmail('onemore@example.com')).toBeNull();
    expect(calls.filter((u) => u.includes('api.resend.com'))).toHaveLength(0);
  });

  it('a non-mainstream email domain over its daily cap is blocked; a mainstream domain at the same count is not', async () => {
    const s = store();
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      await s.insertApplication({ email: `bulk${i}@nichehost.com`, stage: 'submitted', ipHash: `unrelated-ip-${i}` });
    }
    const blockedFields = await validFields({ email: 'newperson@nichehost.com' }, now);
    const blocked = await handleAffiliateApply({ store: s, cfg: ENABLED_CFG, env: baseEnv(), fields: blockedFields, ip: '5.5.5.5', nowMs: now, fetchImpl: fakeFetch() });
    expect(blocked.body).toEqual({ ok: true, message: GENERIC_APPLY_MESSAGE });
    expect(await s.applicationByEmail('newperson@nichehost.com')).toBeNull();

    for (let i = 0; i < 8; i++) {
      await s.insertApplication({ email: `bulk${i}@gmail.com`, stage: 'submitted', ipHash: `unrelated-gmail-ip-${i}` });
    }
    const gmailFields = await validFields({ email: 'newperson@gmail.com' }, now);
    const admitted = await handleAffiliateApply({ store: s, cfg: ENABLED_CFG, env: baseEnv(), fields: gmailFields, ip: '6.6.6.6', nowMs: now, fetchImpl: fakeFetch() });
    expect(admitted.body).toEqual({ ok: true, message: GENERIC_APPLY_MESSAGE });
    expect(await s.applicationByEmail('newperson@gmail.com')).not.toBeNull();
  });
});

describe('handleAffiliateApply: happy path', () => {
  it('inserts a submitted application, issues a verify token, and sends exactly one email', async () => {
    const s = store();
    const calls: string[] = [];
    const fields = await validFields({ email: 'dana@example.com', name: 'Dana' });
    const r = await handleAffiliateApply({ store: s, cfg: ENABLED_CFG, env: baseEnv(), fields, ip: '8.8.8.8', nowMs: NOW, fetchImpl: fakeFetch({ calls }) });

    expect(r).toEqual({ status: 200, body: { ok: true, message: GENERIC_APPLY_MESSAGE } });

    const row = await s.applicationByEmail('dana@example.com');
    expect(row).not.toBeNull();
    expect(row!.stage).toBe('submitted');
    expect(row!.name).toBe('Dana');
    expect(row!.channel_url).toBe('https://mypetblog.com/reviews');

    const resendCalls = calls.filter((u) => u.includes('api.resend.com'));
    expect(resendCalls).toHaveLength(1);
    const turnstileCalls = calls.filter((u) => u.includes('challenges.cloudflare.com'));
    expect(turnstileCalls).toHaveLength(1);
    const dohCalls = calls.filter((u) => u.includes('cloudflare-dns.com'));
    expect(dohCalls).toHaveLength(1);
  });

  // Minor fix (2026-07-13 final review): ip_hash is a keyed HMAC now, not a
  // bare (brute-forceable) SHA-256 of the raw IP.
  it('stores ip_hash as HMAC(ip, SHOPIFY_API_SECRET), not a bare SHA-256', async () => {
    const s = store();
    const ip = '9.9.9.9';
    const fields = await validFields({ email: 'iphash@example.com' });
    await handleAffiliateApply({ store: s, cfg: ENABLED_CFG, env: baseEnv(), fields, ip, nowMs: NOW, fetchImpl: fakeFetch() });

    const row = await s.applicationByEmail('iphash@example.com');
    expect(row?.ip_hash).toBe(await hmacHex(ip, SECRET));
    const bareSha256Buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
    const bareSha256 = [...new Uint8Array(bareSha256Buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(row?.ip_hash).not.toBe(bareSha256);
  });
});

describe('renderApplyForm', () => {
  it('renders the dark-state page when selfServe.enabled is false', async () => {
    const html = await renderApplyForm(DISABLED_CFG, baseEnv(), NOW);
    expect(html).toContain('not currently open');
    expect(html).not.toContain('cf-turnstile');
  });

  it('renders the form with the Turnstile widget, the honeypot field, and a signed timestamp', async () => {
    const html = await renderApplyForm(ENABLED_CFG, baseEnv(), NOW);
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain('name="website"');
    expect(html).toContain('name="ts"');
    expect(html).toContain('name="terms"');
    const match = html.match(/name="ts" value="([^"]+)"/);
    expect(match).toBeTruthy();
    const [tsMs] = match![1].split('.');
    expect(Number(tsMs)).toBe(NOW);
  });

  // Fix 5 (2026-07-13 final review): a plain <form method="post"> with no JS
  // navigated the applicant's browser straight to the POST route's raw JSON
  // body ({"ok":true,...}). The form now carries an id, a result container,
  // an inline interceptor script, and a <noscript> fallback - WITHOUT
  // changing the POST route's own JSON contract (the App Proxy needs 200
  // {ok}; tests/affiliate-apply.test.ts's HTTP-level POST tests already cover
  // that unchanged contract).
  it('carries a submit-interceptor script, a result container, and a <noscript> fallback (no raw-JSON navigation)', async () => {
    const html = await renderApplyForm(ENABLED_CFG, baseEnv(), NOW);
    expect(html).toContain('id="applyForm"');
    expect(html).toContain('id="applyResult"');
    expect(html).toContain('<noscript>');
    // The interceptor: prevents the default navigation, POSTs via fetch, and
    // reads body.ok / body.message / body.error - never lets the browser
    // navigate to the raw JSON response.
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
    expect(scripts.length).toBeGreaterThan(0);
    const body = scripts.join('\n');
    expect(body).toContain('preventDefault');
    expect(body).toContain("addEventListener('submit'");
    expect(body).toContain('body.message');
    expect(body).toContain('body.error');
    // No backticks/${} in the emitted script (this repo's console/browser-JS
    // convention - see src/console/page.ts) - plain string concatenation only.
    expect(body).not.toContain('`');
    expect(body).not.toMatch(/\$\{/);
    // Syntactically valid JS (same guard tests/console.test.ts applies to
    // src/console/page.ts's own inline script).
    for (const s of scripts) {
      expect(() => new Function('return (async function(){' + s + '\n})')).not.toThrow();
    }
  });

  it('the dark-state page carries no interceptor script (no form to intercept)', async () => {
    const html = await renderApplyForm(DISABLED_CFG, baseEnv(), NOW);
    expect(html).not.toContain('id="applyForm"');
    expect(html).not.toContain('<script>');
  });

  it('links the terms checkbox to /apps/pawscout/affiliate/terms', async () => {
    const html = await renderApplyForm(ENABLED_CFG, baseEnv(), NOW);
    expect(html).toContain('href="/apps/pawscout/affiliate/terms"');
  });
});

describe('renderTermsPage', () => {
  it('states the real commission/tier/trial figures from src/inbox/partnership.ts, not invented numbers', () => {
    const html = renderTermsPage(ENABLED_CFG);
    expect(html).toContain('2%');   // STANDARD_COMMISSION_PCT
    expect(html).toContain('5%');   // TRIAL_PCT_OFF_DEFAULT and TIER_MAX_PCT
    expect(html).toContain('25 tracked orders in a 30-day window');
    expect(html).toContain('15 times'); // ENABLED_CFG.selfServe.starterUsageLimit
  });

  it('reads starterUsageLimit from the passed-in config, not a hardcoded default', () => {
    const custom: TenantConfig = { ...ENABLED_CFG, selfServe: { ...ENABLED_CFG.selfServe!, starterUsageLimit: 42 } };
    const html = renderTermsPage(custom);
    expect(html).toContain('42 times');
  });

  it('falls back to DEFAULT_SELF_SERVE when cfg.selfServe is unset', () => {
    const noSelfServe: TenantConfig = { ...ENABLED_CFG, selfServe: undefined };
    const html = renderTermsPage(noSelfServe);
    expect(html).toContain(`${DEFAULT_SELF_SERVE.starterUsageLimit} times`);
  });

  it('carries no <script> (static informational page)', () => {
    expect(renderTermsPage(ENABLED_CFG)).not.toContain('<script>');
  });
});

// --- HTTP level: app.request + a signed App Proxy signature ---------------
// The real, currently-dark path: proxyCtx() sources cfg via store.getConfig(),
// which DOES now persist selfServe (Task 6 wired the DB column + saveSelfServe),
// but this test seeds the tenant via seedConfig() only, never calling
// saveSelfServe - so selfServe merges to DEFAULT_SELF_SERVE (enabled: false),
// same dark-by-default outcome as before Task 6. These two tests cover
// exactly that untouched-config path. The selfServe.enabled=true scenarios
// above are exercised directly against the exported core
// (handleAffiliateApply/renderApplyForm), per the same dependency-injection
// pattern already used by sendEmail/mxExists/etc.

const PROXY_SECRET = 'shpss_proxy_secret';

async function seedActiveTenant(shop: string): Promise<void> {
  const s = new TenantStore(env.DB, shop);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await s.seedConfig({
    collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM,
    addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
  });
}

function proxyEnv(): Env {
  return { ...env, SHOPIFY_API_SECRET: PROXY_SECRET } as unknown as Env;
}

async function signedProxyUrl(path: string, extra: Record<string, string> = {}): Promise<string> {
  const params = { shop: SHOP, path_prefix: '/apps/pawscout', timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  const signature = await signAppProxy(params, PROXY_SECRET);
  const u = new URL(`https://pawscout.example.com${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('signature', signature);
  return u.toString();
}

describe('HTTP level: /proxy/affiliate/apply', () => {
  it('GET rejects a bad/missing proxy signature (no enumeration of the underlying route)', async () => {
    await seedActiveTenant(SHOP);
    const res = await app.request(`https://pawscout.example.com/proxy/affiliate/apply?shop=${SHOP}`, {}, proxyEnv());
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
  });

  it('GET returns the dark-state 200 page (selfServe.enabled defaults false; no saveSelfServe call in this test)', async () => {
    await seedActiveTenant(SHOP);
    const url = await signedProxyUrl('/proxy/affiliate/apply');
    const res = await app.request(url, {}, proxyEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('not currently open');
  });

  it('POST returns the same dark-state refusal as JSON', async () => {
    await seedActiveTenant(SHOP);
    const url = await signedProxyUrl('/proxy/affiliate/apply');
    const res = await app.request(url, { method: 'POST', body: new URLSearchParams({ name: 'X' }) }, proxyEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body).toEqual({ ok: false, error: 'Applications are not currently open.' });
  });
});

describe('HTTP level: /proxy/affiliate/terms', () => {
  it('GET rejects a bad/missing proxy signature', async () => {
    await seedActiveTenant(SHOP);
    const res = await app.request(`https://pawscout.example.com/proxy/affiliate/terms?shop=${SHOP}`, {}, proxyEnv());
    const body = (await res.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
  });

  it('GET returns 200 with the real terms content, independent of selfServe.enabled', async () => {
    await seedActiveTenant(SHOP); // seedConfig only - selfServe merges to DEFAULT_SELF_SERVE (enabled: false)
    const url = await signedProxyUrl('/proxy/affiliate/terms');
    const res = await app.request(url, {}, proxyEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Active Paw Partner Program - Terms');
    expect(html).not.toContain('not currently open'); // terms are not gated dark like the form
  });
});

// --- HTTP level: fault isolation --------------------------------------------
// Every /proxy/* response MUST be HTTP 200 (Shopify's App Proxy replaces any
// non-2xx response with a generic error page - see /proxy/search and
// /proxy/product's try/catch in src/index.ts). handleAffiliateApply makes
// several raw D1 calls that can throw; the POST route must never let one of
// those escape as an uncaught exception (which Hono's default error handler
// turns into a 500). Reaching a D1 call requires selfServe.enabled=true,
// which the real getConfig() path can't produce yet (see the block comment
// above) - so this test forces it via a getConfig spy that calls through to
// the real implementation and merges in selfServe.enabled=true, then makes
// the FIRST D1 call inside handleAffiliateApply (partnerPoolState) throw.
describe('HTTP level: /proxy/affiliate/apply - fault isolation', () => {
  it('POST returns the uniform GENERIC_OK body, never a 500, when a D1 call inside handleAffiliateApply throws', async () => {
    await seedActiveTenant(SHOP);

    const origGetConfig = TenantStore.prototype.getConfig;
    vi.spyOn(TenantStore.prototype, 'getConfig').mockImplementation(async function (this: TenantStore) {
      const cfg = await origGetConfig.call(this);
      return cfg ? { ...cfg, selfServe: { ...DEFAULT_SELF_SERVE, enabled: true } } : cfg;
    });
    const poolSpy = vi.spyOn(TenantStore.prototype, 'partnerPoolState').mockRejectedValue(new Error('D1 boom'));
    vi.stubGlobal('fetch', fakeFetch({ turnstileOk: true }));

    const nowMs = Date.now();
    const ts = await signTimestamp(nowMs - MIN_SUBMIT_MS - 1000, PROXY_SECRET); // signed with THIS route's SHOPIFY_API_SECRET, not validFields()'s SECRET
    const body = new URLSearchParams({
      name: 'Jane Doe', email: 'jane@example.com', channel_url: 'https://mypetblog.com/reviews',
      audience: 'A pet blog with real readers interested in dog care and grooming tips.',
      plan: 'I will write reviews and share them with my newsletter subscribers.',
      terms: 'on', website: '', ts, 'cf-turnstile-response': 'tok'
    });
    const url = await signedProxyUrl('/proxy/affiliate/apply');
    const testEnv = { ...proxyEnv(), TURNSTILE_SECRET: 'test-turnstile-secret' } as unknown as Env;
    const res = await app.request(url, { method: 'POST', body }, testEnv);

    expect(res.status).toBe(200);
    const parsed = (await res.json()) as { ok: boolean; error?: string; message?: string };
    // CRITICAL: identical to the normal uniform success body (GENERIC_OK) -
    // not a distinguishable ok:false error, which would itself be an
    // enumeration/oracle leak (a D1 hiccup must never read differently from
    // a normal "check your email" outcome).
    expect(parsed).toEqual({ ok: true, message: GENERIC_APPLY_MESSAGE });
    // Confirms the throw actually happened INSIDE handleAffiliateApply (not
    // that some earlier gate silently short-circuited for an unrelated reason).
    expect(poolSpy).toHaveBeenCalled();
  });
});
