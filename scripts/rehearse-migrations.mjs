#!/usr/bin/env node
// scripts/rehearse-migrations.mjs
//
// WHY: proves pending migrations apply cleanly to a full, throwaway copy of
// production D1 data (customer messages, addresses) before a real deploy
// touches it. DIVISION OF LABOUR: staging proves "real D1 accepts this SQL"
// (the deploy script applies migrations there first, over the real
// Workers/D1 stack); this proves "production's DATA survives this SQL" -
// SQLite semantics (NOT NULL over an existing NULL, a UNIQUE index over a
// duplicate, a lost row, a dangling foreign key). That is why load/apply/checks
// run on node:sqlite (scripts/lib/rehearsal-db.mjs) instead of wrangler's
// local Workers runtime, which could not ingest the real 15.5 MB dump (190
// workerd HashIndex errors, then a 300s Body Timeout, measured running this
// script for real on 2026-09-18). wrangler still does exactly two things:
// read d1_migrations from production, and the export.
//
// Usage: node scripts/rehearse-migrations.mjs [--force] [--allow-shrink t1,t2] [--keep]
//   --force         rehearse even if nothing is pending
//   --allow-shrink  comma-separated table names allowed to shrink or vanish
//   --keep          keep the scratch copy on disk (as <work>/copy.sqlite) for debugging
//
// Exit 0: passed, or nothing pending. Exit 1: the rehearsal failed (the
// point of this script). Exit 2: bad usage or an environment problem that
// never got as far as testing a migration, or that leaves production data
// on disk regardless of outcome.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runWrangler, d1Rows } from './lib/run.mjs';
import {
  pendingMigrations, compareRowCounts, parseRehearsalArgs,
  leftoverRehearsalDirs, copyLooksLikeProduction, finalExitCode
} from './lib/rehearsal.mjs';

const DATABASE = 'pawscout';

// fs.rmSync's `force` only swallows ENOENT; a handle still open on a
// just-written file raises EBUSY/EPERM on Windows, so this retries briefly
// then warns loudly and names the path rather than failing silently. Checks
// existence first so it never claims a deletion that did not happen - the
// mkdir-failure path calls this on a directory that may never have existed,
// and that is the one output that must stay trustworthy about whether
// production data is actually still on disk.
function removeScratch(target, whatItHolds) {
  const existed = fs.existsSync(target);
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(
      existed ? `rehearse-migrations: deleted ${target}` : `rehearse-migrations: nothing to delete at ${target}`
    );
    return true;
  } catch (err) {
    console.error(
      `rehearse-migrations: WARNING: could not delete ${target} (${err.message}). ` +
        `This ${whatItHolds} and must be deleted by hand.`
    );
    return false;
  }
}

// Sweeps leftovers from earlier runs: a `finally` never runs if the process
// dies outright (Ctrl-C during the long export), so this is what actually
// guarantees a leftover copy of production does not survive past the NEXT
// run. A sweep failure STOPS main(): tolerating it could let a run create a
// second unremoved copy.
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
    const ok = removeScratch(path.join(wranglerDir, name), 'may hold a copy of production data from an earlier run');
    if (ok) removed++;
    else allOk = false;
  }
  console.log(`rehearse-migrations: startup sweep: removed ${removed} of ${leftovers.length} leftover dir(s)`);
  return allOk;
}

// Export through final verdict. Returns a plain exit code; never calls
// process.exit, and never removes `work` (runRehearsal does that once,
// after this returns). db.close() runs here via finally, before the caller
// can try to remove the directory it lives in - an open handle causes EBUSY.
// `cleanupState.prodSqlCleanupOk` is written directly, not only returned:
// a throw anywhere after the early delete would otherwise discard whatever
// this function had already learned about it.
function computeRehearsalCode(args, pending, localFiles, work, prodSql, rehearsalDb, cleanupState) {
  const { openCopy, userTables, rowCounts, appliedNames, applyMigration, integrityProblems } = rehearsalDb;

  console.log(`rehearse-migrations: exporting production data to ${prodSql} ...`);
  const exportResult = runWrangler(['d1', 'export', DATABASE, '--remote', '--output', prodSql]);
  if (exportResult.status !== 0) {
    console.error(exportResult.stderr || exportResult.stdout);
    console.error(
      "rehearse-migrations: Cloudflare's export endpoint has been observed (2026-09-18) returning a " +
        "transient 'Authentication error [code: 10000]' that succeeded on retry ~50s later. Try again; " +
        'if it keeps failing, check `npx wrangler whoami`.'
    );
    return 2; // the scratch directory is removed afterward regardless
  }

  console.log('rehearse-migrations: loading the export into an in-memory SQLite copy ...');
  // The dump and this in-memory copy both scale with production (15.5 MB
  // today, measured 2026-09-18); a JS string cannot exceed roughly 512 MB,
  // at which point this whole design needs replacing - readFileSync will
  // fail loudly here, exit 2, rather than silently.
  const dumpText = fs.readFileSync(prodSql, 'utf8');
  const db = openCopy(dumpText, args.keep ? path.join(work, 'copy.sqlite') : ':memory:');

  // No production data needs to sit on disk once it is loaded.
  if (!args.keep) {
    cleanupState.prodSqlCleanupOk = removeScratch(prodSql, 'is the exported production dump (customer data)');
  }

  try {
    console.log('rehearse-migrations: counting rows and checking integrity before migration ...');
    const before = rowCounts(db, userTables(db));

    // Strict by design: a rowid is not stable across a table rebuild, so a
    // before/after STRING diff can mask a genuinely new foreign key
    // violation with an old one's identity (see the comment in
    // rehearsal-db.mjs). Any problem here means nothing about this
    // migration can be proven either way: stop, exit 2.
    const problemsBefore = integrityProblems(db);
    if (problemsBefore.length > 0) {
      console.error('rehearse-migrations: production already has integrity problems:');
      for (const problem of problemsBefore) console.error(`  ${problem}`);
      console.error(
        'rehearse-migrations: across a table rebuild this rehearsal cannot tell an old violation from a ' +
          'new one, so it refuses to guess. Fix these rows in production first, then run this again.'
      );
      return 2;
    }

    const shape = copyLooksLikeProduction(before);
    if (!shape.ok) {
      console.error(`rehearse-migrations: the loaded copy does not look like production: ${shape.reason}`);
      return 2;
    }

    // Past this point a failure - a migration that does not apply, a bad
    // check, even a throw - is the rehearsal doing its job: exit 1, not 2.
    try {
      console.log(`rehearse-migrations: applying ${pending.length} pending migration(s) to the copy ...`);
      for (const name of pending) {
        applyMigration(db, name, fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8'));
      }

      // The copy's own bookkeeping, not production's pending list, is the
      // honest source for what actually landed.
      const stillPending = pendingMigrations(localFiles, appliedNames(db));
      if (stillPending.length > 0) {
        console.error(`rehearse-migrations: these did not apply to the copy: ${stillPending.join(', ')}`);
        return 1;
      }

      console.log('rehearse-migrations: counting rows and checking integrity after migration ...');
      const tablesAfter = userTables(db);
      const cmp = compareRowCounts(before, rowCounts(db, tablesAfter), args.allowShrink);
      if (!cmp.ok) {
        console.error('rehearse-migrations: row count problems:');
        for (const problem of cmp.problems) console.error(`  ${problem}`);
        return 1;
      }

      // Guaranteed new by construction: the copy was already proven clean
      // above, before the apply, so any problem found here was caused by
      // these migrations.
      const problemsAfter = integrityProblems(db);
      if (problemsAfter.length > 0) {
        console.error('rehearse-migrations: integrity problems introduced by these migrations:');
        for (const problem of problemsAfter) console.error(`  ${problem}`);
        return 1;
      }

      const appliedPhrase = pending.length > 0
        ? `applied ${pending.join(', ')} to a copy of production`
        : 'no migrations pending';
      console.log(`rehearsal passed: ${appliedPhrase}, ${tablesAfter.length} tables, integrity ok`);
      return 0;
    } catch (err) {
      console.error(`rehearse-migrations: rehearsal failed while applying or checking the copy: ${err.message}`);
      return 1;
    }
  } finally {
    try {
      db.close();
    } catch {
      // Best-effort; must not mask whatever code was already decided above.
    }
  }
}

// Creates the scratch dir and always cleans up afterward as a plain
// sequential step, not a finally: computeRehearsalCode never calls
// process.exit and turns its own thrown errors into a code, so cleanup here
// runs unconditionally, once, after the rehearsal is already decided.
function runRehearsal(args, pending, localFiles, rehearsalDb) {
  const work = path.join(ROOT, '.wrangler', 'rehearsal-' + Date.now());
  try {
    fs.mkdirSync(work, { recursive: true });
  } catch (err) {
    // An environment problem, exit 2: an uncaught throw here would crash
    // with Node's default exit code 1, which the deploy script reads as
    // "rehearsal FAILED" rather than "could not even start".
    console.error(`rehearse-migrations: could not create the scratch work directory ${work}: ${err.message}`);
    return { code: 2, cleanupOk: removeScratch(work, 'may partially exist after a failed setup') };
  }

  const prodSql = path.join(work, 'prod.sql');
  const cleanupState = { prodSqlCleanupOk: true };
  let code;
  try {
    code = computeRehearsalCode(args, pending, localFiles, work, prodSql, rehearsalDb, cleanupState);
  } catch (err) {
    console.error(`rehearse-migrations: unexpected error before the copy could be checked: ${err.message}`);
    code = 2;
  }

  if (args.keep) {
    console.log(
      `rehearse-migrations: scratch copy kept at ${work} - it holds prod.sql and copy.sqlite, full copies ` +
        'of customer messages and addresses, and must be deleted BY HAND. The NEXT run of this script ' +
        'sweeps it away at startup (it matches rehearsal-<digits>), so copy anything you need out of it first.'
    );
    return { code, cleanupOk: true };
  }

  removeScratch(work, 'may still hold a copy of production data');

  // The verified truth, not the two cleanup attempts' own separate claims:
  // does the work directory - which contains prod.sql - still exist? An
  // early prod.sql delete failure followed by a later whole-directory
  // delete success is not a contradiction once checked this way: removing
  // the directory took prod.sql with it, so a "must be deleted by hand"
  // warning printed earlier about prod.sql no longer describes reality, and
  // a clean pass must not be escalated to exit 2 over data that is gone.
  const stillOnDisk = fs.existsSync(work);
  if (!stillOnDisk && !cleanupState.prodSqlCleanupOk) {
    console.log(
      `rehearse-migrations: the earlier warning about ${prodSql} no longer applies - the whole scratch ` +
        'directory, including that file, has since been deleted.'
    );
  }

  return { code, cleanupOk: !stillOnDisk };
}

async function main() {
  // node:sqlite now does all the local work; both this probe and the import
  // of rehearsal-db.mjs (which needs it too) are dynamic, so an old Node
  // version fails here with a clear message rather than crashing at load.
  let rehearsalDb;
  try {
    await import('node:sqlite');
    rehearsalDb = await import('./lib/rehearsal-db.mjs');
  } catch (err) {
    console.error(`rehearse-migrations: needs Node 22.13 or newer (node:sqlite not available): ${err.message}`);
    process.exitCode = 2;
    return;
  }

  // A sweep failure STOPS here: carrying on would export a second,
  // unremoved copy of production beside the first.
  if (!sweepLeftoverScratchDirs()) {
    process.exitCode = 2;
    return;
  }

  let args;
  try {
    args = parseRehearsalArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`rehearse-migrations: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  console.log('rehearse-migrations: reading applied migrations from production ...');
  let appliedNamesOnProd;
  try {
    appliedNamesOnProd = d1Rows(DATABASE, 'SELECT name FROM d1_migrations ORDER BY id').map((r) => r.name);
  } catch (err) {
    console.error(`rehearse-migrations: could not read applied migrations from production: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  let localFiles;
  try {
    localFiles = fs.readdirSync(path.join(ROOT, 'migrations'));
  } catch (err) {
    console.error(`rehearse-migrations: could not list migrations/: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const pending = pendingMigrations(localFiles, appliedNamesOnProd);
  console.log(
    pending.length
      ? `rehearse-migrations: pending migrations: ${pending.join(', ')}`
      : 'rehearse-migrations: pending migrations: none'
  );

  if (pending.length === 0 && !args.force) {
    console.log('no pending migrations, nothing to rehearse');
    process.exitCode = 0;
    return;
  }

  const result = runRehearsal(args, pending, localFiles, rehearsalDb);
  // process.exitCode, not process.exit(): the cleanup and buffered output
  // above must finish before the process actually exits. scripts/deploy.mjs
  // runs this with stdio: 'inherit', not a pipe, so the ordering - not
  // truncation - is the risk here.
  process.exitCode = finalExitCode(result.code, result.cleanupOk);
}

main().catch((err) => {
  // A floating promise with no .catch would otherwise let an unexpected
  // throw fall through to Node's default exit code of 1, which
  // scripts/deploy.mjs reads as "the rehearsal FAILED" rather than "could
  // not run at all".
  console.error(`rehearse-migrations: unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
