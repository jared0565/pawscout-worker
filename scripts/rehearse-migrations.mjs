#!/usr/bin/env node
// scripts/rehearse-migrations.mjs
//
// WHY THIS EXISTS. Production D1 holds customer messages and shipping
// addresses. Before a deploy that carries pending migrations, this proves
// they apply cleanly to a full, throwaway LOCAL copy of production data
// rather than trusting "it worked on a mostly-empty local database" or, far
// worse, finding out on production itself. The copy is exported once, loaded
// into a scratch directory under the gitignored .wrangler/, migrated, and
// checked, then deleted regardless of outcome. It never writes to production
// and never leaves the scratch copy behind (deploy-safety phase 1, task 3,
// 2026-09-18; fix round 1, same day, after review found the cleanup
// guarantee had gaps - see the comments below marked "fix round 1").
//
// Usage: node scripts/rehearse-migrations.mjs [--force] [--allow-shrink t1,t2] [--keep]
//   --force         rehearse even if nothing is pending (mostly for exercising this script)
//   --allow-shrink  comma-separated table names allowed to shrink or vanish (e.g. a cache table)
//   --keep          do not delete the scratch copy afterwards (debugging only)
//
// Exit 0: rehearsal passed, or nothing was pending. Exit 1: rehearsal failed
// (this is the point of the script: catch it here, not on the real database).
// Exit 2: bad usage or an environment problem (export/load failed, production
// unreadable, or a scratch copy of production could not be deleted) that
// never got as far as testing a migration, or that leaves production data on
// disk even though the migration itself was fine.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runWrangler, d1Rows } from './lib/run.mjs';
import {
  pendingMigrations, compareRowCounts, parseRehearsalArgs, countsQuery,
  leftoverRehearsalDirs, copyLooksLikeProduction, finalExitCode
} from './lib/rehearsal.mjs';

const DATABASE = 'pawscout';

const TABLE_LIST_SQL =
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' " +
  "AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name";

function countsByTable(state) {
  const tables = d1Rows(DATABASE, TABLE_LIST_SQL, { remote: false, persistTo: state }).map((r) => r.name);
  if (tables.length === 0) return { tables, counts: {} };
  const rows = d1Rows(DATABASE, countsQuery(tables), { remote: false, persistTo: state });
  return { tables, counts: Object.fromEntries(rows.map((r) => [r.t, r.n])) };
}

function appliedNamesOnCopy(state) {
  return d1Rows(DATABASE, 'SELECT name FROM d1_migrations ORDER BY id', { remote: false, persistTo: state }).map(
    (r) => r.name
  );
}

// Fix round 1, CRITICAL: fs.rmSync's `force` option only swallows ENOENT. On
// Windows, a handle Miniflare or wrangler still holds open on the just-
// written SQLite file under <dir>/state raises EBUSY/EPERM, and maxRetries
// defaults to 0 - a single attempt right after the file was last touched can
// lose that race. Retrying a few times with a short delay gives the handle a
// chance to close; if it still cannot be removed, this says so loudly and
// names the exact directory rather than letting the failure disappear into a
// generic "unexpected error".
function removeScratchDir(dir, whatItHolds) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(`rehearse-migrations: scratch copy deleted (${dir})`);
    return true;
  } catch (err) {
    console.error(
      `rehearse-migrations: WARNING: could not delete ${dir} (${err.message}). ` +
        `This directory ${whatItHolds} and must be deleted by hand.`
    );
    return false;
  }
}

// Fix round 1, CRITICAL: covers the case a `finally` never can - the process
// dying outright (Ctrl-C during the long `d1 export --remote`, a hard crash)
// skips every JS-level cleanup, finally included, because the main thread is
// blocked inside a synchronous spawnSync call when it happens. Sweeping
// leftovers from earlier runs at the very start of every new run means that
// death mode is cleaned up on the NEXT run, at the latest, instead of never.
function sweepLeftoverScratchDirs() {
  const wranglerDir = path.join(ROOT, '.wrangler');
  let entries;
  try {
    entries = fs.readdirSync(wranglerDir);
  } catch (err) {
    if (err.code === 'ENOENT') return true; // nothing has ever run here yet
    console.error(`rehearse-migrations: WARNING: could not list ${wranglerDir} to sweep leftovers: ${err.message}`);
    return false;
  }

  const leftovers = leftoverRehearsalDirs(entries);
  if (leftovers.length === 0) {
    console.log('rehearse-migrations: startup sweep: no leftover scratch copies found');
    return true;
  }

  let removed = 0;
  let allOk = true;
  for (const name of leftovers) {
    const full = path.join(wranglerDir, name);
    const ok = removeScratchDir(full, 'may hold a copy of production data from an earlier interrupted run');
    if (ok) removed++;
    else allOk = false;
  }
  console.log(
    `rehearse-migrations: startup sweep: removed ${removed} of ${leftovers.length} leftover scratch ` +
      `director${leftovers.length === 1 ? 'y' : 'ies'}`
  );
  return allOk;
}

// Everything from the export through the final verdict. Returns a plain exit
// code (0/1/2), never calls process.exit itself, and never does its own
// cleanup - the caller (runRehearsal) does that unconditionally, once,
// whether this returns normally or its own try/catch below has already
// turned a thrown error into a code.
function computeRehearsalCode(args, pending, localFiles, state, prodSql) {
  console.log(`rehearse-migrations: exporting production data to ${prodSql} ...`);
  const exportResult = runWrangler(['d1', 'export', DATABASE, '--remote', '--output', prodSql]);
  if (exportResult.status !== 0) {
    console.error(exportResult.stderr || exportResult.stdout);
    return 2;
  }

  console.log('rehearse-migrations: loading the export into a throwaway local copy ...');
  // --yes is a real d1 execute flag on this wrangler (3.114.17, verified with
  // --help); measured 2026-09-18 that --local execute never actually prompts
  // either way, so --yes is harmless insurance rather than load-bearing here.
  const loadResult = runWrangler([
    'd1', 'execute', DATABASE, '--local', '--persist-to', state, '--file', prodSql, '--yes'
  ]);
  if (loadResult.status !== 0) {
    console.error(loadResult.stderr || loadResult.stdout);
    return 2;
  }

  console.log("rehearse-migrations: reading the copy's own applied-migrations record ...");
  const appliedBeforeLocal = appliedNamesOnCopy(state);

  console.log('rehearse-migrations: counting rows before migration ...');
  const { counts: before } = countsByTable(state);

  // Fix round 1, IMPORTANT 1: a schema-only or otherwise empty copy would
  // otherwise sail through compareRowCounts (0 rows before, 0 after, nothing
  // "shrank") and print "rehearsal passed" without a single row of production
  // data ever having been touched. Caught here, before the copy is trusted
  // for anything else, as an environment problem: the export or load did not
  // do what it claimed, not a bad migration.
  const shape = copyLooksLikeProduction(before);
  if (!shape.ok) {
    console.error(`rehearse-migrations: the loaded copy does not look like production: ${shape.reason}`);
    return 2;
  }

  // Past this point the copy is loaded and verified to hold real data. A
  // failure from here on - a migration that does not apply, a bad integrity
  // check, even a read that throws - is the rehearsal doing its job, not an
  // environment problem, so it is reported as a rehearsal failure (exit 1),
  // never an environment error (exit 2).
  try {
    console.log(`rehearse-migrations: applying ${pending.length} pending migration(s) to the copy ...`);
    const applyResult = runWrangler(
      ['d1', 'migrations', 'apply', DATABASE, '--local', '--persist-to', state],
      { env: { ...process.env, CI: '1' } }
    );
    if (applyResult.status !== 0) {
      console.error(applyResult.stdout);
      console.error(applyResult.stderr);
      return 1;
    }

    // Fix round 1, IMPORTANT 2: wrangler's own exit code says it did not
    // error, but the copy's own bookkeeping is the only honest source for
    // what actually landed - re-reading it here, instead of trusting
    // production's pending list, is what lets the success line report what
    // this run actually did rather than repeating what production needed.
    const appliedAfterLocal = appliedNamesOnCopy(state);
    const stillPending = pendingMigrations(localFiles, appliedAfterLocal);
    if (stillPending.length > 0) {
      console.error(
        `rehearse-migrations: wrangler reported success but these did not apply to the copy: ${stillPending.join(', ')}`
      );
      return 1;
    }
    const appliedCount = appliedAfterLocal.length - appliedBeforeLocal.length;

    console.log('rehearse-migrations: checking integrity ...');
    const quickCheck = d1Rows(DATABASE, 'PRAGMA quick_check', { remote: false, persistTo: state });
    const fkCheck = d1Rows(DATABASE, 'PRAGMA foreign_key_check', { remote: false, persistTo: state });
    const quickOk = quickCheck.length === 1 && Object.values(quickCheck[0])[0] === 'ok';
    if (!quickOk || fkCheck.length !== 0) {
      console.error('rehearse-migrations: integrity check failed');
      console.error('quick_check:', JSON.stringify(quickCheck));
      console.error('foreign_key_check:', JSON.stringify(fkCheck));
      return 1;
    }

    console.log('rehearse-migrations: counting rows after migration ...');
    const { tables: tablesAfter, counts: after } = countsByTable(state);

    const cmp = compareRowCounts(before, after, args.allowShrink);
    if (!cmp.ok) {
      console.error('rehearse-migrations: row count problems:');
      for (const problem of cmp.problems) console.error(`  ${problem}`);
      return 1;
    }

    console.log(
      `rehearsal passed: ${appliedCount} migration(s) applied to a copy of production, ` +
        `${tablesAfter.length} tables, integrity ok`
    );
    return 0;
  } catch (err) {
    console.error(`rehearse-migrations: rehearsal failed while checking the applied copy: ${err.message}`);
    return 1;
  }
}

// Runs the rehearsal and always cleans up the scratch directory afterward,
// as a plain sequential step rather than a try/finally: computeRehearsalCode
// never calls process.exit and reports its own thrown errors as a code, so
// by the time execution reaches the cleanup line below, the rehearsal (pass,
// fail, or environment error) is already fully decided and cleanup runs
// unconditionally, once, with a result the caller can fold into the exit
// code (fix round 1, CRITICAL: a cleanup failure must carry its own signal,
// never silently disappear).
function runRehearsal(args, pending, localFiles) {
  const work = path.join(ROOT, '.wrangler', 'rehearsal-' + Date.now());
  fs.mkdirSync(work, { recursive: true });
  const state = path.join(work, 'state');
  const prodSql = path.join(work, 'prod.sql');

  let code;
  try {
    code = computeRehearsalCode(args, pending, localFiles, state, prodSql);
  } catch (err) {
    console.error(`rehearse-migrations: unexpected error before the copy could be checked: ${err.message}`);
    code = 2;
  }

  let cleanupOk;
  if (args.keep) {
    console.log(`rehearse-migrations: scratch copy kept at ${work}`);
    cleanupOk = true;
  } else {
    cleanupOk = removeScratchDir(work, 'holds a copy of production data');
  }

  return { code, cleanupOk };
}

function main() {
  // Fix round 1, CRITICAL: sweep before anything else, so a leftover from an
  // earlier Ctrl-C or crash is cleaned up even if everything below this line
  // fails immediately.
  const sweepOk = sweepLeftoverScratchDirs();

  let args;
  try {
    args = parseRehearsalArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`rehearse-migrations: ${err.message}`);
    process.exitCode = finalExitCode(2, sweepOk);
    return;
  }

  console.log('rehearse-migrations: reading applied migrations from production ...');
  let appliedNames;
  try {
    appliedNames = d1Rows(DATABASE, 'SELECT name FROM d1_migrations ORDER BY id').map((r) => r.name);
  } catch (err) {
    console.error(`rehearse-migrations: could not read applied migrations from production: ${err.message}`);
    process.exitCode = finalExitCode(2, sweepOk);
    return;
  }

  // Fix round 1, MINOR: a missing/unreadable migrations/ directory is an
  // environment problem (exit 2), not an uncaught crash with the default
  // exit code of 1 - the deploy script branches on 1 meaning "rehearsal
  // failed", which this is not.
  let localFiles;
  try {
    localFiles = fs.readdirSync(path.join(ROOT, 'migrations'));
  } catch (err) {
    console.error(`rehearse-migrations: could not list migrations/: ${err.message}`);
    process.exitCode = finalExitCode(2, sweepOk);
    return;
  }

  const pending = pendingMigrations(localFiles, appliedNames);
  console.log(
    pending.length
      ? `rehearse-migrations: pending migrations: ${pending.join(', ')}`
      : 'rehearse-migrations: pending migrations: none'
  );

  if (pending.length === 0 && !args.force) {
    console.log('no pending migrations, nothing to rehearse');
    process.exitCode = finalExitCode(0, sweepOk);
    return;
  }

  const result = runRehearsal(args, pending, localFiles);
  // Fix round 1, MINOR: process.exit() can truncate stdout when it is a pipe
  // (which is how the guarded deploy script will run this). Setting
  // process.exitCode and returning lets Node flush normally once the event
  // loop drains, so the last printed lines are never lost.
  process.exitCode = finalExitCode(result.code, sweepOk && result.cleanupOk);
}

main();
