/// <reference types="@cloudflare/vitest-pool-workers" />
// /healthz (2026-09-18, deploy-safety phase): the one public answer to "is this
// deploy alive, and which commit is it". No store data, no auth, never cached.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { healthReport } from '../src/health';
import { pingDatabase } from '../src/tenant-store';
import type { Env } from '../src/types';

const base = env as unknown as Env;
const brokenDb = { prepare: () => { throw new Error('D1 down'); } } as unknown as D1Database;

// The D1 failure path now logs (fix round 1, 2026-09-18: a silent catch left
// Workers Logs with no clue why /healthz went 503). Every test spies on
// console.warn so the run stays clean either way, and the specific tests below
// assert on what did or did not get logged.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// pingDatabase lives in src/tenant-store.ts (fix round 1, 2026-09-18: the
// tenant-isolation guard, tests/guard.test.ts, allows raw D1 access only in
// that one file). healthReport calls it rather than touching D1 itself.
describe('pingDatabase', () => {
  it('resolves on a real round trip against the test database', async () => {
    await expect(pingDatabase(base.DB)).resolves.toBeUndefined();
  });

  it('rejects when prepare throws', async () => {
    await expect(pingDatabase(brokenDb)).rejects.toThrow('D1 down');
  });

  it('rejects when the row is not { one: 1 }', async () => {
    const wrongRowDb = { prepare: () => ({ first: async () => ({ one: 2 }) }) } as unknown as D1Database;
    await expect(pingDatabase(wrongRowDb)).rejects.toThrow();
  });
});

describe('healthReport', () => {
  it('reports ok with the injected commit and environment when the database answers', async () => {
    const r = await healthReport({ DB: base.DB, GIT_SHA: 'abc123def456', ENVIRONMENT: 'staging' });
    expect(r).toEqual({ ok: true, env: 'staging', version: 'abc123def456', db: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('says unknown rather than guessing when nothing was injected', async () => {
    const r = await healthReport({ DB: base.DB });
    expect(r.version).toBe('unknown');
    expect(r.env).toBe('unknown');
  });

  it('reports not ok when the database throws, and logs why', async () => {
    const r = await healthReport({ DB: brokenDb, GIT_SHA: 'abc123def456', ENVIRONMENT: 'production' });
    expect(r).toEqual({ ok: false, env: 'production', version: 'abc123def456', db: false });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('healthz');
    expect(message).toContain('D1 down');
  });
});

describe('GET /healthz', () => {
  it('answers 200, uncached, with nothing but the four fields', async () => {
    const e = { ...base, GIT_SHA: 'abc123def456', ENVIRONMENT: 'staging' } as Env;
    const res = await app.request('/healthz', {}, e);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, env: 'staging', version: 'abc123def456', db: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('answers 503 when the database check fails, and logs why', async () => {
    const e = { ...base, DB: brokenDb } as Env;
    const res = await app.request('/healthz', {}, e);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('healthz');
    expect(message).toContain('D1 down');
  });
});
