// Liveness and "which commit is live" (deploy-safety phase, 2026-09-18).
//
// Deliberately tiny and free of store data: it is public and unauthenticated so
// the post-deploy smoke test, an uptime check or a person with curl can all ask
// it. `version` is the commit label the deploy script injects with --var;
// 'unknown' means the Worker was deployed some other way, which is itself worth
// knowing. `db` is a real round trip, because a Worker that boots but cannot
// reach D1 is not alive in any useful sense. The round trip itself lives in
// src/tenant-store.ts (fix round 1, 2026-09-18: tests/guard.test.ts allows raw
// D1 access only in that one file, so this file asks pingDatabase rather than
// preparing a statement against the binding directly).
import type { Env } from './types';
import { pingDatabase } from './tenant-store';

export interface HealthReport {
  ok: boolean;
  env: string;
  version: string;
  db: boolean;
}

export async function healthReport(env: Pick<Env, 'DB' | 'GIT_SHA' | 'ENVIRONMENT'>): Promise<HealthReport> {
  let db = false;
  try {
    await pingDatabase(env.DB);
    db = true;
  } catch (e) {
    // Fix round 1 (2026-09-18): a bare `catch { db = false; }` discarded the
    // reason, so a 503 in production told nobody whether D1 was unreachable,
    // misconfigured, or the query itself failed. Log it like the rest of
    // src/index.ts does, so Workers Logs carries the why.
    console.warn(`healthz db check failed: ${(e as Error).message}`);
    db = false;
  }
  // `ok` is the overall verdict; `db` is its only input today. A future check
  // (e.g. a queue or KV probe) should add its own field rather than overload `db`.
  return { ok: db, env: env.ENVIRONMENT || 'unknown', version: env.GIT_SHA || 'unknown', db };
}
