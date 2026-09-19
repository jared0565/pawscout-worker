/**
 * Resumable daily maintenance - stage-cursor continuation.
 *
 * The nightly outgrew one 15-minute cron invocation (proven live 2026-07-05:
 * killed at 04:32 mid-seeding; the completion stamp had never been written).
 * These tests pin the driver's contract: ordered execution, budget pauses,
 * lease-based mutual exclusion, mid-stage offset checkpoints, best-effort
 * stage failures, CJ gating, and the per-shop completion stamp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  driveDailyChain, runDailyMaintenance, resumeDailyMaintenance,
  readDailyCursor, writeDailyCursor, chainDeadline,
  JOB_STAMP_DAILY, JOB_STAMP_ORDER_HOOKS, DAILY_SHOP_STAGES, nextConsecutiveFailures,
  type DailyCursor, type DailyStage, type DailyShopCtx, type StoredWebhookStatus
} from '../src/jobs';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig, type Env } from '../src/types';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { REQUIRED_TOPICS } from '../src/webhooks';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
// I-3 (fix round 1): the order-webhooks stage's own alertOwner call is a real
// no-op without a RESEND_API_KEY, so a call and a non-call are indistinguishable
// from the outside unless the actual Resend HTTP call is captured. vi.mock on a
// relative src module does not intercept under the Workers pool (tried first,
// confirmed empirically: the real alertOwner still ran and threw on a bare
// cfg). vi.stubGlobal('fetch', ...) is the pattern already used elsewhere in
// this repo (tests/affiliate-portal.test.ts, tests/affiliate-apply.test.ts) and
// does work here, so the order-webhooks stage tests below give ctx a real
// RESEND_API_KEY + alertEmail and capture the outbound Resend call instead.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const E = env as unknown as Env;
const SHOP = 'a.myshopify.com';
const MIN = 60_000;

function freshCursor(over: Partial<DailyCursor> = {}): DailyCursor {
  return { date: '2026-07-05', shops: [SHOP], g: 0, si: 0, ss: 0, ssName: null, off: null, leaseUntil: 0, ...over };
}

/** Minimal ctx: a real TenantStore (for the completion stamp) + stub cj. */
function fakeCtx(shop: string, opts: { cj?: unknown } = {}): DailyShopCtx {
  return {
    env: E, shop, store: new TenantStore(env.DB, shop),
    admin: (async () => ({})) as never, cfg: {} as never,
    cj: (opts.cj === undefined ? ({} as never) : (opts.cj as never)), llm: {} as never,
  } as DailyShopCtx;
}

const stage = (name: string, run: DailyStage['run'], over: Partial<DailyStage> = {}): DailyStage =>
  ({ name, maxMs: MIN, run, ...over });

describe('daily cursor persistence', () => {
  it('roundtrips, overwrites, and deletes', async () => {
    expect(await readDailyCursor(env.DB)).toBeNull();
    const cur = freshCursor({ ss: 3, ssName: 'x', off: 7 });
    await writeDailyCursor(env.DB, cur);
    expect(await readDailyCursor(env.DB)).toEqual(cur);
    await writeDailyCursor(env.DB, { ...cur, ss: 4, off: null });
    expect((await readDailyCursor(env.DB))!.ss).toBe(4);
    await writeDailyCursor(env.DB, null);
    expect(await readDailyCursor(env.DB)).toBeNull();
  });
});

describe('chainDeadline', () => {
  it('stops 90s before the next quarter-hour, or uses the following window near a boundary', () => {
    const base = Date.UTC(2026, 6, 5, 4, 17, 5); // 04:17:05 -> boundary 04:30
    expect(chainDeadline(base)).toBe(Date.UTC(2026, 6, 5, 4, 30, 0) - 90_000);
    const nearBoundary = Date.UTC(2026, 6, 5, 4, 29, 30); // deadline 04:28:30 already past
    expect(chainDeadline(nearBoundary)).toBe(Date.UTC(2026, 6, 5, 4, 45, 0) - 90_000);
  });
});

describe('driveDailyChain', () => {
  it('runs global then shop stages in order, stamps the shop, and deletes the cursor', async () => {
    const calls: string[] = [];
    await writeDailyCursor(env.DB, freshCursor());
    await driveDailyChain(E, {
      globalStages: [{ name: 'g1', maxMs: MIN, run: async () => { calls.push('g1'); } }],
      shopStages: [stage('a', async () => { calls.push('a'); }), stage('b', async () => { calls.push('b'); })],
      buildCtx: async (_e, _v, shop) => fakeCtx(shop),
      deadlineMs: Date.now() + 10 * MIN,
    });
    expect(calls).toEqual(['g1', 'a', 'b']);
    expect(await readDailyCursor(env.DB)).toBeNull(); // chain complete
    const stamp = await new TenantStore(env.DB, SHOP).getSearchCache(JOB_STAMP_DAILY);
    expect(stamp).toBeTruthy(); // completion stamp written only at the true end
  });

  it('defers a stage that does not fit the window and resumes it next drive', async () => {
    const calls: string[] = [];
    const stages = [
      stage('small', async () => { calls.push('small'); }),
      stage('huge', async () => { calls.push('huge'); }, { maxMs: 60 * MIN }),
    ];
    await writeDailyCursor(env.DB, freshCursor());
    await driveDailyChain(E, {
      globalStages: [], shopStages: stages,
      buildCtx: async (_e, _v, shop) => fakeCtx(shop),
      deadlineMs: Date.now() + 5 * MIN, // 'huge' cannot fit
    });
    expect(calls).toEqual(['small']);
    const cur = (await readDailyCursor(env.DB))!;
    expect(cur.ss).toBe(1); // parked ON the deferred stage
    expect(await new TenantStore(env.DB, SHOP).getSearchCache(JOB_STAMP_DAILY)).toBeNull(); // no premature stamp

    await driveDailyChain(E, {
      globalStages: [], shopStages: stages,
      buildCtx: async (_e, _v, shop) => fakeCtx(shop),
      deadlineMs: Date.now() + 90 * MIN,
    });
    expect(calls).toEqual(['small', 'huge']);
    expect(await readDailyCursor(env.DB)).toBeNull();
  });

  it('a live lease means another invocation is mid-stage: no-op', async () => {
    const calls: string[] = [];
    await writeDailyCursor(env.DB, freshCursor({ leaseUntil: Date.now() + 5 * MIN }));
    await driveDailyChain(E, {
      globalStages: [], shopStages: [stage('a', async () => { calls.push('a'); })],
      buildCtx: async (_e, _v, shop) => fakeCtx(shop),
      deadlineMs: Date.now() + 10 * MIN,
    });
    expect(calls).toEqual([]);
    expect((await readDailyCursor(env.DB))!.ss).toBe(0); // untouched
  });

  it('an expired lease is taken over (the killed-invocation recovery path)', async () => {
    const calls: string[] = [];
    await writeDailyCursor(env.DB, freshCursor({ ss: 0, ssName: 'a', leaseUntil: Date.now() - 1000 }));
    await driveDailyChain(E, {
      globalStages: [], shopStages: [stage('a', async () => { calls.push('a'); })],
      buildCtx: async (_e, _v, shop) => fakeCtx(shop),
      deadlineMs: Date.now() + 10 * MIN,
    });
    expect(calls).toEqual(['a']); // stage re-run (at-least-once), chain completes
    expect(await readDailyCursor(env.DB)).toBeNull();
  });

  it('a throwing stage warns and advances - one broken stage no longer kills the night', async () => {
    const calls: string[] = [];
    await writeDailyCursor(env.DB, freshCursor());
    await driveDailyChain(E, {
      globalStages: [],
      shopStages: [
        stage('boom', async () => { throw new Error('stage exploded'); }),
        stage('after', async () => { calls.push('after'); }),
      ],
      buildCtx: async (_e, _v, shop) => fakeCtx(shop),
      deadlineMs: Date.now() + 10 * MIN,
    });
    expect(calls).toEqual(['after']);
    expect(await readDailyCursor(env.DB)).toBeNull();
    expect(await new TenantStore(env.DB, SHOP).getSearchCache(JOB_STAMP_DAILY)).toBeTruthy();
  });

  it('checkpoints a mid-stage offset and passes it back on resume', async () => {
    const seenOffsets: number[] = [];
    let paused = false;
    const walker = stage('walk', async (_ctx, offset) => {
      seenOffsets.push(offset);
      if (!paused) { paused = true; return 7; } // deadline hit at offset 7
    });
    await writeDailyCursor(env.DB, freshCursor());
    await driveDailyChain(E, {
      globalStages: [], shopStages: [walker],
      buildCtx: async (_e, _v, shop) => fakeCtx(shop),
      deadlineMs: Date.now() + 10 * MIN,
    });
    const cur = (await readDailyCursor(env.DB))!;
    expect(cur.off).toBe(7);
    expect(cur.ssName).toBe('walk');
    await driveDailyChain(E, {
      globalStages: [], shopStages: [walker],
      buildCtx: async (_e, _v, shop) => fakeCtx(shop),
      deadlineMs: Date.now() + 10 * MIN,
    });
    expect(seenOffsets).toEqual([0, 7]);
    expect(await readDailyCursor(env.DB)).toBeNull();
  });

  it('skips CJ stages for a shop without a CJ credential but still stamps completion', async () => {
    const calls: string[] = [];
    await writeDailyCursor(env.DB, freshCursor());
    await driveDailyChain(E, {
      globalStages: [],
      shopStages: [
        stage('cull-like', async () => { calls.push('cull-like'); }, { needsCj: false }),
        stage('cj-only', async () => { calls.push('cj-only'); }),
      ],
      buildCtx: async (_e, _v, shop) => fakeCtx(shop, { cj: null }),
      deadlineMs: Date.now() + 10 * MIN,
    });
    expect(calls).toEqual(['cull-like']);
    expect(await readDailyCursor(env.DB)).toBeNull();
    expect(await new TenantStore(env.DB, SHOP).getSearchCache(JOB_STAMP_DAILY)).toBeTruthy();
  });

  it('re-resolves the stage index by name when a deploy reshapes the list mid-day', async () => {
    const calls: string[] = [];
    // Cursor parked on 'b' at index 0 (the old list had 'b' first); the new list
    // has a fresh stage inserted before it. 'b' must resume, 'new-first' must not
    // re-run (it belongs to positions already passed under the old list).
    await writeDailyCursor(env.DB, freshCursor({ ss: 0, ssName: 'b' }));
    await driveDailyChain(E, {
      globalStages: [],
      shopStages: [
        stage('new-first', async () => { calls.push('new-first'); }),
        stage('b', async () => { calls.push('b'); }),
        stage('c', async () => { calls.push('c'); }),
      ],
      buildCtx: async (_e, _v, shop) => fakeCtx(shop),
      deadlineMs: Date.now() + 10 * MIN,
    });
    expect(calls).toEqual(['b', 'c']);
  });

  it('no cursor -> no-op (resume path is one cheap read)', async () => {
    await expect(resumeDailyMaintenance(E)).resolves.toBeUndefined();
  });
});

describe('runDailyMaintenance (entry point on an empty test tenant set)', () => {
  it('seeds a fresh cursor, drives the real chain to completion, and clears it', async () => {
    // No tenants in the test DB: global purges run against D1, cj-logistics
    // no-ops (no shop with CJ credentials), shop list is empty -> chain
    // completes in one drive and the cursor is gone. Deadline pinned far out so
    // the test never depends on the wall-clock minute.
    await runDailyMaintenance(E, { deadlineMs: Date.now() + 60 * MIN });
    expect(await readDailyCursor(env.DB)).toBeNull();
  });

  it('drops an unfinished chain from yesterday and starts fresh', async () => {
    await writeDailyCursor(env.DB, freshCursor({ date: '2026-07-04', si: 0, ss: 5, ssName: 'store-inventory' }));
    await runDailyMaintenance(E, { deadlineMs: Date.now() + 60 * MIN });
    expect(await readDailyCursor(env.DB)).toBeNull(); // fresh chain for an empty tenant set completes
  });
});

// STAGE ORDERING IS A CORRECTNESS CONSTRAINT, NOT A PREFERENCE.
//
// The cull is the only automated takedown left, and archiveProductGuarded
// refuses unless the referrer index is complete and recent. Rebuilt AFTER the
// cull, the index would be a day old every night and brand new never - so the
// first night would archive nothing and every later night would decide from
// yesterday's article set.
describe('DAILY_SHOP_STAGES ordering', () => {
  it('rebuilds the referrer index before the cull reads it', () => {
    const names = DAILY_SHOP_STAGES.map((s) => s.name);
    expect(names).toContain('referrer-index');
    expect(names.indexOf('referrer-index')).toBeLessThan(names.indexOf('cull'));
  });

  it('the referrer-index stage does not need CJ - it reads Shopify only', () => {
    // A shop without CJ credentials still culls, so its index must still build.
    const s = DAILY_SHOP_STAGES.find((x) => x.name === 'referrer-index')!;
    expect(s.needsCj).toBe(false);
  });

  // I-3: the order-webhooks stage must be FIRST (Task 6's brief calls this out
  // explicitly) and must not need CJ (a shop with no CJ credential still needs
  // its order-event subscriptions checked).
  it('order-webhooks is first, and does not need CJ', () => {
    expect(DAILY_SHOP_STAGES[0].name).toBe('order-webhooks');
    expect(DAILY_SHOP_STAGES[0].needsCj).toBe(false);
  });
});

// I-3 (fix round 1): the order-webhooks stage itself, driven directly with a
// fake ctx.admin - the "unknown is not missing" behaviour (I-4) and the daily
// cache write, exercised end to end through the real, exported stage.
describe('order-webhooks stage', () => {
  const HOOK_APP_URL = 'https://hook-test.pawscout.example.com';
  const orderWebhooksStage = DAILY_SHOP_STAGES.find((s) => s.name === 'order-webhooks')!;

  // N-3 (fix round 2): every test in this describe stubs fetch by default,
  // throwing on any call, so a reordering of the stage's own internals can
  // never let a test reach the real network (api.resend.com) even if it
  // forgets to call captureAlerts() itself. captureAlerts() below re-stubs
  // fetch with its own capturing implementation, which simply replaces this
  // default for the tests that need to observe what was sent.
  beforeEach(() => {
    vi.stubGlobal('fetch', (async (url: RequestInfo | URL) => {
      throw new Error(`order-webhooks stage test reached the real network: ${String(url)}`);
    }) as unknown as typeof fetch);
  });

  /** A fake AdminGraphql for the webhook-subscription list/create calls. Registers
   *  every REQUIRED_TOPICS entry except `missingTopics`; a create for a topic in
   *  `failCreateFor` answers a real userError (so it stays missing after the
   *  read-back); `listError` makes every list call throw (nothing is ever known). */
  function hookAdmin(opts: { missingTopics?: string[]; failCreateFor?: Set<string>; listError?: string } = {}): AdminGraphql {
    const missing = new Set(opts.missingTopics ?? []);
    const registered = REQUIRED_TOPICS.filter((t) => !missing.has(t.topic)).map((t) => ({ topic: t.topic, uri: `${HOOK_APP_URL}${t.path}` }));
    return (async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('webhookSubscriptions(')) {
        if (opts.listError) throw new Error(opts.listError);
        return { webhookSubscriptions: { nodes: registered.map((r, i) => ({ id: `gid://${i}`, ...r })) } };
      }
      const topic = variables!.topic as string;
      const uri = variables!.uri as string;
      if (opts.failCreateFor?.has(topic)) {
        return { webhookSubscriptionCreate: { userErrors: [{ message: 'create failed' }], webhookSubscription: null } };
      }
      registered.push({ topic, uri });
      return { webhookSubscriptionCreate: { userErrors: [], webhookSubscription: { id: 'gid://new' } } };
    }) as unknown as AdminGraphql;
  }

  const ALERT_CFG: TenantConfig = {
    collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM,
    addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: { ...DEFAULT_INBOX, alertEmail: 'owner@example.com' }, target: 12
  };

  function hookCtx(admin: AdminGraphql, shop = SHOP): DailyShopCtx {
    return {
      env: { ...E, SHOPIFY_APP_URL: HOOK_APP_URL, RESEND_API_KEY: 'rk' } as Env,
      shop, store: new TenantStore(env.DB, shop),
      admin, cfg: ALERT_CFG, cj: {} as never, llm: {} as never,
    } as DailyShopCtx;
  }

  async function storedHooks(shop = SHOP): Promise<StoredWebhookStatus | null> {
    const raw = await new TenantStore(env.DB, shop).getSearchCache(JOB_STAMP_ORDER_HOOKS);
    return raw ? (JSON.parse(raw) as StoredWebhookStatus) : null;
  }

  /** Captures every outbound Resend send as { subject, text } - the only way
   *  to observe an alertOwner call from outside jobs.ts, since it is called
   *  there with no injectable fetchImpl (see the file-level comment above). */
  function captureAlerts(): { subject: string; text: string }[] {
    const sent: { subject: string; text: string }[] = [];
    vi.stubGlobal('fetch', (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).includes('api.resend.com')) throw new Error(`unexpected fetch to ${String(url)}`);
      const body = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as unknown as typeof fetch);
    return sent;
  }

  it('a verified status with ORDERS_CANCELLED missing stores it under JOB_STAMP_ORDER_HOOKS and sends the brief\'s exact alert', async () => {
    const sent = captureAlerts();
    const admin = hookAdmin({ missingTopics: ['ORDERS_CANCELLED'], failCreateFor: new Set(['ORDERS_CANCELLED']) });
    await orderWebhooksStage.run(hookCtx(admin), 0, Date.now() + 10 * MIN);

    const stored = await storedHooks();
    expect(stored?.verified).toBe(true);
    expect(stored?.missing).toEqual(['ORDERS_CANCELLED']);
    expect(stored?.consecutiveFailures).toBe(0);

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Order events are not fully subscribed');
    expect(sent[0].text).toBe(
      'These Shopify order events are not reaching PawScout: ORDERS_CANCELLED. Until they do, a cancelled or refunded order can go unnoticed after the supplier order exists. Open the console and press "Check order events".'
    );
  });

  it('a verified status missing only APP_UNINSTALLED stores it and sends nothing', async () => {
    const sent = captureAlerts();
    const admin = hookAdmin({ missingTopics: ['APP_UNINSTALLED'], failCreateFor: new Set(['APP_UNINSTALLED']) });
    await orderWebhooksStage.run(hookCtx(admin), 0, Date.now() + 10 * MIN);

    const stored = await storedHooks();
    expect(stored?.verified).toBe(true);
    expect(stored?.missing).toEqual(['APP_UNINSTALLED']);
    expect(stored?.consecutiveFailures).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('an unverified status sends nothing for two nights running, then the exact "could not be checked" alert on the third, with consecutiveFailures 1, 2, 3 - and a verified night after that resets it to 0', async () => {
    const sent = captureAlerts();
    const failingAdmin = hookAdmin({ listError: 'network down' });

    await orderWebhooksStage.run(hookCtx(failingAdmin), 0, Date.now() + 10 * MIN);
    expect((await storedHooks())?.verified).toBe(false);
    expect((await storedHooks())?.consecutiveFailures).toBe(1);
    expect(sent).toHaveLength(0);

    await orderWebhooksStage.run(hookCtx(failingAdmin), 0, Date.now() + 10 * MIN);
    expect((await storedHooks())?.consecutiveFailures).toBe(2);
    expect(sent).toHaveLength(0);

    await orderWebhooksStage.run(hookCtx(failingAdmin), 0, Date.now() + 10 * MIN);
    expect((await storedHooks())?.consecutiveFailures).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Order event subscriptions could not be checked');
    expect(sent[0].text).toBe(
      'PawScout has not been able to check its Shopify order event subscriptions for 3 days in a row (network down). Until a check succeeds, it is not known whether cancelled or refunded orders reach PawScout. Open the console and press "Check order events".'
    );

    // Night 4: a verified check resets consecutiveFailures to 0 and, since
    // nothing is missing, sends nothing further.
    const healthyAdmin = hookAdmin({});
    await orderWebhooksStage.run(hookCtx(healthyAdmin), 0, Date.now() + 10 * MIN);
    const finalStored = await storedHooks();
    expect(finalStored?.verified).toBe(true);
    expect(finalStored?.consecutiveFailures).toBe(0);
    expect(sent).toHaveLength(1); // unchanged from night 3
  });

  it('a throw inside the stage does not stop the next stage', async () => {
    const calls: string[] = [];
    const admin = hookAdmin({}); // ensureWebhooks itself succeeds and never throws
    const throwingCtx = hookCtx(admin);
    // Force a genuine throw AFTER ensureWebhooks succeeds, from the store write
    // the stage makes next - the same shape of failure driveDailyChain's
    // generic try/catch (already proven in "a throwing stage warns and
    // advances") must tolerate for this stage too.
    throwingCtx.store.putSearchCache = async () => { throw new Error('boom'); };
    await writeDailyCursor(env.DB, freshCursor());
    await driveDailyChain(E, {
      globalStages: [],
      shopStages: [orderWebhooksStage, stage('after', async () => { calls.push('after'); })],
      buildCtx: async () => throwingCtx,
      deadlineMs: Date.now() + 10 * MIN,
    });
    expect(calls).toEqual(['after']);
    expect(await readDailyCursor(env.DB)).toBeNull();
  });
});

// N-4 (fix round 2): nextConsecutiveFailures's defensive branches, pinned
// directly rather than only relied on by reading. Every case here is an
// UNVERIFIED night (verified: true always short-circuits to 0, already
// covered by the night-4 assertion above), so each of these should give 1 -
// a missing or unusable previous value counts as though there were no prior
// failed night, and this is the first one.
describe('nextConsecutiveFailures (N-4)', () => {
  it('a missing previous value (first night) gives 1', () => {
    expect(nextConsecutiveFailures(null, false)).toBe(1);
  });

  it('an unparseable previous value gives 1', () => {
    expect(nextConsecutiveFailures('not json {{{', false)).toBe(1);
  });

  it('a parseable previous value that is not an object gives 1', () => {
    expect(nextConsecutiveFailures('42', false)).toBe(1);
    expect(nextConsecutiveFailures('"a string"', false)).toBe(1);
    expect(nextConsecutiveFailures('null', false)).toBe(1);
  });

  it('a parseable object without a consecutiveFailures field gives 1', () => {
    expect(nextConsecutiveFailures(JSON.stringify({ verified: false }), false)).toBe(1);
  });
});
