// scripts/test-ci.mjs
//
// Run the whole vitest suite in BATCHES, and fail if any batch fails.
//
// WHY THIS EXISTS. `vitest run` over all 150 test files never starts on this
// machine: workerd's fallback service cannot fetch even vitest's own runner
// chunk over loopback, and the run dies with ~150-180
// "ConnectEx(): #1225 The remote computer refused the network connection"
// errors and `Test Files no tests`. There are ZERO assertion failures in that
// output; it is an environment/startup failure, not a broken test. Serialising
// with --no-file-parallelism does not help, and --maxWorkers does not apply
// (this repo uses @cloudflare/vitest-pool-workers, which spawns its own
// isolated runtime per file and ignores that flag). Small batches DO work
// reliably, which is what this script exploits.
//
// The point is to keep the pre-push test gate HONEST. Before this, aramid ran
// `npm test`, that failed for the reason above, and the only ways forward were
// to override the finding or rebaseline, both of which leave the gate blind.
// A blind gate is exactly what let a bad blog source allowlist survive months
// of "already fixed" reports. This runs every file and reports real results.
//
// Batch size is tunable: VITEST_BATCH=4 npm run test:ci

import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const BATCH = Math.max(1, Number(process.env.VITEST_BATCH || 8));
const ROOT = 'tests';

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.test.ts')) out.push(full.split('\\').join('/'));
  }
  return out;
}

const files = walk(ROOT).sort();
if (files.length === 0) {
  console.error('test:ci: no test files found under tests/ - refusing to report success');
  process.exit(1);
}

const batches = [];
for (let i = 0; i < files.length; i += BATCH) batches.push(files.slice(i, i + BATCH));

console.log(`test:ci: ${files.length} test files in ${batches.length} batch(es) of up to ${BATCH}`);

const runBatch = (batch) =>
  spawnSync('npx', ['vitest', 'run', ...batch, '--reporter=basic'], { stdio: 'inherit', shell: true });

const failed = [];
const flaky = [];
let batchNo = 0;
for (const batch of batches) {
  batchNo++;
  console.log(`\n--- batch ${batchNo}/${batches.length} ---`);
  let r = runBatch(batch);
  if (r.status !== 0) {
    // ONE retry, loudly. At least one test in this suite makes a real network
    // call that is not mocked, and it intermittently dies with
    // "Unhandled Rejection: TypeError: fetch failed / ECONNRESET" while every
    // assertion still passes (observed 2026-07-27 on the llm/logistics batch,
    // which then passed standalone). A transient reset does not survive a
    // retry; a real failure does. The retry is reported either way so a
    // genuinely flaky suite cannot hide behind a green gate.
    console.error(`\ntest:ci: batch ${batchNo} failed (exit ${r.status}), RETRYING ONCE`);
    r = runBatch(batch);
    if (r.status === 0) flaky.push(batchNo);
  }
  if (r.status !== 0) failed.push({ batch: batchNo, status: r.status, files: batch });
}

if (flaky.length) {
  console.error(`\ntest:ci: WARNING - batch(es) ${flaky.join(', ')} passed only on retry (flaky; likely an unmocked network call)`);
}

if (failed.length) {
  console.error(`\ntest:ci: ${failed.length} of ${batches.length} batch(es) FAILED`);
  for (const f of failed) console.error(`  batch ${f.batch} (exit ${f.status}): ${f.files.join(' ')}`);
  process.exit(1);
}

console.log(`\ntest:ci: all ${files.length} test files passed across ${batches.length} batch(es)`);
process.exit(0);
