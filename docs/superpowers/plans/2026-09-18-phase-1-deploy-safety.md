# Phase 1: Deploy Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bad commit, a bad migration or a bad deploy cannot silently hurt the live shop, and anyone can tell which commit is live.

**Architecture:** One new public route (`/healthz`) reports liveness and the deployed commit. Three Node command-line scripts (smoke test, migration rehearsal, guarded deploy) keep every decision in pure functions under `scripts/lib/`, tested with `node --test`; the thin wrappers only run programs and print. A staging environment and a GitHub Actions workflow give deploys and commits somewhere to fail harmlessly.

**Tech Stack:** Cloudflare Workers (wrangler 3.114), Hono, D1, vitest 4 with `@cloudflare/vitest-pool-workers`, Node 24 (`node:test`, `node:child_process`), GitHub Actions, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-18-production-grade-programme-prd.md`, section 5.

## Task list

| # | Task | Owner | Files |
|---|---|---|---|
| 0 | Shared groundwork: npm scripts, `Env` fields, program runner | orchestrator | `package.json`, `src/types.ts`, `scripts/lib/run.mjs`, `wrangler.toml` (one var) |
| 1 | `/healthz` | agent A | `src/health.ts`, `tests/health.test.ts`, `src/index.ts` |
| 2 | Smoke test | agent B | `scripts/lib/smoke-checks.mjs`, `scripts/lib/smoke-checks.nodetest.mjs`, `scripts/smoke.mjs` |
| 3 | Migration rehearsal | agent C | `scripts/lib/rehearsal.mjs`, `scripts/lib/rehearsal.nodetest.mjs`, `scripts/rehearse-migrations.mjs` |
| 4 | Guarded deploy | agent D | `scripts/lib/deploy-guards.mjs`, `scripts/lib/deploy-guards.nodetest.mjs`, `scripts/deploy.mjs` |
| 5 | Runbook and decision record | agent E | `docs/RUNBOOK-DEPLOY.md`, `docs/decisions/0001-deploy-safety.md` |
| 6 | CI workflow, then the red-run proof | orchestrator | `.github/workflows/ci.yml` |
| 7 | Staging environment (D1, config, secrets, first deploy) | orchestrator | `wrangler.toml` |
| 8 | Acceptance: the five exit criteria of PRD 5.6 | orchestrator | none |
| 9 | Compatibility date, on staging first | orchestrator | `wrangler.toml` |

Tasks 1 to 5 touch disjoint files and run in parallel. Tasks 0, 6, 7, 8, 9 are sequential and stay with the orchestrator because they touch shared files or live infrastructure.

## Global Constraints

- No em dash and no en dash anywhere: code, comments, docs, output strings. Use a hyphen, a comma or a colon.
- Agents never run `git commit`, `git push`, `wrangler deploy`, `wrangler d1 ... --remote`, `wrangler secret`, or `wrangler rollback`. The orchestrator commits through the gate and owns all live infrastructure.
- Agents touch only the files named in their task. `package.json`, `wrangler.toml`, `src/types.ts` and `scripts/lib/run.mjs` are already prepared by task 0: read them, do not edit them.
- Never pass `--no-verify` to git.
- Test first. Watch the test fail for the right reason before writing the implementation, and report the failing output.
- Node script tests are named `*.nodetest.mjs`, never `*.test.mjs`: vitest's default include would pick up `*.test.mjs` and try to run `node:test` inside workerd.
- Scripts run programs through `scripts/lib/run.mjs` only: argument arrays, no shell, no string concatenation into a command line.
- Match the repo's voice: comments explain WHY, in full sentences, with a date where a decision is recorded.
- Before editing `src/index.ts` (a shared core file) run `python -P -m graphite context src/index.ts` and `python -P -m graphite impact src/index.ts` and read what they flag.
- Windows console is cp1252: a Python helper that prints must call `sys.stdout.reconfigure(encoding="utf-8")`.
- Verify each command's own exit code, never a pipe's.
- The version label is the first 12 characters of the commit hash, with `-dirty` appended only on a staging deploy from a dirty tree. `/healthz`, the deploy script and the smoke test all use this same label.

---

### Task 0: Shared groundwork (orchestrator)

**Files:**
- Modify: `package.json` (scripts), `src/types.ts` (two optional `Env` fields), `wrangler.toml` (`ENVIRONMENT` var)
- Create: `scripts/lib/run.mjs`

**Interfaces:**
- Produces: npm scripts `test:scripts`, `smoke`, `migrate:rehearse`, `deploy`, `deploy:raw`; `Env.GIT_SHA?: string`, `Env.ENVIRONMENT?: string`; from `scripts/lib/run.mjs`: `ROOT`, `run(cmd, args, opts)`, `runWrangler(args, opts)`, `runGit(args)`, `runGh(args)`, `runNode(script, args, opts)`, `d1Rows(database, sql, { remote, persistTo, envName })`. Every runner returns `{ status: number, stdout: string, stderr: string }`; `d1Rows` returns an array of row objects and throws an `Error` naming the failure.

- [ ] **Step 1:** Add to `package.json` scripts: `"test:scripts": "node --test \"scripts/lib/*.nodetest.mjs\""`, `"smoke": "node scripts/smoke.mjs"`, `"migrate:rehearse": "node scripts/rehearse-migrations.mjs"`, `"deploy": "node scripts/deploy.mjs"`, `"deploy:raw": "wrangler deploy"`.
- [ ] **Step 2:** Add to `Env` in `src/types.ts`: `GIT_SHA?: string` (commit label injected by the deploy script with `--var`; absent means an unguarded deploy) and `ENVIRONMENT?: string` (`production` or `staging`, set in `wrangler.toml`).
- [ ] **Step 3:** Add `ENVIRONMENT = "production"` under the top-level `[vars]` in `wrangler.toml`.
- [ ] **Step 4:** Create `scripts/lib/run.mjs`:

```js
// scripts/lib/run.mjs
//
// The ONE place the deploy-safety scripts start other programs. Every call is
// an argument ARRAY with no shell, so nothing a script builds is ever parsed by
// cmd.exe or sh. wrangler is started through node and its own entry file for
// the same reason: `npx` is a .cmd on Windows and would need a shell.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return {
    status: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? String(r.error) : '')
  };
}

export const runWrangler = (args, opts) => run(process.execPath, [WRANGLER, ...args], opts);
export const runGit = (args) => run('git', args);
export const runGh = (args) => run('gh', args);
export const runNode = (script, args, opts) => run(process.execPath, [path.join(ROOT, script), ...args], opts);

// Rows of ONE SQL statement. wrangler --json prints an array with one entry per
// statement on success and an { error } object on failure; both are handled
// here so no caller ever reads a failure as "zero rows".
export function d1Rows(database, sql, { remote = true, persistTo = null, envName = null } = {}) {
  const args = ['d1', 'execute', database, remote ? '--remote' : '--local', '--json', '--command', sql];
  if (persistTo) args.push('--persist-to', persistTo);
  if (envName) args.push('--env', envName);
  const r = runWrangler(args);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`d1 query gave no JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
  if (!Array.isArray(parsed)) {
    const notes = (parsed?.error?.notes || []).map((n) => n.text).join('; ');
    throw new Error(`d1 query failed: ${parsed?.error?.text || 'unknown error'} ${notes}`.trim());
  }
  return parsed[0]?.results || [];
}
```

- [ ] **Step 5:** `npm run typecheck` and `npm run lint`, both exit 0.

---

### Task 1: `/healthz` (agent A)

**Files:**
- Create: `src/health.ts`
- Create: `tests/health.test.ts`
- Modify: `src/index.ts` (one import, one route, placed directly after the `app.get('/app', ...)` route near line 85)

**Interfaces:**
- Consumes: `Env.GIT_SHA`, `Env.ENVIRONMENT` (task 0).
- Produces: `GET /healthz` answering `{ ok: boolean, env: string, version: string, db: boolean }`, status 200 when `ok`, 503 when not, header `Cache-Control: no-store`. `healthReport(env)` exported from `src/health.ts`.

- [ ] **Step 1: Read the ground.** Run `python -P -m graphite context src/index.ts` and `python -P -m graphite impact src/index.ts`. Confirm no `app.use` middleware covers `/healthz`. Read how `tests/traffic-quality.test.ts` builds the env object it passes as the third argument of `app.request`, and build yours the same way.

- [ ] **Step 2: Write the failing test** `tests/health.test.ts`:

```ts
/// <reference types="@cloudflare/vitest-pool-workers" />
// /healthz (2026-09-18, deploy-safety phase): the one public answer to "is this
// deploy alive, and which commit is it". No store data, no auth, never cached.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { app } from '../src/index';
import { healthReport } from '../src/health';
import type { Env } from '../src/types';

const base = env as unknown as Env;
const brokenDb = { prepare: () => { throw new Error('D1 down'); } } as unknown as D1Database;

describe('healthReport', () => {
  it('reports ok with the injected commit and environment when the database answers', async () => {
    const r = await healthReport({ DB: base.DB, GIT_SHA: 'abc123def456', ENVIRONMENT: 'staging' });
    expect(r).toEqual({ ok: true, env: 'staging', version: 'abc123def456', db: true });
  });

  it('says unknown rather than guessing when nothing was injected', async () => {
    const r = await healthReport({ DB: base.DB });
    expect(r.version).toBe('unknown');
    expect(r.env).toBe('unknown');
  });

  it('reports not ok when the database throws', async () => {
    const r = await healthReport({ DB: brokenDb, GIT_SHA: 'abc123def456', ENVIRONMENT: 'production' });
    expect(r).toEqual({ ok: false, env: 'production', version: 'abc123def456', db: false });
  });
});

describe('GET /healthz', () => {
  it('answers 200, uncached, with nothing but the four fields', async () => {
    const e = { ...base, GIT_SHA: 'abc123def456', ENVIRONMENT: 'staging' } as Env;
    const res = await app.request('/healthz', {}, e);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, env: 'staging', version: 'abc123def456', db: true });
  });

  it('answers 503 when the database check fails', async () => {
    const e = { ...base, DB: brokenDb } as Env;
    const res = await app.request('/healthz', {}, e);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail.** `npx vitest run tests/health.test.ts`. Expected: FAIL, cannot resolve `../src/health`.

- [ ] **Step 4: Implement** `src/health.ts`:

```ts
// Liveness and "which commit is live" (deploy-safety phase, 2026-09-18).
//
// Deliberately tiny and free of store data: it is public and unauthenticated so
// the post-deploy smoke test, an uptime check or a person with curl can all ask
// it. `version` is the commit label the deploy script injects with --var;
// 'unknown' means the Worker was deployed some other way, which is itself worth
// knowing. `db` is a real round trip, because a Worker that boots but cannot
// reach D1 is not alive in any useful sense.
import type { Env } from './types';

export interface HealthReport {
  ok: boolean;
  env: string;
  version: string;
  db: boolean;
}

export async function healthReport(env: Pick<Env, 'DB' | 'GIT_SHA' | 'ENVIRONMENT'>): Promise<HealthReport> {
  let db = false;
  try {
    const row = await env.DB.prepare('SELECT 1 AS one').first<{ one: number }>();
    db = row?.one === 1;
  } catch {
    db = false;
  }
  return { ok: db, env: env.ENVIRONMENT || 'unknown', version: env.GIT_SHA || 'unknown', db };
}
```

and in `src/index.ts`, add `import { healthReport } from './health';` with the other local imports, and directly after the `/app` route:

```ts
// Liveness + deployed commit for the smoke test and for anyone with curl.
// Public by design: see src/health.ts for what it may and may not reveal.
app.get('/healthz', async (c) => {
  const report = await healthReport(c.env);
  return c.json(report, report.ok ? 200 : 503, { 'Cache-Control': 'no-store' });
});
```

- [ ] **Step 5: Run it and watch it pass.** `npx vitest run tests/health.test.ts` exits 0 with 5 passing. Then `npx vitest run tests/console.test.ts tests/traffic-quality.test.ts` (neighbours that import `src/index`), `npm run typecheck`, `npm run lint`: all exit 0.

- [ ] **Step 6: Report** the failing output from step 3, the passing output from step 5, and the exact lines changed in `src/index.ts`. Do not commit.

---

### Task 2: Smoke test (agent B)

**Files:**
- Create: `scripts/lib/smoke-checks.mjs`, `scripts/lib/smoke-checks.nodetest.mjs`, `scripts/smoke.mjs`

**Interfaces:**
- Consumes: the `/healthz` contract of task 1; `GET /public/event` answers 200 `{ active: boolean, ... }` or 503 `{ error: 'unavailable' }`; `GET /app` answers 200 `text/html`.
- Produces: command `node scripts/smoke.mjs <base-url> [--expect-version <label>] [--allow-unavailable] [--attempts <n>] [--delay-ms <n>]`. Exit 0 all checks pass, 1 a check failed, 2 bad usage. Defaults: 12 attempts, 5000 ms apart. Exports `checkHealthz`, `checkPublicEvent`, `checkApp`, `parseSmokeArgs`, `allPassed`.

Why the retry: measured on this stack, a request right after a deploy can still be served by the previous version for about 15 seconds. The smoke test polls until every check passes or the attempts run out.

- [ ] **Step 1: Write the failing test** `scripts/lib/smoke-checks.nodetest.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealthz, checkPublicEvent, checkApp, parseSmokeArgs, allPassed } from './smoke-checks.mjs';

const healthy = { ok: true, env: 'staging', version: 'abc123def456', db: true };

test('healthz passes on a healthy body and reports env and version', () => {
  const r = checkHealthz(200, healthy, 'abc123def456');
  assert.equal(r.ok, true);
  assert.match(r.detail, /staging/);
  assert.match(r.detail, /abc123def456/);
});

test('healthz fails when the deployed version is not the expected one', () => {
  const r = checkHealthz(200, healthy, 'ffffffffffff');
  assert.equal(r.ok, false);
  assert.match(r.detail, /abc123def456/);
  assert.match(r.detail, /ffffffffffff/);
});

test('healthz passes without an expected version', () => {
  assert.equal(checkHealthz(200, healthy, null).ok, true);
});

test('healthz fails on a non-200, a false ok, a false db, and a missing body', () => {
  assert.equal(checkHealthz(503, { ...healthy, ok: false, db: false }, null).ok, false);
  assert.equal(checkHealthz(200, { ...healthy, ok: false }, null).ok, false);
  assert.equal(checkHealthz(200, { ...healthy, db: false }, null).ok, false);
  assert.equal(checkHealthz(200, null, null).ok, false);
});

test('public event passes on a boolean active', () => {
  assert.equal(checkPublicEvent(200, { active: false }, false).ok, true);
  assert.equal(checkPublicEvent(200, { active: true, code: 'X' }, false).ok, true);
});

test('public event fails when active is not a boolean', () => {
  assert.equal(checkPublicEvent(200, { active: 'no' }, false).ok, false);
  assert.equal(checkPublicEvent(200, null, false).ok, false);
});

test('503 unavailable fails on production and passes only when explicitly allowed', () => {
  assert.equal(checkPublicEvent(503, { error: 'unavailable' }, false).ok, false);
  assert.equal(checkPublicEvent(503, { error: 'unavailable' }, true).ok, true);
  assert.equal(checkPublicEvent(503, { error: 'boom' }, true).ok, false);
  assert.equal(checkPublicEvent(500, { error: 'unavailable' }, true).ok, false);
});

test('app passes only on 200 html', () => {
  assert.equal(checkApp(200, 'text/html; charset=UTF-8').ok, true);
  assert.equal(checkApp(200, 'application/json').ok, false);
  assert.equal(checkApp(500, 'text/html').ok, false);
  assert.equal(checkApp(200, null).ok, false);
});

test('args: base url is required, trailing slash is dropped, flags are read', () => {
  assert.throws(() => parseSmokeArgs([]), /base url/i);
  assert.throws(() => parseSmokeArgs(['ftp://x']), /http/i);
  assert.deepEqual(parseSmokeArgs(['https://x.example/']), {
    baseUrl: 'https://x.example', expectVersion: null, allowUnavailable: false, attempts: 12, delayMs: 5000
  });
  assert.deepEqual(
    parseSmokeArgs(['https://x.example', '--expect-version', 'abc123def456', '--allow-unavailable', '--attempts', '3', '--delay-ms', '10']),
    { baseUrl: 'https://x.example', expectVersion: 'abc123def456', allowUnavailable: true, attempts: 3, delayMs: 10 }
  );
  assert.throws(() => parseSmokeArgs(['https://x.example', '--nope']), /unknown/i);
  assert.throws(() => parseSmokeArgs(['https://x.example', '--attempts', '0']), /attempts/i);
});

test('allPassed is true only when every result is ok and there is at least one', () => {
  assert.equal(allPassed([{ ok: true }, { ok: true }]), true);
  assert.equal(allPassed([{ ok: true }, { ok: false }]), false);
  assert.equal(allPassed([]), false);
});
```

- [ ] **Step 2: Run it and watch it fail.** `npm run test:scripts`. Expected: FAIL, cannot find `./smoke-checks.mjs`.

- [ ] **Step 3: Implement** `scripts/lib/smoke-checks.mjs`. Each check returns `{ name, ok, detail }` with names `healthz`, `public-event`, `app`. Rules, in order, for `checkHealthz(status, body, expectVersion)`: status must be 200; `body.ok === true`; `body.db === true`; when `expectVersion` is set, `body.version === expectVersion`, and the failure detail names both values; success detail is `` `env ${body.env}, version ${body.version}` ``. `checkPublicEvent(status, body, allowUnavailable)`: status 503 with `body.error === 'unavailable'` passes only when `allowUnavailable` is true (a Worker with no connected shop, which is what staging is; on production the same answer is an outage and must fail); otherwise status must be 200 and `typeof body.active === 'boolean'`. `checkApp(status, contentType)`: 200 and `/text\/html/i`. `parseSmokeArgs(argv)`: first positional is the base URL, must start with `http://` or `https://`, trailing slashes removed; flags as in the test; any other `--flag` throws `unknown option`; `--attempts` and `--delay-ms` must be integers, attempts at least 1, delay at least 0. `allPassed(results)`: non-empty and every `ok`.

- [ ] **Step 4: Run it and watch it pass.** `npm run test:scripts` exits 0.

- [ ] **Step 5: Write the wrapper** `scripts/smoke.mjs`: parse args (usage error prints the usage line to stderr and exits 2); loop up to `attempts`: fetch the three URLs with `fetch` and `AbortSignal.timeout(10000)`, `redirect: 'manual'`, read JSON defensively (a body that is not JSON becomes `null`, a network error becomes status 0 with the error message as detail), build the three results, print one line per check as `PASS name: detail` or `FAIL name: detail`; stop as soon as `allPassed`; otherwise wait `delayMs` and try again, printing `attempt i/n failed, retrying`. Exit 0 or 1. No dependencies beyond Node built-ins.

- [ ] **Step 6: Exercise the wrapper for real.** `node scripts/smoke.mjs https://pawscout.activepaw.co.uk --attempts 1` : `/healthz` does not exist on production yet, so this must print `FAIL healthz` and exit 1. That is the falsifiability check: report the output and the exit code. Then `node scripts/smoke.mjs` with no arguments exits 2. `npm run lint` exits 0.

- [ ] **Step 7: Report.** Do not commit.

---

### Task 3: Migration rehearsal (agent C)

**Files:**
- Create: `scripts/lib/rehearsal.mjs`, `scripts/lib/rehearsal.nodetest.mjs`, `scripts/rehearse-migrations.mjs`

**Interfaces:**
- Consumes: `ROOT`, `runWrangler`, `d1Rows` from `scripts/lib/run.mjs` (task 0).
- Produces: command `node scripts/rehearse-migrations.mjs [--force] [--allow-shrink t1,t2] [--keep]`. Exit 0 rehearsal passed or nothing pending, 1 rehearsal failed, 2 usage or environment error. Exports `pendingMigrations(localFiles, appliedNames)`, `compareRowCounts(before, after, allowShrink)`, `parseRehearsalArgs(argv)`, `countsQuery(tables)`. Task 4 imports `pendingMigrations`.

Why local and throwaway: production holds customer messages and shipping addresses. The copy never leaves this machine, lives under the gitignored `.wrangler/`, and is deleted in a `finally` unless `--keep` is passed for debugging.

- [ ] **Step 1: Write the failing test** `scripts/lib/rehearsal.nodetest.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingMigrations, compareRowCounts, parseRehearsalArgs, countsQuery } from './rehearsal.mjs';

test('pending = local .sql files not yet applied, in order', () => {
  const local = ['0002_b.sql', '0001_a.sql', 'README.md', '0003_c.sql'];
  assert.deepEqual(pendingMigrations(local, ['0001_a.sql']), ['0002_b.sql', '0003_c.sql']);
  assert.deepEqual(pendingMigrations(local, ['0001_a.sql', '0002_b.sql', '0003_c.sql']), []);
  assert.deepEqual(pendingMigrations([], []), []);
});

test('row counts: growth and equality pass', () => {
  const r = compareRowCounts({ orders: 1, tenants: 1 }, { orders: 1, tenants: 2, brand_new: 0 });
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('row counts: a shrinking table is a problem that names both numbers', () => {
  const r = compareRowCounts({ orders: 5 }, { orders: 3 });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /orders/);
  assert.match(r.problems[0], /5/);
  assert.match(r.problems[0], /3/);
});

test('row counts: a vanished table is a problem', () => {
  const r = compareRowCounts({ orders: 5 }, {});
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /orders/);
  assert.match(r.problems[0], /gone/);
});

test('row counts: an allowed table may shrink or vanish', () => {
  assert.equal(compareRowCounts({ search_cache: 9, old: 2 }, { search_cache: 1 }, ['search_cache', 'old']).ok, true);
});

test('args', () => {
  assert.deepEqual(parseRehearsalArgs([]), { force: false, allowShrink: [], keep: false });
  assert.deepEqual(parseRehearsalArgs(['--force', '--keep', '--allow-shrink', 'a, b']), { force: true, allowShrink: ['a', 'b'], keep: true });
  assert.throws(() => parseRehearsalArgs(['--nope']), /unknown/i);
  assert.throws(() => parseRehearsalArgs(['--allow-shrink']), /allow-shrink/i);
});

test('counts query quotes every table name and rejects a name that is not an identifier', () => {
  const q = countsQuery(['orders', 'tenants']);
  assert.match(q, /SELECT 'orders' AS t, COUNT\(\*\) AS n FROM "orders"/);
  assert.match(q, /UNION ALL/);
  assert.throws(() => countsQuery(['orders"; DROP TABLE x; --']), /table name/i);
  assert.throws(() => countsQuery([]), /no tables/i);
});
```

- [ ] **Step 2: Run it and watch it fail.** `npm run test:scripts`. Expected: FAIL, cannot find `./rehearsal.mjs`.

- [ ] **Step 3: Implement** `scripts/lib/rehearsal.mjs`. `pendingMigrations`: keep names ending `.sql`, sort ascending, drop those in `appliedNames`. `compareRowCounts(before, after, allowShrink = [])`: for every table in `before` not in `allowShrink`: absent from `after` gives `` `${table}: table is gone after the migrations (had ${n} rows)` ``; smaller gives `` `${table}: ${n} rows before, ${after[table]} after` ``; returns `{ ok, problems }`. `parseRehearsalArgs`: flags as tested; `--allow-shrink` takes one comma-separated value, trimmed, empties dropped, and throws when the value is missing. `countsQuery(tables)`: throws `no tables` on an empty list; every name must match `/^[A-Za-z_][A-Za-z0-9_]*$/` or it throws `bad table name`; builds `SELECT 'name' AS t, COUNT(*) AS n FROM "name"` joined by ` UNION ALL `.

- [ ] **Step 4: Run it and watch it pass.** `npm run test:scripts` exits 0.

- [ ] **Step 5: Write the wrapper** `scripts/rehearse-migrations.mjs`, in this order, printing one line per step:
  1. Parse args (bad usage: message to stderr, exit 2).
  2. Applied names: `d1Rows('pawscout', 'SELECT name FROM d1_migrations ORDER BY id')`. Local files: `fs.readdirSync(path.join(ROOT, 'migrations'))`. Compute pending and print them.
  3. Nothing pending and no `--force`: print `no pending migrations, nothing to rehearse` and exit 0.
  4. Make `work = path.join(ROOT, '.wrangler', 'rehearsal-' + Date.now())`. Everything below runs inside `try { ... } finally { if (!keep) fs.rmSync(work, { recursive: true, force: true }) }`, and the `finally` prints whether the copy was deleted or kept.
  5. Export: `runWrangler(['d1', 'export', 'pawscout', '--remote', '--output', path.join(work, 'prod.sql')])`. Non-zero status: print stderr, exit 2.
  6. Load: `runWrangler(['d1', 'execute', 'pawscout', '--local', '--persist-to', path.join(work, 'state'), '--file', path.join(work, 'prod.sql'), '--yes'])`. Non-zero: exit 2. If this wrangler version rejects `--yes`, drop the flag and pass `{ env: { ...process.env, CI: '1' } }` as the runner options so wrangler does not wait for a prompt; say in your report which one was needed.
  7. Tables: `d1Rows('pawscout', "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name", { remote: false, persistTo: state })`. Counts before: `d1Rows('pawscout', countsQuery(tables), { remote: false, persistTo: state })` folded into an object.
  8. Apply: `runWrangler(['d1', 'migrations', 'apply', 'pawscout', '--local', '--persist-to', state], { env: { ...process.env, CI: '1' } })`. Non-zero: print the output, exit 1. This is the rehearsal failing, which is the point of it.
  9. Tables and counts after (tables re-read, since a migration may add one). `PRAGMA quick_check` must return a single row whose value is `ok`; `PRAGMA foreign_key_check` must return no rows. Either failing: print the rows, exit 1.
  10. `compareRowCounts`; problems: print each, exit 1.
  11. Print `rehearsal passed: N migration(s) applied to a copy of production, T tables, integrity ok`, exit 0.

- [ ] **Step 6: Exercise what is safe to exercise.** `node scripts/rehearse-migrations.mjs --nope` exits 2. Do NOT run the wrapper against production yourself: the orchestrator runs it once, in task 8. Instead prove steps 6 to 10 locally without touching production: create a scratch directory under `.wrangler/`, write a tiny `prod.sql` by hand (two tables, a few rows, plus a `d1_migrations` table listing every file in `migrations/` except the last one as applied, matching the column layout wrangler itself creates: inspect a fresh `wrangler d1 migrations apply pawscout --local --persist-to <scratch>` database to learn it), and run the load, count, apply, check sequence against it by calling your functions. Report what you ran and what it printed. `npm run lint` exits 0. Delete the scratch directory.

- [ ] **Step 7: Report**, including any wrangler behaviour that differed from this plan. Do not commit.

---

### Task 4: Guarded deploy (agent D)

**Files:**
- Create: `scripts/lib/deploy-guards.mjs`, `scripts/lib/deploy-guards.nodetest.mjs`, `scripts/deploy.mjs`

**Interfaces:**
- Consumes: `ROOT`, `runWrangler`, `runGit`, `runGh`, `runNode`, `d1Rows` from `scripts/lib/run.mjs`; `pendingMigrations` from `scripts/lib/rehearsal.mjs` (task 3, same signature as its test); commands `node scripts/smoke.mjs <url> --expect-version <label> [--allow-unavailable]` (exit 0 pass) and `node scripts/rehearse-migrations.mjs [--allow-shrink a,b]` (exit 0 pass).
- Produces: command `node scripts/deploy.mjs --env staging|production [--dry-run] [--skip-ci "<reason>"] [--allow-shrink t1,t2]`. Exit 0 deployed and smoke passed (or dry run found nothing to refuse), 1 refused or failed, 2 bad usage. Exports `TARGETS`, `parseDeployArgs`, `versionLabel`, `ciVerdict`, `evaluateGuards`, `wranglerDeployArgs`, `migrationsApplyArgs`, `rollbackCommand`.

`TARGETS` (the staging URL is filled in by the orchestrator in task 7, after the first staging deploy prints it; write it exactly as below and leave it for the orchestrator):

```js
export const TARGETS = {
  production: { url: 'https://pawscout.activepaw.co.uk', database: 'pawscout', wranglerEnv: null },
  staging: { url: process.env.PAWSCOUT_STAGING_URL || '', database: 'pawscout-staging', wranglerEnv: 'staging' }
};
```

- [ ] **Step 1: Write the failing test** `scripts/lib/deploy-guards.nodetest.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDeployArgs, versionLabel, ciVerdict, evaluateGuards,
  wranglerDeployArgs, migrationsApplyArgs, rollbackCommand
} from './deploy-guards.mjs';

const SHA = 'abc123def4567890abc123def4567890abc123de';
const clean = {
  env: 'production', dirty: [], head: SHA, upstreamHead: SHA,
  ci: { state: 'success', detail: 'completed/success' }, skipCiReason: null,
  pending: [], rehearsalOk: null
};

test('args: --env is required and must be staging or production', () => {
  assert.throws(() => parseDeployArgs([]), /--env/);
  assert.throws(() => parseDeployArgs(['--env', 'prod']), /staging|production/);
  assert.deepEqual(parseDeployArgs(['--env', 'staging']), { env: 'staging', dryRun: false, skipCiReason: null, allowShrink: [] });
  assert.deepEqual(
    parseDeployArgs(['--env', 'production', '--dry-run', '--skip-ci', 'GitHub is down', '--allow-shrink', 'a,b']),
    { env: 'production', dryRun: true, skipCiReason: 'GitHub is down', allowShrink: ['a', 'b'] }
  );
  assert.throws(() => parseDeployArgs(['--env', 'production', '--skip-ci']), /reason/i);
  assert.throws(() => parseDeployArgs(['--env', 'production', '--skip-ci', '--dry-run']), /reason/i);
  assert.throws(() => parseDeployArgs(['--env', 'staging', '--nope']), /unknown/i);
});

test('version label is 12 characters, marked dirty only when asked', () => {
  assert.equal(versionLabel(SHA, false), 'abc123def456');
  assert.equal(versionLabel(SHA, true), 'abc123def456-dirty');
});

test('ci verdict reads the newest run for the commit', () => {
  assert.deepEqual(ciVerdict('[{"status":"completed","conclusion":"success"}]'), { state: 'success', detail: 'completed/success' });
  assert.equal(ciVerdict('[{"status":"completed","conclusion":"failure"}]').state, 'failure');
  assert.equal(ciVerdict('[{"status":"in_progress","conclusion":null}]').state, 'pending');
  assert.equal(ciVerdict('[]').state, 'missing');
  assert.equal(ciVerdict('not json').state, 'missing');
});

test('a clean, pushed, green commit with no pending migrations may deploy to production', () => {
  assert.deepEqual(evaluateGuards(clean), { ok: true, failures: [] });
});

test('production refuses a dirty tree, and names the files', () => {
  const r = evaluateGuards({ ...clean, dirty: [' M src/index.ts'] });
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /src\/index\.ts/);
});

test('production refuses a commit that is not what origin/master points to', () => {
  const r = evaluateGuards({ ...clean, upstreamHead: 'f'.repeat(40) });
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /push/i);
});

test('production refuses anything but green CI, unless a reason to skip was given', () => {
  for (const state of ['failure', 'pending', 'missing']) {
    assert.equal(evaluateGuards({ ...clean, ci: { state, detail: state } }).ok, false, state);
  }
  assert.equal(evaluateGuards({ ...clean, ci: { state: 'missing', detail: 'missing' }, skipCiReason: 'GitHub is down' }).ok, true);
});

test('production refuses pending migrations without a passing rehearsal', () => {
  assert.equal(evaluateGuards({ ...clean, pending: ['0041_x.sql'], rehearsalOk: null }).ok, false);
  assert.equal(evaluateGuards({ ...clean, pending: ['0041_x.sql'], rehearsalOk: false }).ok, false);
  assert.equal(evaluateGuards({ ...clean, pending: ['0041_x.sql'], rehearsalOk: true }).ok, true);
});

test('every failing guard is reported, not only the first', () => {
  const r = evaluateGuards({ ...clean, dirty: [' M a'], upstreamHead: 'f'.repeat(40), ci: { state: 'failure', detail: 'x' } });
  assert.equal(r.failures.length, 3);
});

test('staging is never refused', () => {
  const r = evaluateGuards({ ...clean, env: 'staging', dirty: [' M a'], upstreamHead: 'f'.repeat(40), ci: { state: 'missing', detail: 'x' }, pending: ['0041_x.sql'] });
  assert.deepEqual(r, { ok: true, failures: [] });
});

test('wrangler arguments name the environment every time', () => {
  assert.deepEqual(wranglerDeployArgs('production', 'abc123def456'), ['deploy', '--var', 'GIT_SHA:abc123def456']);
  assert.deepEqual(wranglerDeployArgs('staging', 'abc123def456'), ['deploy', '--env', 'staging', '--var', 'GIT_SHA:abc123def456']);
  assert.deepEqual(migrationsApplyArgs('production'), ['d1', 'migrations', 'apply', 'pawscout', '--remote']);
  assert.deepEqual(migrationsApplyArgs('staging'), ['d1', 'migrations', 'apply', 'pawscout-staging', '--remote', '--env', 'staging']);
  assert.equal(rollbackCommand('production'), 'npx wrangler rollback -y');
  assert.equal(rollbackCommand('staging'), 'npx wrangler rollback -y --env staging');
});
```

- [ ] **Step 2: Run it and watch it fail.** `npm run test:scripts`. Expected: FAIL, cannot find `./deploy-guards.mjs`.

- [ ] **Step 3: Implement** `scripts/lib/deploy-guards.mjs` to satisfy the test. Rules: `dirty` is the list of `git status --porcelain` lines with untracked (`??`) lines already removed by the wrapper (this repo carries long-standing untracked strays that must not block a deploy); failure messages are full sentences that say what to do next; `--skip-ci` needs a following value that does not start with `--`; `ciVerdict` maps `completed/success` to `success`, any other completed conclusion to `failure`, a non-completed status to `pending`, an empty list or unparseable text to `missing`.

- [ ] **Step 4: Run it and watch it pass.** `npm run test:scripts` exits 0.

- [ ] **Step 5: Write the wrapper** `scripts/deploy.mjs`, printing one line per step:
  1. Parse args (bad usage: exit 2). Staging with an empty `TARGETS.staging.url`: print how to set `PAWSCOUT_STAGING_URL`, exit 2.
  2. Gather: `runGit(['fetch', 'origin', 'master'])`; `runGit(['status', '--porcelain'])` split into lines, drop empty lines and lines starting `??`; `runGit(['rev-parse', 'HEAD'])`; `runGit(['rev-parse', 'origin/master'])`; for production without a skip reason, `runGh(['run', 'list', '--commit', head, '--workflow', 'ci.yml', '--json', 'status,conclusion', '--limit', '1'])` into `ciVerdict`; applied migrations through `d1Rows(target.database, 'SELECT name FROM d1_migrations ORDER BY id', { envName: target.wranglerEnv })`, treating a thrown `no such table` as an empty list (a fresh staging database); `pendingMigrations(fs.readdirSync(path.join(ROOT, 'migrations')), applied)`.
  3. Production with pending migrations and not a dry run: `runNode('scripts/rehearse-migrations.mjs', allowShrink.length ? ['--allow-shrink', allowShrink.join(',')] : [], { stdio: 'inherit' })` and set `rehearsalOk` from its status. On a dry run `rehearsalOk` stays `null` and the plan is printed instead.
  4. `evaluateGuards`. Failures: print `REFUSED:` and each failure on its own line, exit 1. A used skip reason is printed loudly: `CI check SKIPPED: <reason>`.
  5. Dry run: print the version label, the pending migrations, and the exact wrangler argument arrays that would run, then exit 0. A dry run never exports, applies, deploys or smokes.
  6. Pending migrations: `runWrangler(migrationsApplyArgs(env), { stdio: 'inherit', env: { ...process.env, CI: '1' } })`; non-zero: exit 1 and say the Worker was NOT deployed.
  7. Deploy: `runWrangler(wranglerDeployArgs(env, label), { stdio: 'inherit' })`; non-zero: exit 1.
  8. Smoke: `runNode('scripts/smoke.mjs', [target.url, '--expect-version', label, ...(env === 'staging' ? ['--allow-unavailable'] : [])], { stdio: 'inherit' })`. Non-zero: print `SMOKE FAILED. Roll back with: <rollbackCommand(env)>` and the reminder that migrations are forward-only and stay applied, exit 1.
  9. Print `deployed <label> to <env>: <url>`, exit 0.

- [ ] **Step 6: Exercise the refusals for real.** `node scripts/deploy.mjs` exits 2. `node scripts/deploy.mjs --env production --dry-run` on the current tree: tasks 1 to 5 are uncommitted, so it must print `REFUSED:` naming the dirty files and exit 1. Report the output. Never run it without `--dry-run`. `npm run lint` exits 0.

- [ ] **Step 7: Report.** Do not commit.

---

### Task 5: Runbook and decision record (agent E)

**Files:**
- Create: `docs/RUNBOOK-DEPLOY.md`, `docs/decisions/0001-deploy-safety.md`

**Interfaces:**
- Consumes: the commands, flags and exit codes defined in tasks 1 to 4 and the decisions in PRD section 5. Document only what those sections define; invent nothing.

- [ ] **Step 1: Write `docs/RUNBOOK-DEPLOY.md`** with these sections, each short and imperative, every command in a code block: **Before you deploy** (the owner's explicit go is required for production and is not something the script checks; CI must be green); **Deploy to staging** (`npm run deploy -- --env staging`, what the smoke prints, that staging has no connected shop so `/public/event` answers 503 by design); **Deploy to production** (`npm run deploy -- --env production`, the four guards and what each refusal means and how to clear it; `--dry-run`; `--skip-ci "<reason>"` and when it is legitimate); **Check what is live** (`curl https://pawscout.activepaw.co.uk/healthz`, reading `version`, what `unknown` means); **Roll back** (`npx wrangler rollback -y`, and `--env staging`; a rollback reverts the Worker, never the database); **Migration policy** (forward-only; expand, deploy, migrate data, contract in a later release; why that makes a Worker rollback safe; never drop a column in the release that stops using it); **Rehearse migrations** (`npm run migrate:rehearse`, `--force`, `--allow-shrink`, `--keep`; the copy holds customer data, stays on this machine under `.wrangler/`, is deleted automatically; exporting can briefly block production queries, so rehearse only when migrations are pending); **When the smoke test is red** (read which check failed; healthz version mismatch usually means the old version is still being served, wait and re-run `npm run smoke`; database false means roll back now); **Escape hatch** (`npm run deploy:raw` exists, skips every guard, leaves `/healthz` reporting `unknown`, and needs a written reason in the commit or the backlog).

- [ ] **Step 2: Write `docs/decisions/0001-deploy-safety.md`** as a decision record: Status (accepted 2026-09-18), Context (the measured gaps from PRD section 3, row "Nothing stands between a commit and production"), Decision (the eight components C1 to C8, one line each), Alternatives considered and why not (rehearsing on the staging database: it would copy customer data off this machine; path filters in CI: the deploy guard needs a verdict for every commit; automatic rollback on a red smoke: deferred until the smoke test has a track record, because a false alarm would roll back a good deploy; a Shopify-connected staging: needs an owner decision, belongs to phase 2), Consequences (deploys take longer; a second gate can disagree with the first and that is the point; `deploy:raw` remains and is visible as `unknown`).

- [ ] **Step 3: Check** both files for em and en dashes with a Python one-liner that prints the count, which must be 0, and for any command or flag that tasks 1 to 4 do not define. Report. Do not commit.

---

### Task 6: CI workflow and the red-run proof (orchestrator)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1:** Write the workflow. Actions are pinned to full commit hashes (resolved 2026-09-18 with `gh api`), because a moving tag is a supply-chain hole:

```yaml
name: ci

on:
  push:
  workflow_dispatch:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test:scripts
      - run: npm run test:ci
```

- [ ] **Step 2:** Commit and push with the rest of the phase; watch the run with `gh run watch`; master must go GREEN. If the suite fails on Linux for environment reasons, fix the environment, never the assertion.
- [ ] **Step 3: Red-run proof.** On a throwaway branch add one deliberately failing assertion, push, confirm the run is RED, delete the branch locally and on the remote. A gate that has never been seen red has not been shown to work.

---

### Task 7: Staging environment (orchestrator)

**Files:**
- Modify: `wrangler.toml`

Hard rule, confirmed in the Cloudflare docs 2026-09-18: most keys are INHERITED by a named environment, including `routes` and `triggers`; bindings and `vars` are not. An `[env.staging]` that does not override `routes` would claim `pawscout.activepaw.co.uk`, and one that does not override `triggers` would run the production crons against staging.

- [ ] **Step 1:** `wrangler d1 create pawscout-staging`; record the id.
- [ ] **Step 2:** Add to `wrangler.toml`:

```toml
# --- staging (deploy-safety phase, 2026-09-18) --------------------------------
# A place where a deploy can fail harmlessly. NOT connected to any Shopify store.
# `routes` and `triggers` are INHERITABLE keys: both are overridden here on
# purpose. Without `routes = []` this environment would claim the production
# custom domain; without the empty crons it would run the production jobs.
[env.staging]
name = "pawscout-worker-staging"
workers_dev = true
routes = []

[env.staging.triggers]
crons = []

[[env.staging.d1_databases]]
binding = "DB"
database_name = "pawscout-staging"
database_id = "<id from step 1>"
migrations_dir = "migrations"

[env.staging.vars]
ENVIRONMENT = "staging"
SHOPIFY_API_KEY = "staging-not-connected"
SHOPIFY_APP_URL = "<staging workers.dev URL, from the first deploy>"
SHOPIFY_SCOPES = "read_products"
```

- [ ] **Step 3:** Give staging its OWN random secrets so nothing forged against it works on production and no production key is ever copied: `SHOPIFY_API_SECRET` and `PAWSCOUT_MASTER_KEY` (32 random bytes, base64), piped into `wrangler secret put <NAME> --env staging`, never printed.
- [ ] **Step 4:** First deploy with the guarded script once task 4 is in; record the workers.dev URL in `TARGETS.staging.url` and in `SHOPIFY_APP_URL`.
- [ ] **Step 5: Prove production was not touched.** `curl https://pawscout.activepaw.co.uk/public/event` still returns the production payload (a `next` event, which a shopless staging Worker cannot produce), and `wrangler deployments list` for production shows no new entry.

---

### Task 8: Acceptance (orchestrator)

- [ ] PRD 5.6 criterion 1: red run seen on a throwaway branch, master green (task 6).
- [ ] Criterion 2: staging `/healthz` answers `env: "staging"`, `db: true`, the deployed label; the staging deploy output lists no schedules.
- [ ] Criterion 3: `npm run migrate:rehearse -- --force` passes against a real production export; afterwards no `rehearsal-*` directory exists under `.wrangler/`.
- [ ] Criterion 4: `npm run deploy -- --env production --dry-run` refuses a dirty tree, and refuses a commit without green CI, each with its reason.
- [ ] Criterion 5 waits for the owner's go: production deployed through the script, `/healthz` on production reports the label.

---

### Task 9: Compatibility date (orchestrator, last)

- [ ] Read the Workers compatibility-flags changelog between 2024-11-01 and today for anything touching `fetch`, streams, `nodejs_compat`, `URL`, or scheduled handlers.
- [ ] Raise `compatibility_date`, run the full suite, deploy to staging, smoke. Production only on the owner's go, as its own deploy, so a behaviour change is never confused with a code change.
