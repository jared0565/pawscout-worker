// scripts/lib/rehearsal.mjs
//
// Pure helpers for the migration rehearsal (scripts/rehearse-migrations.mjs).
// Kept side-effect free and separate from that script so they can be unit
// tested without touching wrangler, D1, or the filesystem (2026-09-18,
// deploy-safety phase 1, task 3).

// Local .sql files not yet recorded as applied, sorted so they run in the
// same order wrangler's own migration numbering implies. Non-.sql files
// (README.md, etc.) in migrations/ are ignored.
export function pendingMigrations(localFiles, appliedNames) {
  const applied = new Set(appliedNames);
  return localFiles
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => !applied.has(name));
}

// Compares a table -> row count snapshot taken before the rehearsal migration
// run against one taken after. A table that shrinks or disappears is a sign
// the migration destroyed data rather than transformed it, unless the caller
// named it in allowShrink (a table that is genuinely meant to be pruned, e.g.
// a cache table). Growth and new tables are never a problem.
export function compareRowCounts(before, after, allowShrink = []) {
  const skip = new Set(allowShrink);
  const problems = [];
  for (const [table, countBefore] of Object.entries(before)) {
    if (skip.has(table)) continue;
    if (!(table in after)) {
      problems.push(`${table}: table is gone after the migrations (had ${countBefore} rows)`);
      continue;
    }
    const countAfter = after[table];
    if (countAfter < countBefore) {
      problems.push(`${table}: ${countBefore} rows before, ${countAfter} after`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// CLI argument parsing for rehearse-migrations.mjs. Deliberately strict:
// an unrecognised flag or a flag missing its value throws rather than being
// silently ignored, since a mistyped flag here would otherwise rehearse the
// wrong thing and still report success.
export function parseRehearsalArgs(argv) {
  const out = { force: false, allowShrink: [], keep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      out.force = true;
    } else if (arg === '--keep') {
      out.keep = true;
    } else if (arg === '--allow-shrink') {
      const value = argv[++i];
      // A missing value AND a value that is itself another flag (the user
      // forgot the comma-separated list and the next flag got swallowed
      // instead) both mean --allow-shrink did not get what it needs.
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--allow-shrink requires a comma-separated value');
      }
      out.allowShrink = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// One UNION ALL query that returns a row count per table in a single D1
// round trip. Table names come from sqlite_master (not user input) but are
// still validated against a strict identifier pattern before being spliced
// into SQL, since d1Rows has no parameter binding for identifiers.
export function countsQuery(tables) {
  if (tables.length === 0) throw new Error('no tables to count');
  for (const table of tables) {
    if (!IDENTIFIER.test(table)) throw new Error(`bad table name: ${table}`);
  }
  return tables.map((table) => `SELECT '${table}' AS t, COUNT(*) AS n FROM "${table}"`).join(' UNION ALL ');
}

// Fix round 1 (2026-09-18), CRITICAL: a scratch copy of production can be
// left on disk if the process dies before its own finally runs (Ctrl-C
// during the long remote export, a hard crash) - a finally block only ever
// protects against a normal JS exception, not against the process itself
// being killed. The real fix is sweeping leftovers from EARLIER runs at the
// start of every new run. This is the pure "which names count as a leftover"
// rule, kept narrow on purpose so it can never match the shared `state` or
// `tmp` directories that also live under .wrangler/.
const LEFTOVER_DIR = /^rehearsal-\d+$/;

export function leftoverRehearsalDirs(entries) {
  return entries.filter((name) => LEFTOVER_DIR.test(name));
}

// Fix round 1 (2026-09-18), IMPORTANT 1: a copy that loaded no tables, or
// loaded tables with zero rows in every one, is not a copy of production at
// all - it is a schema-only shell, most likely because the export or the
// load into the local database silently produced nothing. Treating that as
// "rehearsal passed" would be worse than not rehearsing: it is exactly the
// false confidence this script exists to prevent. ok is true as soon as ONE
// table carries at least one row; that is enough to prove data actually
// moved.
export function copyLooksLikeProduction(before) {
  const tables = Object.keys(before);
  if (tables.length === 0) {
    return { ok: false, reason: 'the loaded copy has no tables at all' };
  }
  const totalRows = tables.reduce((sum, table) => sum + before[table], 0);
  if (totalRows === 0) {
    return { ok: false, reason: 'the loaded copy has tables but zero rows in all of them' };
  }
  return { ok: true, reason: null };
}

// Fix round 1 (2026-09-18), CRITICAL: the exit code a failed cleanup produces
// must never mask a genuine rehearsal failure (1 always wins), but a clean
// pass whose scratch copy could not be deleted is not actually a clean run -
// production data is still sitting on disk - so that case is escalated to 2
// (environment problem), same as any other cleanup-adjacent failure.
export function finalExitCode(code, cleanupOk) {
  if (code === 1) return 1;
  if (!cleanupOk) return 2;
  return code;
}
