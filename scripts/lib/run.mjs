// scripts/lib/run.mjs
//
// The ONE place the deploy-safety scripts start other programs. Every call is
// an argument ARRAY with no shell, so nothing a script builds is ever parsed by
// cmd.exe or sh. wrangler is started through node and its own entry file for
// the same reason: `npx` is a .cmd on Windows and would need a shell.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return {
    status: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? String(r.error) : '')
  };
}

export const runWrangler = (args, opts) => run(process.execPath, [WRANGLER, ...args], opts);
export const runGit = (args) => run('git', args);
export const runGh = (args) => run('gh', args);
export const runNode = (script, args, opts) => run(process.execPath, [path.join(ROOT, script), ...args], opts);

// Rows of ONE SQL statement. wrangler --json prints an array with one entry per
// statement on success and an { error } object on failure; both are handled
// here so no caller ever reads a failure as "zero rows".
//
// The `persistTo` option (wrangler's --local scratch DB path) was removed
// 2026-09-18, fix round 2: the migration rehearsal was the only caller that
// passed it, and it now loads dumps into node:sqlite directly instead of a
// wrangler --local database (which could not ingest a real 15.5 MB dump -
// see scripts/lib/rehearsal-db.mjs). No caller passes `remote: false` any
// more either, but that option is untouched here: this edit is scoped to
// the one dead option, not a broader cleanup of this shared file.
export function d1Rows(database, sql, { remote = true, envName = null } = {}) {
  const args = ['d1', 'execute', database, remote ? '--remote' : '--local', '--json', '--command', sql];
  if (envName) args.push('--env', envName);
  const r = runWrangler(args);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`d1 query gave no JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 400)}`);
  }
  if (!Array.isArray(parsed)) {
    const notes = (parsed?.error?.notes || []).map((n) => n.text).join('; ');
    throw new Error(`d1 query failed: ${parsed?.error?.text || 'unknown error'} ${notes}`.trim());
  }
  return parsed[0]?.results || [];
}
