import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openCopy, userTables, rowCounts, appliedNames, applyMigration, integrityProblems
} from './rehearsal-db.mjs';
import { compareRowCounts } from './rehearsal.mjs';

// A small dump in the same shape wrangler's real `d1 export` produces
// (measured 2026-09-18: PRAGMA defer_foreign_keys=TRUE; first, then CREATE
// TABLE / INSERT INTO / CREATE INDEX statements, no transaction wrapping).
// Two user tables (tenants, orders) linked by a real foreign key, one NULL
// in tenants.note (row 2), one duplicate value 'first' in tenants.note (rows
// 1 and 3, a non-unique column), and a _cf_KV table to prove the _cf_%
// exclusion actually does something.
function freshDump() {
  return `
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE d1_migrations(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO d1_migrations (id, name, applied_at) VALUES (1, '0001_init.sql', '2026-01-01 00:00:00');
CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT, note TEXT);
INSERT INTO tenants (id, name, note) VALUES (1, 'acme', 'first'), (2, 'beta', NULL), (3, 'gamma', 'first');
CREATE TABLE orders (id INTEGER PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id), amount INTEGER);
INSERT INTO orders (id, tenant_id, amount) VALUES (1, 1, 100), (2, 2, 200), (3, 3, 300);
CREATE TABLE _cf_KV (key TEXT, value TEXT);
`;
}

test('openCopy + userTables + rowCounts: sqlite_% and _cf_% tables are excluded', () => {
  const db = openCopy(freshDump());
  assert.deepEqual(userTables(db), ['orders', 'tenants']);
  assert.deepEqual(rowCounts(db, userTables(db)), { orders: 3, tenants: 3 });
  db.close();
});

test('rowCounts: rejects a table name that is not a valid identifier', () => {
  // SQLite cannot bind an identifier as a parameter, so rowCounts builds the
  // table name into the statement text. The name must therefore be validated,
  // and this pins that it is.
  const db = openCopy(freshDump());
  assert.throws(() => rowCounts(db, ['notes"; DROP TABLE tenants; --']), /bad table name/i);
  db.close();
});

test('appliedNames reads d1_migrations by id order, not insertion order', () => {
  const db = openCopy(freshDump());
  // Inserted out of id order (5 then 2) so the assertion can only pass if
  // appliedNames genuinely orders by id. With a single row, ordering could
  // never fail.
  db.exec("INSERT INTO d1_migrations (id, name, applied_at) VALUES (5, '0005_five.sql', '2026-01-02 00:00:00');");
  db.exec("INSERT INTO d1_migrations (id, name, applied_at) VALUES (2, '0002_two.sql', '2026-01-01 12:00:00');");
  assert.deepEqual(appliedNames(db), ['0001_init.sql', '0002_two.sql', '0005_five.sql']);
  db.close();
});

test('applyMigration: a harmless migration applies and is appended to appliedNames', () => {
  const db = openCopy(freshDump());
  applyMigration(db, '0002_add_region.sql', 'ALTER TABLE tenants ADD COLUMN region TEXT;');
  assert.deepEqual(appliedNames(db), ['0001_init.sql', '0002_add_region.sql']);
  const cols = db.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
  assert.ok(cols.includes('region'));
  db.close();
});

test('applyMigration: a multi-statement migration applies as one unit', () => {
  const db = openCopy(freshDump());
  applyMigration(db, '0002_two_alters.sql', 'ALTER TABLE orders ADD COLUMN a TEXT;\nALTER TABLE orders ADD COLUMN b TEXT;');
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  assert.ok(cols.includes('a') && cols.includes('b'));
  db.close();
});

test('applyMigration: NOT NULL over an existing NULL throws, names the file, and rolls back completely', () => {
  const db = openCopy(freshDump());
  const before = rowCounts(db, userTables(db));
  const appliedBefore = appliedNames(db);
  const rebuild = `
    CREATE TABLE tenants_new (id INTEGER PRIMARY KEY, name TEXT, note TEXT NOT NULL);
    INSERT INTO tenants_new SELECT id, name, note FROM tenants;
    DROP TABLE tenants;
    ALTER TABLE tenants_new RENAME TO tenants;
  `;
  assert.throws(
    () => applyMigration(db, '0002_note_not_null.sql', rebuild),
    (err) => err.message.startsWith('0002_note_not_null.sql:')
  );
  assert.deepEqual(rowCounts(db, userTables(db)), before);
  assert.deepEqual(appliedNames(db), appliedBefore);
  assert.deepEqual(userTables(db), ['orders', 'tenants']); // tenants_new did not survive
  db.close();
});

test('applyMigration: CREATE UNIQUE INDEX over a duplicate value throws and rolls back the same way', () => {
  const db = openCopy(freshDump());
  const before = rowCounts(db, userTables(db));
  const appliedBefore = appliedNames(db);
  assert.throws(
    () => applyMigration(db, '0002_unique_note.sql', 'CREATE UNIQUE INDEX idx_tenants_note ON tenants(note);'),
    (err) => err.message.startsWith('0002_unique_note.sql:')
  );
  assert.deepEqual(rowCounts(db, userTables(db)), before);
  assert.deepEqual(appliedNames(db), appliedBefore);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tenants_note'").all(), []);
  db.close();
});

test('applyMigration: a bare COMMIT in the file hints at the real cause instead of a bare SQLite message', () => {
  const db = openCopy(freshDump());
  assert.throws(
    () => applyMigration(db, '0002_bad_commit.sql', 'COMMIT;'),
    (err) =>
      err.message.startsWith('0002_bad_commit.sql:') &&
      /cannot commit - no transaction is active/.test(err.message) &&
      /own transaction control/.test(err.message)
  );
  db.close();
});

test('applyMigration: a nested BEGIN in the file hints at the real cause too', () => {
  const db = openCopy(freshDump());
  assert.throws(
    () => applyMigration(db, '0002_bad_begin.sql', 'BEGIN;'),
    (err) =>
      err.message.startsWith('0002_bad_begin.sql:') &&
      /cannot start a transaction within a transaction/.test(err.message) &&
      /own transaction control/.test(err.message)
  );
  db.close();
});

test('applyMigration: an unrelated failure gets no transaction-control hint', () => {
  const db = openCopy(freshDump());
  assert.throws(
    () => applyMigration(db, '0002_typo.sql', 'ALTER TABLE nonexistent_table ADD COLUMN x TEXT;'),
    (err) =>
      err.message.startsWith('0002_typo.sql:') &&
      /no such table/.test(err.message) &&
      !/own transaction control/.test(err.message)
  );
  db.close();
});

test('applyMigration: a migration that deletes rows applies cleanly and compareRowCounts catches it, or allows it via allowShrink', () => {
  const db = openCopy(freshDump());
  const before = rowCounts(db, userTables(db));
  applyMigration(db, '0002_delete_order.sql', 'DELETE FROM orders WHERE id = 1;');
  const after = rowCounts(db, userTables(db));
  assert.equal(compareRowCounts(before, after, []).ok, false);
  assert.equal(compareRowCounts(before, after, ['orders']).ok, true);
  db.close();
});

test('applyMigration: a dangling child row (deferred FK) throws at COMMIT, not silently - measured 2026-09-18', () => {
  // Measured directly against node:sqlite (DatabaseSync defaults
  // PRAGMA foreign_keys=1): deleting a referenced parent under
  // defer_foreign_keys defers the violation to COMMIT, where it throws
  // "FOREIGN KEY constraint failed" rather than ever reaching
  // integrityProblems/newProblems - it cannot pass silently either way.
  const db = openCopy(freshDump());
  const before = rowCounts(db, userTables(db));
  const appliedBefore = appliedNames(db);
  assert.throws(
    () => applyMigration(db, '0002_orphan_order.sql', 'PRAGMA defer_foreign_keys=TRUE;\nDELETE FROM tenants WHERE id = 3;'),
    (err) => err.message.startsWith('0002_orphan_order.sql:') && /FOREIGN KEY constraint failed/.test(err.message)
  );
  assert.deepEqual(rowCounts(db, userTables(db)), before);
  assert.deepEqual(appliedNames(db), appliedBefore);
  db.close();
});

test('integrityProblems: a clean copy reports no problems', () => {
  const db = openCopy(freshDump());
  assert.deepEqual(integrityProblems(db), []);
  db.close();
});

test('integrityProblems: a real dangling reference is reported with the exact string, including fkid', () => {
  // Without this test nothing asserts that integrityProblems ever returns a
  // NON-empty array, so an implementation that always returned [] would pass
  // the whole file. foreign_keys=OFF lets the violation exist outside any
  // transaction, which mirrors how an orphaned row can already sit in
  // production.
  const db = openCopy(freshDump());
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec('DELETE FROM tenants WHERE id = 3;'); // orders row 3 (tenant_id=3) now dangles
  assert.deepEqual(integrityProblems(db), ['foreign_key_check: table=orders rowid=3 parent=tenants fkid=0']);
  db.close();
});

test('integrityProblems: a violation that exists before any migration runs (table=notes rowid=2 parent=tenants) is reported - this is what the before-apply gate refuses on', () => {
  // Why the rule is strict. A table rebuild renumbers rowids, so a NEW
  // violation can land on the exact same table/rowid/parent string as an OLD
  // one (measured 2026-09-18). An earlier design compared the problem list
  // before and after the apply and failed only on new strings; that set
  // difference could PASS a migration that broke a foreign key, so it was
  // deleted rather than fixed. Under the strict rule nothing needs telling
  // apart: a copy with ANY integrity problem before the apply is refused
  // outright. This test shows that this exact case IS a non-empty
  // integrityProblems() result, which is the wrapper's whole before-apply
  // decision (`if (problems.length > 0)`), asserted here directly rather than
  // by spawning the wrapper.
  const db = openCopy(
    freshDump() +
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id), body TEXT);\n" +
      "INSERT INTO notes (id, tenant_id, body) VALUES (1, 1, 'ok'), (2, 1, 'will be corrupted');\n"
  );
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec('UPDATE notes SET tenant_id = 999 WHERE id = 2;');
  const problems = integrityProblems(db);
  assert.deepEqual(problems, ['foreign_key_check: table=notes rowid=2 parent=tenants fkid=0']);
  db.close();
});

test('applyMigration: a failed rollback does not mask the original error', () => {
  const calls = [];
  const fakeDb = {
    exec(sql) {
      calls.push(sql);
      if (sql === 'BEGIN') return;
      if (sql === 'ROLLBACK') throw new Error('rollback also failed: disk full');
      if (sql === 'COMMIT') throw new Error('should never reach COMMIT in this test');
      throw new Error('original failure: syntax error near BOGUS');
    },
    prepare() {
      throw new Error('should never reach prepare() in this test');
    }
  };
  assert.throws(
    () => applyMigration(fakeDb, '0099_bad.sql', 'BOGUS SQL'),
    (err) => err.message.startsWith('0099_bad.sql:') && /original failure/.test(err.message) && !/rollback also failed/.test(err.message)
  );
  assert.deepEqual(calls, ['BEGIN', 'BOGUS SQL', 'ROLLBACK']);
});
