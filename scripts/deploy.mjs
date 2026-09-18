// scripts/deploy.mjs
//
// The guarded deploy for the PawScout Worker. `npm run deploy` runs this
// instead of a bare `wrangler deploy` (kept available as `npm run deploy:raw`
// for emergencies). For production it refuses to run unless the tree is
// clean, the commit is pushed to origin/master, CI is green (or an operator
// gave an explicit reason to skip it), and any pending migrations have
// passed a rehearsal; then it applies migrations, deploys with the commit
// label injected, and runs the smoke test. Staging never refuses: it exists
// to rehearse this exact pipeline (deploy-safety phase 1, 2026-09-18).
//
// Every decision is a pure function in scripts/lib/deploy-guards.mjs; this
// file only gathers state (git, gh, wrangler, the migration rehearsal) and
// prints what those functions decide. It is a thin wrapper on purpose so the
// decisions stay testable without spawning a process.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runWrangler, runGit, runGh, runNode, d1Rows } from './lib/run.mjs';
import {
  TARGETS, parseDeployArgs, versionLabel, ciVerdict, evaluateGuards,
  wranglerDeployArgs, migrationsApplyArgs, rollbackCommand, pendingForGuards,
  gitStateProblems, missingOnStaging
} from './lib/deploy-guards.mjs';
import { pendingMigrations } from './lib/rehearsal.mjs';

let args;
try {
  args = parseDeployArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const { env, dryRun, skipCiReason, allowShrink } = args;
const target = TARGETS[env];

// TARGETS.staging.url now defaults to the real staging Worker URL, so this
// only fires if PAWSCOUT_STAGING_URL is explicitly set to an empty string.
if (env === 'staging' && !target.url) {
  console.error('Staging has no URL configured. Set PAWSCOUT_STAGING_URL to the staging Worker URL and run again.');
  process.exit(2);
}

console.log(`deploy: gathering state for ${env}${dryRun ? ' (dry run)' : ''}`);

const fetchResult = runGit(['fetch', 'origin', 'master']);
const statusResult = runGit(['status', '--porcelain']);
const headResult = runGit(['rev-parse', 'HEAD']);
const upstreamResult = runGit(['rev-parse', 'origin/master']);

// Staging has no push guard, so a failed fetch there is only ever a warning:
// gitStateProblems below will not refuse on it. For production it is a hard
// refusal (a stale origin/master is exactly what the push guard exists to
// catch), so the reason is already in the REFUSED output and does not need
// repeating here.
if (fetchResult.status !== 0 && env !== 'production') {
  console.error('deploy: WARNING - git fetch origin master failed; the push check has no effect on staging, but note this in case origin is unreachable for another reason.');
  console.error(fetchResult.stderr || fetchResult.stdout);
}

// A state that could not be READ cannot be EVALUATED: refuse before any
// guard runs rather than letting evaluateGuards compare strings that came
// from a failed or garbled git call (see gitStateProblems in deploy-guards.mjs).
const gitProblems = gitStateProblems({ env, fetch: fetchResult, status: statusResult, head: headResult, upstream: upstreamResult });
if (gitProblems.length > 0) {
  console.error('REFUSED:');
  for (const problem of gitProblems) console.error(`  ${problem}`);
  process.exit(1);
}

const dirty = statusResult.stdout
  .split('\n')
  .map((line) => line.replace(/\r$/, ''))
  .filter((line) => line.length > 0 && !line.startsWith('??'));

const head = headResult.stdout.trim();
const upstreamHead = upstreamResult.stdout.trim();

// CI is only ever checked for a production deploy that is not already being
// waved through with --skip-ci: staging never gates on it, and a supplied
// skip reason means the answer would be discarded anyway.
let ci = { state: 'not-checked', detail: 'staging does not gate on CI' };
if (env === 'production') {
  if (skipCiReason) {
    ci = { state: 'missing', detail: 'not checked: --skip-ci was given' };
  } else {
    const ghResult = runGh(['run', 'list', '--commit', head, '--workflow', 'ci.yml', '--json', 'status,conclusion', '--limit', '1']);
    ci = ciVerdict(ghResult.stdout);
  }
}

console.log(`deploy: HEAD ${head}, origin/master ${upstreamHead}, dirty files ${dirty.length}, CI ${ci.state} (${ci.detail})`);

// A fresh database (staging, most often) has no d1_migrations table yet;
// that is not a query failure, it is zero applied migrations.
let appliedNames = [];
try {
  const rows = d1Rows(target.database, 'SELECT name FROM d1_migrations ORDER BY id', { envName: target.wranglerEnv });
  appliedNames = rows.map((row) => row.name);
} catch (err) {
  if (/no such table/i.test(err.message)) {
    appliedNames = [];
  } else {
    throw err;
  }
}

const migrationFiles = fs.readdirSync(path.join(ROOT, 'migrations'));
const pending = pendingMigrations(migrationFiles, appliedNames);

console.log(`deploy: ${pending.length} pending migration(s)${pending.length ? ': ' + pending.join(', ') : ''}`);

// The migration rehearsal no longer touches D1 at all (it was rebuilt on
// Node's in-memory SQLite after wrangler 3.114 could not ingest a
// production-sized export); the only remaining proof that real D1 accepts
// the SQL is that staging already took the same migration. This is a cheap
// read, so unlike the rehearsal it is never deferred, not even on a dry
// run, and it is read only for production with something pending: staging
// itself has nothing to prove against, and an empty `pending` has nothing
// to look up.
let stagingMissing = [];
if (env === 'production' && pending.length > 0) {
  let stagingApplied = [];
  try {
    const rows = d1Rows(TARGETS.staging.database, 'SELECT name FROM d1_migrations ORDER BY id', { envName: TARGETS.staging.wranglerEnv });
    stagingApplied = rows.map((row) => row.name);
  } catch (err) {
    if (/no such table/i.test(err.message)) {
      stagingApplied = [];
    } else {
      console.error('REFUSED:');
      console.error(`  Staging could not be read (${err.message}), so it cannot be proven these pending migrations reached staging first. Fail closed: fix staging access and try again.`);
      process.exit(1);
    }
  }
  stagingMissing = missingOnStaging(pending, stagingApplied);
  console.log(`deploy: ${stagingMissing.length} of ${pending.length} pending migration(s) missing on staging${stagingMissing.length ? ': ' + stagingMissing.join(', ') : ''}`);
}

const label = versionLabel(head, dirty.length > 0);
const smokeArgs = [target.url, '--expect-version', label, ...(env === 'staging' ? ['--allow-unavailable'] : [])];

// Printed only once the whole guard gate has actually passed for this run's
// path (dry run: after phase one; real run: after phase two below), so a
// run refused for some other reason never claims to have used the skip.
// Staging has no CI check to skip in the first place, so this never prints
// there even if --skip-ci was (needlessly) given.
function announceSkipIfUsed() {
  if (skipCiReason && env === 'production') {
    console.log(`CI check SKIPPED: ${skipCiReason}`);
  }
}

// Phase one: every guard that needs no rehearsal. The rehearsal briefly
// exports and blocks the production database (measured ~7s for this one),
// so nothing about production should be touched until every cheap guard -
// clean tree, pushed HEAD, green CI, migrations already proven on staging -
// has already passed. The pending-migrations (rehearsal) guard is deferred
// here exactly the way a dry run defers it; missingOnStaging is NOT
// deferred, since it is itself a cheap read (found in review, 2026-09-18).
const phaseOne = evaluateGuards({
  env, dirty, head, upstreamHead, ci, skipCiReason,
  pending: pendingForGuards(pending, true),
  rehearsalOk: null,
  missingOnStaging: stagingMissing
});

if (!phaseOne.ok) {
  console.error('REFUSED:');
  for (const failure of phaseOne.failures) console.error(`  ${failure}`);
  process.exit(1);
}

if (dryRun) {
  announceSkipIfUsed();
  console.log(`deploy: dry run for ${env}, nothing refused`);
  console.log(`  version label: ${label}`);
  console.log(`  pending migrations: ${pending.length ? pending.join(', ') : 'none'}`);
  if (pending.length > 0) {
    console.log('  a migration rehearsal would run here; the real deploy is refused if it fails.');
    console.log(`  would run: wrangler ${migrationsApplyArgs(env).join(' ')}`);
  }
  console.log(`  would run: wrangler ${wranglerDeployArgs(env, label).join(' ')}`);
  console.log(`  would run: node scripts/smoke.mjs ${smokeArgs.join(' ')}`);
  process.exit(0);
}

// Phase two: only reached for a real deploy where every cheap guard already
// passed. Only now does a production deploy with pending migrations run the
// rehearsal - the one step that touches the production database before the
// real migration apply.
let rehearsalOk = null;
let rehearsalExitCode = null;
if (env === 'production' && pending.length > 0) {
  console.log('deploy: rehearsing pending migrations before touching production');
  const rehearsalArgs = allowShrink.length ? ['--allow-shrink', allowShrink.join(',')] : [];
  const rehearsalResult = runNode('scripts/rehearse-migrations.mjs', rehearsalArgs, { stdio: 'inherit' });
  rehearsalExitCode = rehearsalResult.status;
  rehearsalOk = rehearsalResult.status === 0;
}

const phaseTwo = evaluateGuards({
  env, dirty, head, upstreamHead, ci, skipCiReason,
  pending,
  rehearsalOk,
  missingOnStaging: stagingMissing
});

if (!phaseTwo.ok) {
  console.error('REFUSED:');
  for (const failure of phaseTwo.failures) console.error(`  ${failure}`);
  if (env === 'production' && pending.length > 0 && rehearsalOk !== true) {
    if (rehearsalExitCode === 1) {
      console.error('The rehearsal exited 1: this migration is NOT safe for production data. Do not deploy; read the rehearsal output above.');
    } else {
      console.error(`The rehearsal exited ${rehearsalExitCode}, meaning it could not run at all; nothing was proven either way. Fix the environment and run the deploy again.`);
    }
  }
  process.exit(1);
}

announceSkipIfUsed();

if (pending.length > 0) {
  console.log(`deploy: applying ${pending.length} migration(s) to ${target.database}`);
  const migrateResult = runWrangler(migrationsApplyArgs(env), { stdio: 'inherit', env: { ...process.env, CI: '1' } });
  if (migrateResult.status !== 0) {
    console.error('deploy: migration apply FAILED. The Worker was NOT deployed.');
    process.exit(1);
  }
}

console.log(`deploy: deploying ${label} to ${env}`);
const deployResult = runWrangler(wranglerDeployArgs(env, label), { stdio: 'inherit' });
if (deployResult.status !== 0) {
  console.error('deploy: wrangler deploy FAILED.');
  if (pending.length > 0) {
    console.error(`Migrations WERE applied (${pending.join(', ')}); the database in ${target.database} is now ahead of the deployed code.`);
    console.error('The previous Worker version is still serving traffic.');
    console.error('Migrations are forward-only: do not try to undo them. Fix the deploy problem and run this script again.');
  }
  process.exit(1);
}

console.log(`deploy: smoke testing ${target.url}`);
const smokeResult = runNode('scripts/smoke.mjs', smokeArgs, { stdio: 'inherit' });
if (smokeResult.status !== 0) {
  console.error(`SMOKE FAILED. Roll back with: ${rollbackCommand(env)}`);
  console.error('Migrations are forward-only and stay applied even after a rollback; a rollback undoes the code, not the schema.');
  process.exit(1);
}

console.log(`deployed ${label} to ${env}: ${target.url}`);
process.exit(0);
