/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';

describe('POST /api/admin/seed-gb-origin', () => {
  it('rejects a missing/wrong MAINT_TOKEN', async () => {
    const res = await app.request('/api/admin/seed-gb-origin', { method: 'POST' }, { ...env, MAINT_TOKEN: 'secret' });
    expect(res.status).toBe(401);
  });

  it('rejects when MAINT_TOKEN is unset (no header sent)', async () => {
    const res = await app.request('/api/admin/seed-gb-origin', { method: 'POST' }, { ...env, MAINT_TOKEN: undefined });
    expect(res.status).toBe(401);
  });
});
