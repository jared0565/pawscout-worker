/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { TenantStore } from '../src/tenant-store';
import { LlmClient } from '../src/llm';
import { app } from '../src/index';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type Env } from '../src/types';
import { DEFAULT_INBOX } from '../src/inbox/types';
import {
  reserveDeepResearch, researchDemand, DEEP_RESEARCH_TASK, DEEP_RESEARCH_DAILY_CAP_USD, DEEP_RESEARCH_RESERVE_USD,
} from '../src/blog/research';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

// aramid llm-review c1029563 (2026-09-07): the paid web-search research pass
// (~$0.21 a run) could be triggered by any session that reaches the console
// route, with nothing bounding the spend. A Shopify session token carries no
// role claim, so instead of an owner check the route enforces a per-day spend
// cap on the task's own llm_usage rows (the owner accepted "any staff can run
// it" on 2026-10-07). The fast, free source is never capped.
//
// 2026-10-07: the cap used to read the spend BEFORE a run and log it only after
// a SUCCESSFUL one, so a paid search that then failed validation was never
// counted and requests that arrived together all passed. A run's worth of spend
// is now reserved up front in the same statement that checks the cap.
const EVER = '2000-01-01T00:00:00.000Z';
const spend = (s: TenantStore) => s.sumTaskSpendUsdSince(DEEP_RESEARCH_TASK, EVER);
async function rows(shop: string) {
  const rs = await env.DB.prepare(`SELECT model, cost_usd FROM llm_usage WHERE shop = ?1 AND task = ?2 ORDER BY id`).bind(shop, DEEP_RESEARCH_TASK).all<{ model: string; cost_usd: number }>();
  return rs.results ?? [];
}

describe('reserveDeepResearch', () => {
  it('reserves a run\'s worth of spend before the run, so the cap counts it before it is paid for', async () => {
    const s = new TenantStore(env.DB, 'a.myshopify.com');
    const r = await reserveDeepResearch(s);
    expect(r.ok).toBe(true);
    expect(await spend(s)).toBeCloseTo(DEEP_RESEARCH_RESERVE_USD, 5);
  });

  it('refuses when the reservation would take the last 24 hours past the cap, and says what was spent', async () => {
    const s = new TenantStore(env.DB, 'b.myshopify.com');
    for (let i = 0; i < 4; i++) await s.logLlmUsage(DEEP_RESEARCH_TASK, 'm', 100, 100, 0.21);
    await s.logLlmUsage('blog-topics', 'm', 100, 100, 5); // a different task never counts
    const r = await reserveDeepResearch(s);
    expect(r).toEqual({ ok: false, spentUsd: expect.closeTo(0.84, 5), capUsd: DEEP_RESEARCH_DAILY_CAP_USD });
    expect(await spend(s)).toBeCloseTo(0.84, 5); // nothing was reserved
  });

  it('spend older than 24 hours does not count', async () => {
    const s = new TenantStore(env.DB, 'c.myshopify.com');
    await env.DB.prepare(`INSERT INTO llm_usage (shop, task, model, prompt_tokens, completion_tokens, cost_usd, created_at) VALUES (?1, ?2, 'm', 0, 0, 5, ?3)`)
      .bind('c.myshopify.com', DEEP_RESEARCH_TASK, new Date(Date.now() - 25 * 3600_000).toISOString()).run();
    expect((await reserveDeepResearch(s)).ok).toBe(true);
  });

  it('lets through only the runs the cap can pay for when requests arrive together', async () => {
    const s = new TenantStore(env.DB, 'd.myshopify.com');
    const results = await Promise.all(Array.from({ length: 6 }, () => reserveDeepResearch(s)));
    expect(results.filter((r) => r.ok)).toHaveLength(Math.floor(DEEP_RESEARCH_DAILY_CAP_USD / DEEP_RESEARCH_RESERVE_USD));
    expect(await spend(s)).toBeLessThanOrEqual(DEEP_RESEARCH_DAILY_CAP_USD);
  });

  it('the cap is a real amount on the tag only the deep pass writes, and a reservation covers the dearest run measured', () => {
    expect(DEEP_RESEARCH_DAILY_CAP_USD).toBe(1);
    expect(DEEP_RESEARCH_TASK).toBe('blog-demand'); // researchDemand's tag; the fast source logs nothing
    expect(DEEP_RESEARCH_RESERVE_USD).toBeGreaterThan(0.2576); // highest live run, measured 2026-10-07
  });
});

// A minimal OpenRouter-shaped LLM that answers every call with `content` at `costUsd`.
function llmAnswering(content: unknown, costUsd: number): LlmClient {
  const fetchImpl = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, cost: costUsd }, model: 'search-model'
  }), { status: 200 })) as unknown as typeof fetch;
  return new LlmClient({ openrouter: 'k' }, fetchImpl);
}
const CFG = { llm: { models: {} } } as never;
const OPTS = { validHandles: ['pet-health'], catalog: '- Pet Health [pet-health]: a, b', window: { season: 'autumn', months: ['October'] } };
const SIGNALS = { signals: [{ term: 'dog joint supplements', collectionHandle: 'pet-health', why: 'rising', sourceName: 'Trade press', sourceUrl: 'https://example.org/t' }] };

describe('researchDemand with a reservation', () => {
  it('settles the reservation to the real cost instead of adding a second row', async () => {
    const s = new TenantStore(env.DB, 'e.myshopify.com');
    const r = await reserveDeepResearch(s);
    if (!r.ok) throw new Error('expected a reservation');
    const signals = await researchDemand(llmAnswering(SIGNALS, 0.21), s, CFG, { ...OPTS, reservationId: r.reservationId });
    expect(signals).toHaveLength(1);
    expect(await rows('e.myshopify.com')).toEqual([{ model: 'search-model', cost_usd: 0.21 }]);
  });

  it('keeps the reserved amount when the paid call was made but produced nothing usable', async () => {
    const s = new TenantStore(env.DB, 'f.myshopify.com');
    const r = await reserveDeepResearch(s);
    if (!r.ok) throw new Error('expected a reservation');
    const signals = await researchDemand(llmAnswering({ nothing: 'useful' }, 0.21), s, CFG, { ...OPTS, reservationId: r.reservationId });
    expect(signals).toEqual([]);
    expect(await rows('f.myshopify.com')).toEqual([{ model: 'attempted', cost_usd: DEEP_RESEARCH_RESERVE_USD }]);
  });

  it('without a reservation logs the run as before', async () => {
    const s = new TenantStore(env.DB, 'g.myshopify.com');
    await researchDemand(llmAnswering(SIGNALS, 0.21), s, CFG, OPTS);
    expect(await rows('g.myshopify.com')).toEqual([{ model: 'search-model', cost_usd: 0.21 }]);
  });
});

// HTTP level: behind shopOf's session-token auth like every console route.
const SHOP = 'cap.myshopify.com';
const SECRET = 'test-shopify-secret';
async function bearer(): Promise<string> {
  return new SignJWT({ dest: `https://${SHOP}`, sub: '1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience((env as unknown as Env).SHOPIFY_API_KEY)
    .setIssuedAt().setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET));
}
async function seedShop(): Promise<TenantStore> {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await s.seedConfig({
    collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
  });
  return s;
}
async function postTopics(body: unknown) {
  const e = { ...env, SHOPIFY_API_SECRET: SECRET } as unknown as Env;
  return app.request('/api/blog/topics', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await bearer()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, e);
}

describe('POST /api/blog/topics (deep)', () => {
  it('refuses a deep run once the cap is reached, naming the spend', async () => {
    const s = await seedShop();
    for (let i = 0; i < 4; i++) await s.logLlmUsage(DEEP_RESEARCH_TASK, 'm', 1, 1, 0.21);
    const res = await postTopics({ deep: true });
    const j = await res.json() as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain('capped at $1.00 a day');
    expect(j.error).toContain('$0.84');
  });

  it('gives back a reservation the run never used (no Shopify connection, so nothing was searched)', async () => {
    await seedShop();
    const res = await postTopics({ deep: true });
    const j = await res.json() as { ok: boolean; error: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain('Shopify connection unavailable'); // reached the run, which stopped before any search
    expect(await rows(SHOP)).toEqual([]);
  });
});
