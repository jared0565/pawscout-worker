// scripts/lib/rehearsal-db.mjs
//
// Everything that touches SQLite for the migration rehearsal, kept in one
// file so it is testable with `node --test` alone - no wrangler, no
// filesystem beyond what the caller hands in as a string.
//
// WHY THIS EXISTS. The rehearsal used to load production's exported dump
// into a local D1 database through `wrangler d1 execute --local --file`,
// which runs on wrangler's bundled Workers runtime (Miniflare/workerd). Run
// for real against production on 2026-09-18, that load step made workerd
// print 190 `kj/table.c++:57: HashIndex detected hash table inconsistency`
// errors and then die with a 300 second Body Timeout on the real 15.5 MB /
// 16,806-row dump. `node:sqlite`'s DatabaseSync loads the SAME dump into
// :memory: in 182ms (measured), because it is plain SQLite with no Workers
// runtime, no HTTP body, and no 300 second budget in between.
//
// DIVISION OF LABOUR this creates: staging proves "real D1 accepts this
// SQL" (the deploy script applies migrations to the staging D1 first, over
// the real Workers/D1 stack). This rehearsal proves "production's DATA
// survives this SQL" (a NOT NULL rebuild over an existing NULL, a UNIQUE
// index over a duplicate, a rebuild that quietly loses rows, a foreign key
// left dangling). Those are SQLite semantics, not Workers-runtime behaviour,
// so they do not need - and now no longer use - the Workers runtime at all.
//
// This file used to export a `newProblems(before, after)` set difference, so
// a violation already present before the apply would not fail the run
// twice. That was measured (2026-09-18) to produce a real false PASS:
// `integrityProblems` strings a violation by table/rowid/parent, and a
// rowid is not stable across a table rebuild - a migration that rebuilt a
// table, dropped the row holding the OLD violation, and orphaned a
// DIFFERENT row produced the IDENTICAL string (the new row landed on the
// old violation's rowid), so the set difference saw nothing new and passed
// a migration that broke referential integrity. Counting did not help
// either (1 before, 1 after). The ruling: stop trying to tell old from new.
// `newProblems` is deleted. Any integrity problem BEFORE the apply now stops
// the run outright (exit 2 - nothing about the migration can be proven when
// the copy started broken); any problem found AFTER the apply is exit 1,
// and is guaranteed new by construction, because the copy was clean before.

import { DatabaseSync } from 'node:sqlite';

// Loads a D1-export-shaped SQL dump (a string) into a fresh SQLite database
// and returns the open handle. `file` defaults to an in-memory database;
// callers doing a --keep run pass a real path so the copy survives for
// inspection after the process exits. If the dump itself fails to load, the
// handle is closed before rethrowing rather than leaking an open file
// descriptor on the caller's `file` path.
export function openCopy(dumpSql, file = ':memory:') {
  const db = new DatabaseSync(file);
  try {
    db.exec(dumpSql);
  } catch (err) {
    try {
      db.close();
    } catch {
      // Best-effort; the load itself already failed, so the original error
      // below is what matters.
    }
    throw err;
  }
  return db;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The application's own tables: everything except SQLite's internal
// bookkeeping (`sqlite_%`, e.g. sqlite_sequence from an AUTOINCREMENT
// column), D1's internal bookkeeping (`_cf_%`), and d1_migrations itself
// (wrangler's migration ledger, not a "user" table - tracked separately via
// appliedNames).
export function userTables(db) {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' " +
        "AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name"
    )
    .all();
  return rows.map((row) => row.name);
}

// One row count per table. Table names are expected to come from
// userTables() (sqlite_master, not user input), but are still validated
// against a strict identifier pattern before being spliced into SQL, since
// node:sqlite has no parameter binding for identifiers.
export function rowCounts(db, tables) {
  const counts = {};
  for (const table of tables) {
    if (!IDENTIFIER.test(table)) throw new Error(`bad table name: ${table}`);
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get();
    counts[table] = row.n;
  }
  return counts;
}

// d1_migrations' own record of what has been applied, in application order.
export function appliedNames(db) {
  return db
    .prepare('SELECT name FROM d1_migrations ORDER BY id')
    .all()
    .map((row) => row.name);
}

// A migration file that contains its own transaction control (BEGIN,
// COMMIT, or ROLLBACK) hits one of these two node:sqlite messages, because
// it collides with the BEGIN/COMMIT this function already wraps it in. Both
// are D1-illegal in a migration and both defeat the rollback this function
// exists to guarantee, so the error gets a hint pointing at the real cause
// instead of a bare SQLite message that names no file and no reason. This
// only matches known message text; it never parses the migration's SQL.
const TRANSACTION_COLLISION = /cannot commit - no transaction is active|cannot start a transaction within a transaction/i;

// Applies one migration file as a single atomic unit, mirroring how wrangler
// applies and records one migration file at a time: BEGIN, the file's own
// SQL (which may be several statements - node:sqlite's exec() runs all of
// them), then the ledger insert, then COMMIT. Any failure at any step - a
// bad statement, a constraint violated immediately, or one deferred to
// COMMIT (see the dangling-foreign-key test), or the BEGIN itself failing -
// rolls back everything this call did, including a partially-completed
// multi-statement rebuild, and rethrows an Error whose message starts with
// the migration file name so the wrapper can report exactly which file did
// not apply.
export function applyMigration(db, name, sql) {
  try {
    db.exec('BEGIN'); // inside the try: a failed BEGIN must still be named
    db.exec(sql);
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A rollback can itself fail (a broken connection, nothing to roll
      // back). Swallowed on purpose: the ORIGINAL error below is what the
      // caller needs to see, and a failed rollback must never replace it.
    }
    const hint = TRANSACTION_COLLISION.test(err.message)
      ? ' (hint: this file appears to contain its own transaction control - BEGIN, COMMIT, or ROLLBACK - which D1 rejects in a migration and which defeats this rehearsal\'s own rollback)'
      : '';
    throw new Error(`${name}: ${err.message}${hint}`, { cause: err });
  }
}

// One string per integrity problem. quick_check returns one row per
// problem, each a plain string (or the single row 'ok' when clean);
// foreign_key_check returns one row per dangling reference, with
// table/rowid/parent/fkid columns - all four are included since identity no
// longer matters (see the file header for why "old vs new" was abandoned as
// a comparison).
export function integrityProblems(db) {
  const problems = [];
  for (const row of db.prepare('PRAGMA quick_check').all()) {
    const value = Object.values(row)[0];
    if (value !== 'ok') problems.push(`quick_check: ${value}`);
  }
  for (const row of db.prepare('PRAGMA foreign_key_check').all()) {
    problems.push(`foreign_key_check: table=${row.table} rowid=${row.rowid} parent=${row.parent} fkid=${row.fkid}`);
  }
  return problems;
}
