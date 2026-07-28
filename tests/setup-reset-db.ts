// tests/setup-reset-db.ts
//
// Restores PER-TEST database isolation, which @cloudflare/vitest-pool-workers
// removed in v4.
//
// Under pool-workers 0.5 every individual test got a clean D1: storage was
// stacked and unwound around each test, so a file could insert the same fixture
// row in test after test and never collide. v4 isolates storage PER TEST FILE
// instead, matching Vitest's own model, and the 2026-07-28 upgrade surfaced that
// immediately: 229 failures across 40 files, dominated by
//   UNIQUE constraint failed: product_links.shop, product_links.cj_pid
//   UNIQUE constraint failed: affiliate_vouchers.shop, affiliate_vouchers.code
//   UNIQUE constraint failed: inbox_messages.shop, inbox_messages.message_id
// which is rows from one test surviving into the next, not broken logic.
//
// Registering the reset HERE rather than editing 40 test files is deliberate:
// 38 of them carry the identical
//   beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
// so the behaviour they relied on belongs in one place, not copy-pasted 40 times
// where it would drift. A setup-file hook runs before each test in EVERY file,
// so new test files inherit the isolation automatically instead of having to
// remember it.
//
// Ordering: this hook runs BEFORE the file's own beforeEach. On the very first
// test the tables do not exist yet, the sqlite_master query simply returns
// nothing, and the file's own applyD1Migrations then creates them. On every
// later test the tables are wiped here and applyD1Migrations is a no-op. That is
// why this file only truncates and does not apply migrations itself: doing both
// would re-run every migration for all 1,861 tests.
//
// No file in the suite uses beforeAll to seed data (checked at the time of the
// upgrade), so wiping between tests cannot destroy once-per-file fixtures.

import { beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

// The table list is derived from the MIGRATIONS, not from sqlite_master: D1
// refuses to read sqlite_master ("D1_ERROR: not authorized: SQLITE_AUTH"), so
// enumerating tables at runtime is not available to us. The migrations are the
// authoritative schema anyway, and they are already in the binding, so a table
// added by a future migration is picked up here with no extra bookkeeping.
const TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?([A-Za-z_][A-Za-z0-9_]*)["'`\]]?/gi;

function tablesFromMigrations(migrations: unknown): string[] {
  const names = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(TABLE_RE)) {
        const name = m[1];
        // d1_* is the applied-migration bookkeeping: clearing it would make
        // applyD1Migrations replay every migration on every test.
        if (!name.toLowerCase().startsWith('d1_') && !name.toLowerCase().startsWith('sqlite_')) names.add(name);
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(migrations);
  return [...names];
}

let tables: string[] | null = null;

beforeEach(async () => {
  if (tables === null) tables = tablesFromMigrations(env.TEST_MIGRATIONS);
  for (const name of tables) {
    // A table the migrations declare may not exist yet on the very first test of
    // a file (this hook runs before the file's own applyD1Migrations), so a
    // missing-table error here is expected and not a failure.
    try { await env.DB.prepare(`DELETE FROM "${name}"`).run(); } catch { /* not created yet */ }
  }
});
