#!/usr/bin/env node
// scripts/smoke.mjs
//
// Post-deploy smoke test (deploy-safety phase, 2026-09-18). The guarded
// deploy script runs this after every deploy to decide whether it went live.
// Measured on this stack, a request right after a deploy can still be served
// by the previous version for about 15 seconds, so this polls up to
// --attempts times rather than failing on the very first request.
//
// Only Node built-ins: fetch, AbortSignal.timeout and node:timers/promises.
// No shell, no child process, nothing to spawn, so scripts/lib/run.mjs does
// not apply here.
import { setTimeout as delay } from 'node:timers/promises';
import { checkHealthz, checkPublicEvent, checkApp, parseSmokeArgs, allPassed } from './lib/smoke-checks.mjs';

const USAGE =
  'usage: node scripts/smoke.mjs <base-url> [--expect-version <label>] [--allow-unavailable] [--attempts <n>] [--delay-ms <n>]';

// Normalizes one request to { status, body, contentType }. A body that does
// not parse as JSON becomes null (the /app check reads content-type, not
// JSON, so this is expected there). A network error or a timeout never
// throws past this point: it becomes status 0 with the error message carried
// as the body, so it still reaches the check functions and shows up in the
// printed detail instead of crashing the smoke test itself.
async function fetchOne(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'manual' });
    const contentType = res.headers.get('content-type');
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body, contentType };
  } catch (err) {
    return { status: 0, body: err instanceof Error ? err.message : String(err), contentType: null };
  }
}

async function runOnce(opts) {
  const [healthz, publicEvent, appPage] = await Promise.all([
    fetchOne(`${opts.baseUrl}/healthz`),
    fetchOne(`${opts.baseUrl}/public/event`),
    fetchOne(`${opts.baseUrl}/app`)
  ]);
  return [
    checkHealthz(healthz.status, healthz.body, opts.expectVersion),
    checkPublicEvent(publicEvent.status, publicEvent.body, opts.allowUnavailable),
    checkApp(appPage.status, appPage.contentType)
  ];
}

async function main(argv) {
  let opts;
  try {
    opts = parseSmokeArgs(argv);
  } catch (err) {
    process.stderr.write(`${USAGE}\n${err.message}\n`);
    return 2;
  }

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    const results = await runOnce(opts);
    for (const r of results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`);
    }
    if (allPassed(results)) {
      return 0;
    }
    if (attempt < opts.attempts) {
      console.log(`attempt ${attempt}/${opts.attempts} failed, retrying`);
      await delay(opts.delayMs);
    }
  }
  return 1;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
