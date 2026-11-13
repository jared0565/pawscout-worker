/// <reference types="@cloudflare/vitest-plugin" />
// The AI models routes (spec 5.4, 5.6, 5.6.1, 5.10): GET /api/models serves the
// grouped menu from the OpenRouter feed, POST /api/llm runs the save check
// before storing, and POST /api/models/menu stores the owner's menu controls.
// The feed and every live test that a save needs are seeded in search_cache,
// and fetch is stubbed to throw, so no test here reaches the network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { SignJWT } from 'jose';
import feedJson from './fixtures/openrouter-models-2026-11-13.json';
import { TenantStore } from '../src/tenant-store';
import { app, modelsPayload } from '../src/index';
import { FEED_CACHE_KEY, reduceFeed } from '../src/models-feed';
import { probeCacheKey, type ProbeMode } from '../src/model-probe';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX, type Env, type ReasoningEffort } from '../src/types';

const SHOP = 'mr.myshopify.com';
const SECRET = 'test-shopify-secret';
const LUNA = 'openai/gpt-5.6-luna';
const OPUS = 'anthropic/claude-opus-5.5';
const ALL_LUNA = { image: LUNA, text: LUNA, fallback: LUNA };

let fetchCalls: string[];
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fetchCalls = [];
  vi.stubGlobal('fetch', async (url: unknown) => { fetchCalls.push(String(url)); throw new Error('network is off in this test'); });
});
afterEach(() => { vi.unstubAllGlobals(); });

async function bearer(): Promise<string> {
  return new SignJWT({ dest: `https://${SHOP}`, sub: '1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience((env as unknown as Env).SHOPIFY_API_KEY)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET));
}

async function seed(opts: { feed?: boolean } = {}): Promise<TenantStore> {
  const store = new TenantStore(env.DB, SHOP);
  await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await store.seedConfig({
    collectionMap: {},
    gates: { popularityFloor: 50, priceMin: 5, priceMax: 80, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: { ...DEFAULT_LLM, models: ALL_LUNA },
    addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX,
    target: 16,
  });
  if (opts.feed !== false) await store.putSearchCache(FEED_CACHE_KEY, JSON.stringify(reduceFeed(feedJson)), 1);
  return store;
}

const passed = (store: TenantStore, slug: string, mode: ProbeMode, effort?: ReasoningEffort) =>
  store.putSearchCache(probeCacheKey(slug, mode, effort), '1', 7);

async function call(path: string, method: 'GET' | 'POST', body?: unknown, extraEnv: Record<string, unknown> = { OPENROUTER_API_KEY: 'test-key' }): Promise<Response> {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${await bearer()}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { ...env, SHOPIFY_API_SECRET: SECRET, ...extraEnv } as unknown as Env);
}

const saveLlm = (over: Record<string, unknown> = {}, models: Record<string, unknown> = ALL_LUNA, extraEnv?: Record<string, unknown>) =>
  call('/api/llm', 'POST', { enabled: true, scoreThreshold: 60, models, ...over }, extraEnv);

const storedLlm = async () => (await new TenantStore(env.DB, SHOP).getConfig())!.llm;

describe('GET /api/models', () => {
  it('returns grouped menu, effective settings and slot status', async () => {
    await seed();
    const res = await call('/api/models', 'GET');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.feedAvailable).toBe(true);
    expect(body.groups[0].provider).toBe('anthropic');
    expect(body.groups[0].entries[0].slug).toBe('anthropic/claude-fable-5.2');
    expect(body.menu.providers).toHaveLength(10);
    expect(body.selectedStatus.text.state).toBe('ok');
    expect(body.selectedStatus.text.efforts).toContain('medium');
  });

  it('modelsPayload with no feed returns pins only and feedAvailable false', () => {
    const p = modelsPayload(null, { ...DEFAULT_LLM, models: { text: LUNA }, menu: { providers: ['anthropic'], pins: ['a/b'], hides: [] } }, Date.now());
    expect(p).toMatchObject({ ok: true, feedAvailable: false, selectedStatus: {}, groups: [{ provider: 'a', entries: [{ slug: 'a/b', available: false }] }] });
  });
});

describe('POST /api/llm', () => {
  it('saving only the threshold succeeds with no feed and never fetches it', async () => {
    await seed({ feed: false });
    const res = await saveLlm({ scoreThreshold: 55 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const llm = await storedLlm();
    expect(llm.scoreThreshold).toBe(55);
    expect(llm.models).toEqual(ALL_LUNA);
    expect(fetchCalls).toEqual([]);
  });

  it('an expensive change is held and stores nothing', async () => {
    await seed();
    const res = await saveLlm({}, { ...ALL_LUNA, text: OPUS });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.held[0].slug).toBe(OPUS);
    expect((await storedLlm()).models.text).toBe(LUNA);
  });

  it('confirmCost saves it', async () => {
    const store = await seed();
    await passed(store, OPUS, 'text');
    const res = await saveLlm({ confirmCost: true }, { ...ALL_LUNA, text: OPUS });
    expect(res.status).toBe(200);
    expect((await storedLlm()).models.text).toBe(OPUS);
    expect(fetchCalls).toEqual([]);
  });

  it('an effort change saves only after its live tests, the fallback included', async () => {
    const store = await seed();
    await passed(store, LUNA, 'text', 'low');
    // The fallback runs at the text effort too, and its test has not passed:
    // the live call reaches the stubbed network and fails.
    const refused = await saveLlm({}, { ...ALL_LUNA, textEffort: 'low' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as any).error).toMatch(/^fallback model failed its live test: /);
    expect((await storedLlm()).models.textEffort).toBeUndefined();

    await passed(store, LUNA, 'vision', 'low');
    const res = await saveLlm({}, { ...ALL_LUNA, textEffort: 'low' });
    expect(res.status).toBe(200);
    expect((await storedLlm()).models.textEffort).toBe('low');
  });

  it('dryRun runs the checks and stores nothing', async () => {
    const store = await seed();
    await passed(store, OPUS, 'text');
    const res = await saveLlm({ confirmCost: true, dryRun: true }, { ...ALL_LUNA, text: OPUS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dryRun: true });
    expect((await storedLlm()).models.text).toBe(LUNA);
  });

  it('a change with no OpenRouter key is refused', async () => {
    await seed();
    const res = await saveLlm({}, { ...ALL_LUNA, text: 'anthropic/claude-haiku-5.5' }, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'No OpenRouter key is configured, so new models cannot be tested.' });
  });

  it('answers Not configured for a shop with no config', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
    const res = await saveLlm();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'Not configured' });
  });
});

describe('POST /api/models/menu', () => {
  it('a menu save keeps the models, and a models save keeps the menu', async () => {
    await seed();
    const res = await call('/api/models/menu', 'POST', { providers: ['x-ai'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, menu: { providers: ['x-ai'], pins: [], hides: [] } });
    expect((await saveLlm({ scoreThreshold: 70 })).status).toBe(200);
    const llm = await storedLlm();
    expect(llm.menu?.providers).toEqual(['x-ai']);
    expect(llm.models).toEqual(ALL_LUNA);
    expect(llm.scoreThreshold).toBe(70);
  });

  it('a floating alias pin is refused', async () => {
    await seed();
    const res = await call('/api/models/menu', 'POST', { providers: ['anthropic'], pins: ['~anthropic/claude-sonnet-latest'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).ok).toBe(false);
  });
});
