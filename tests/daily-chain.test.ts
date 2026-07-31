/**
 * Resumable daily maintenance - stage-cursor continuation.
 *
 * The nightly outgrew one 15-minute cron invocation (proven live 2026-07-05:
 * killed at 04:32 mid-seeding; the completion stamp had never been written).
 * These tests pin the driver's contract: ordered execution, budget pauses,
 * lease-based mutual exclusion, mid-stage offset checkpoints, best-effort
 * stage failures, CJ gating, and the per-shop completion stamp.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  driveDailyChain, runDailyMaintenance, resumeDailyMaintenance,
  readDailyCursor, writeDailyCursor, chainDeadline,
  JOB_STAMP_DAILY, DAILY_SHOP_STAGES,
  type DailyCursor, type DailyStage, type DailyGlobalStage, type DailyShopCtx
} from '../src/jobs';
import { TenantStore } from '../src/tenant-store';
import type { Env } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

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
});
