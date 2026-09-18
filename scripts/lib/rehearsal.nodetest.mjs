import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingMigrations, compareRowCounts, parseRehearsalArgs, countsQuery,
  leftoverRehearsalDirs, copyLooksLikeProduction, finalExitCode
} from './rehearsal.mjs';

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

test('args: --allow-shrink does not swallow the next flag as its value', () => {
  assert.throws(() => parseRehearsalArgs(['--allow-shrink', '--keep']), /allow-shrink/i);
  assert.throws(() => parseRehearsalArgs(['--allow-shrink', '--force']), /allow-shrink/i);
});

test('counts query quotes every table name and rejects a name that is not an identifier', () => {
  const q = countsQuery(['orders', 'tenants']);
  assert.match(q, /SELECT 'orders' AS t, COUNT\(\*\) AS n FROM "orders"/);
  assert.match(q, /UNION ALL/);
  assert.throws(() => countsQuery(['orders"; DROP TABLE x; --']), /table name/i);
  assert.throws(() => countsQuery([]), /no tables/i);
});

test('leftoverRehearsalDirs: matches only rehearsal-<digits>, never state or tmp', () => {
  const entries = ['rehearsal-1758180000000', 'state', 'tmp', 'rehearsal-abc', 'rehearsal-', 'rehearsal-123abc', '.gitkeep'];
  assert.deepEqual(leftoverRehearsalDirs(entries), ['rehearsal-1758180000000']);
  assert.deepEqual(leftoverRehearsalDirs([]), []);
  assert.deepEqual(leftoverRehearsalDirs(['state', 'tmp']), []);
});

test('copyLooksLikeProduction: an empty object (no tables) is not production-shaped', () => {
  const r = copyLooksLikeProduction({});
  assert.equal(r.ok, false);
  assert.match(r.reason, /table/i);
});

test('copyLooksLikeProduction: tables with all-zero rows is not production-shaped', () => {
  const r = copyLooksLikeProduction({ orders: 0, tenants: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /row/i);
});

test('copyLooksLikeProduction: at least one non-zero row count passes', () => {
  const r = copyLooksLikeProduction({ orders: 0, tenants: 3 });
  assert.equal(r.ok, true);
});

test('finalExitCode: a rehearsal failure always wins, cleanup outcome cannot mask it', () => {
  assert.equal(finalExitCode(1, true), 1);
  assert.equal(finalExitCode(1, false), 1);
});

test('finalExitCode: a failed cleanup escalates an otherwise-clean pass to an environment error', () => {
  assert.equal(finalExitCode(0, false), 2);
});

test('finalExitCode: a clean pass or an existing environment error pass through unchanged', () => {
  assert.equal(finalExitCode(0, true), 0);
  assert.equal(finalExitCode(2, true), 2);
  assert.equal(finalExitCode(2, false), 2);
});
