/// <reference types="@cloudflare/vitest-pool-workers" />
// Fail-closed gate tests for the TEMPORARY token-gated admin routes of the
// free-UK-delivery initiative (2026-07-03): /api/admin/seed-gb (step D per-keyword
// GB draft seeding) and /api/admin/free-uk-cutover (ordered cutover runner).
// (Replaces the tests for the June /api/admin/seed-gb-origin route, torn down in
// 76442b3 - this file had been left pointing at the removed route.)
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';

for (const path of ['/api/admin/seed-gb', '/api/admin/free-uk-cutover']) {
  describe(`POST ${path}`, () => {
    it('rejects a missing/wrong MAINT_TOKEN', async () => {
      const res = await app.request(path, { method: 'POST' }, { ...env, MAINT_TOKEN: 'secret' });
      expect(res.status).toBe(401);
    });

    it('rejects even a matching header when MAINT_TOKEN is unset (fail-closed)', async () => {
      const res = await app.request(
        path,
        { method: 'POST', headers: { 'X-Maint-Token': 'anything' } },
        { ...env, MAINT_TOKEN: undefined }
      );
      expect(res.status).toBe(401);
    });

    it('rejects a bad body even with a valid token (validation after auth)', async () => {
      const res = await app.request(
        path,
        { method: 'POST', headers: { 'X-Maint-Token': 'secret', 'Content-Type': 'application/json' }, body: '{}' },
        { ...env, MAINT_TOKEN: 'secret' }
      );
      expect(res.status).toBe(400);
    });
  });
}
