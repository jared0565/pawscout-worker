/// <reference types="@cloudflare/vitest-pool-workers" />
// POST /api/fulfil is the console's fulfilment card: the mode buttons, the
// Create-only toggle and "Save alert email". Each press names only mode,
// createOnly and alertEmail, but the stored fulfil block holds more than that
// (gbFreeUkLive, logistics, shipFx, shipHandlingGbp, servedCountries). Found
// 2026-10-08 before the first create-only switch: the route wrote only the
// three fields it was given, so one press of a mode button would have dropped
// the live free UK delivery flag and put every delivery estimate back on the
// wider default processing and customs days.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { TenantStore } from '../src/tenant-store';
import { app } from '../src/index';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX, type Env, type Fulfil } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'fs.myshopify.com';
const SECRET = 'test-shopify-secret';

// The live block as it read on 2026-10-08, plus the three keys no live row
// carries yet, so every kind of setting is covered.
const LIVE: Fulfil = {
  mode: 'manual',
  createOnly: true,
  alertEmail: 'alerts@example.com',
  gbFreeUkLive: true,
  logistics: { processingDaysMin: 1, processingDaysMax: 3, customsDaysMax: 0, transitSlackDays: 2 },
  shipFx: 0.79,
  shipHandlingGbp: 0.5,
  servedCountries: ['GB', 'US'],
};

async function bearer(): Promise<string> {
  return new SignJWT({ dest: `https://${SHOP}`, sub: '1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience((env as unknown as Env).SHOPIFY_API_KEY)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET));
}

async function seed(): Promise<TenantStore> {
  const store = new TenantStore(env.DB, SHOP);
  await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await store.seedConfig({
    collectionMap: {},
    gates: { popularityFloor: 50, priceMin: 5, priceMax: 80, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM,
    addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX,
    target: 16,
  });
  await store.saveFulfil(LIVE);
  return store;
}

async function post(body: unknown): Promise<Response> {
  return app.request('/api/fulfil', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await bearer()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, { ...env, SHOPIFY_API_SECRET: SECRET } as unknown as Env);
}

/** The block exactly as stored, without getConfig's default merge. */
async function storedFulfil(): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare('SELECT fulfil FROM tenant_config WHERE shop = ?1').bind(SHOP).first<{ fulfil: string }>();
  return JSON.parse(row!.fulfil);
}

describe('POST /api/fulfil keeps every setting it was not asked to change', () => {
  it('a mode button changes the mode and nothing else', async () => {
    await seed();
    const res = await post({ mode: 'pawscout' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'pawscout', createOnly: true, alertEmail: 'alerts@example.com' });
    expect(await storedFulfil()).toEqual({ ...LIVE, mode: 'pawscout' });
  });

  it('switching back to Manual (the off switch) keeps them too', async () => {
    const store = await seed();
    await store.saveFulfil({ ...LIVE, mode: 'pawscout' });
    expect((await post({ mode: 'manual' })).status).toBe(200);
    expect(await storedFulfil()).toEqual(LIVE);
  });

  it('the Create-only toggle changes createOnly and nothing else', async () => {
    await seed();
    expect((await post({ mode: 'pawscout', createOnly: false })).status).toBe(200);
    expect(await storedFulfil()).toEqual({ ...LIVE, mode: 'pawscout', createOnly: false });
  });

  it('saving a new alert email changes only the alert email', async () => {
    await seed();
    expect((await post({ mode: 'manual', alertEmail: ' owner@example.com ' })).status).toBe(200);
    expect(await storedFulfil()).toEqual({ ...LIVE, alertEmail: 'owner@example.com' });
  });

  it('clearing the alert email removes that key and keeps the rest', async () => {
    await seed();
    expect((await post({ mode: 'manual', alertEmail: '' })).status).toBe(200);
    const { alertEmail: _cleared, ...rest } = LIVE;
    expect(await storedFulfil()).toEqual(rest);
  });

  it('a refused request writes nothing', async () => {
    await seed();
    expect((await post({ mode: 'auto' })).status).toBe(400);
    expect((await post({ mode: 'manual', alertEmail: 'not-an-email' })).status).toBe(400);
    expect(await storedFulfil()).toEqual(LIVE);
  });
});
