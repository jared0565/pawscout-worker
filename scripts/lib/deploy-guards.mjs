// scripts/lib/deploy-guards.mjs
//
// Every decision the guarded deploy makes lives here as a pure function, so
// scripts/deploy.mjs stays a thin wrapper that only gathers state (git, gh,
// wrangler, the rehearsal) and prints what these functions decide. Pure
// functions are what scripts/lib/deploy-guards.nodetest.mjs pins, with no
// process spawning in the tests.

// The staging URL defaults to the real staging Worker URL from the first
// staging deploy; PAWSCOUT_STAGING_URL overrides it for a future respin
// under a different subdomain. Because `||` treats an empty string as
// unset, this default can never actually be empty, so nothing downstream
// needs to guard against an empty staging URL.
export const TARGETS = {
  production: { url: 'https://pawscout.activepaw.co.uk', database: 'pawscout', wranglerEnv: null },
  staging: { url: process.env.PAWSCOUT_STAGING_URL || 'https://pawscout-worker-staging.bmorris0565.workers.dev', database: 'pawscout-staging', wranglerEnv: 'staging' }
};

const USAGE = 'Usage: node scripts/deploy.mjs --env staging|production [--dry-run] [--skip-ci "<reason>"] [--allow-shrink t1,t2]';

// A flag that takes a value never accepts another flag as that value: a
// missing value is a usage error, not a value that happens to start with two
// hyphens. This is what makes `--skip-ci --dry-run` (the reason left out) a
// clear failure instead of silently swallowing the next flag as the reason.
function readFlagValue(argv, i, flagName, whatItNeeds) {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flagName} needs ${whatItNeeds}. ${USAGE}`);
  }
  return value;
}

export function parseDeployArgs(argv) {
  let env = null;
  let dryRun = false;
  let skipCiReason = null;
  let allowShrink = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--env') {
      env = readFlagValue(argv, i, '--env', 'a value (staging or production)');
      i += 2;
    } else if (arg === '--dry-run') {
      dryRun = true;
      i += 1;
    } else if (arg === '--skip-ci') {
      const reason = readFlagValue(argv, i, '--skip-ci', 'a reason describing why CI is being skipped').trim();
      if (reason.length === 0) {
        throw new Error(`--skip-ci needs a reason describing why CI is being skipped; a blank one is not a reason. ${USAGE}`);
      }
      skipCiReason = reason;
      i += 2;
    } else if (arg === '--allow-shrink') {
      const value = readFlagValue(argv, i, '--allow-shrink', 'a comma-separated list of table names');
      allowShrink = value.split(',');
      i += 2;
    } else {
      throw new Error(`unknown argument "${arg}". ${USAGE}`);
    }
  }
  if (!env) {
    throw new Error(`--env is required. ${USAGE}`);
  }
  if (env !== 'staging' && env !== 'production') {
    throw new Error(`--env must be staging or production, got "${env}". ${USAGE}`);
  }
  return { env, dryRun, skipCiReason, allowShrink };
}

// The version label is the first 12 characters of the commit hash, with
// "-dirty" appended only on a staging deploy from a dirty tree (per the
// global constraint shared with /healthz and the smoke test).
export function versionLabel(sha, dirty) {
  const short = sha.slice(0, 12);
  return dirty ? `${short}-dirty` : short;
}

// Reads the newest CI run for the commit, from
// `gh run list --json status,conclusion --limit 1` (one entry, newest first).
// Unparseable text and an empty list both mean "no CI signal at all", which
// evaluateGuards treats the same as a failing run: production needs an
// explicit --skip-ci reason to proceed past either one.
export function ciVerdict(jsonText) {
  let runs;
  try {
    runs = JSON.parse(jsonText);
  } catch {
    return { state: 'missing', detail: 'missing' };
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return { state: 'missing', detail: 'missing' };
  }
  const run = runs[0] || {};
  const status = run.status ?? 'unknown';
  const conclusion = run.conclusion ?? 'null';
  const detail = `${status}/${conclusion}`;
  if (status === 'completed') {
    return { state: conclusion === 'success' ? 'success' : 'failure', detail };
  }
  return { state: 'pending', detail };
}

// The single place that decides whether a deploy may proceed. Staging is a
// disposable environment used to rehearse the production guards themselves,
// so it is never refused here; every other check below applies to production
// only. Every failing guard is collected and reported together, not just the
// first, so one run tells the operator everything that needs fixing.
export function evaluateGuards(state) {
  if (state.env !== 'production') {
    return { ok: true, failures: [] };
  }

  const failures = [];

  if (state.dirty.length > 0) {
    failures.push(
      `The working tree is not clean. Commit or discard these files before deploying to production: ${state.dirty.join(', ')}`
    );
  }

  const blockingUntrackedFiles = state.blockingUntracked || [];
  if (blockingUntrackedFiles.length > 0) {
    failures.push(
      `Untracked files that a deploy would ship or apply: ${blockingUntrackedFiles.join(', ')}. Commit them (git add) or remove them: a migration or source file that is in no commit must never reach production.`
    );
  }

  if (state.upstreamHead !== state.head) {
    failures.push(
      `HEAD (${state.head}) does not match origin/master (${state.upstreamHead}). Push your commit before deploying to production.`
    );
  }

  if (state.ci.state !== 'success' && !state.skipCiReason) {
    failures.push(
      `CI is not green for this commit (${state.ci.detail}). Wait for it to pass, or pass --skip-ci "<reason>" to override.`
    );
  }

  if (state.pending.length > 0 && state.rehearsalOk !== true) {
    failures.push(
      `There are pending migrations with no passing rehearsal: ${state.pending.join(', ')}. Run the migration rehearsal before deploying to production.`
    );
  }

  const missingOnStaging = state.missingOnStaging || [];
  if (missingOnStaging.length > 0) {
    failures.push(
      `These pending migrations have not been applied to staging yet: ${missingOnStaging.join(', ')}. Deploy to staging first (npm run deploy -- --env staging): staging is the only place that proves real D1 accepts the SQL.`
    );
  }

  return { ok: failures.length === 0, failures };
}

// The migration rehearsal was rebuilt on Node's built-in SQLite (2026-09-18):
// it proves "production's data survives this SQL" but no longer touches D1
// at all, so it can no longer prove "real D1 accepts this SQL". The only
// thing left that proves that is staging having already taken the same
// migration. This is the entries of `pending` that staging has not yet
// applied, in `pending`'s own order; a name staging has that production does
// not need is not this function's concern and is ignored.
export function missingOnStaging(pending, stagingApplied) {
  const applied = new Set(stagingApplied);
  return pending.filter((name) => !applied.has(name));
}

// git quotes a path that needs escaping (a space, in this repo's usage) in
// double quotes with C-style backslash escapes, and can print a
// backslash-separated path on Windows from some codepaths. Both are
// normalised to a plain forward-slash path so a prefix check against it is
// a plain string comparison.
function normalizeGitPath(rawPath) {
  let path = rawPath;
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return path.replace(/\\/g, '/');
}

// Turns `git status --porcelain` output into the two things the guards
// need: `dirty`, the tracked-change lines exactly as printed (a rename
// keeps its "old -> new" form; the dirty-tree guard's message names these
// lines verbatim), and `untracked`, the plain PATHS of the `??` lines. CRLF
// tolerant: a trailing \r from a Windows git is stripped from every line
// before it is classified.
export function parsePorcelain(stdout) {
  const lines = stdout.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0);
  const dirty = [];
  const untracked = [];
  for (const line of lines) {
    if (line.startsWith('??')) {
      untracked.push(normalizeGitPath(line.slice(3)));
    } else {
      dirty.push(line);
    }
  }
  return { dirty, untracked };
}

// The untracked entries of `parsePorcelain`'s output that a deploy would
// ship (a migration file) or apply (source under src/). git collapses a
// wholly untracked directory into one line ending in `/` (for example
// `src/newdir/`); this prefix check still catches that. Every other
// untracked path (an image, a doc, a long-standing untracked stray) is
// ignored, exactly as before this guard existed.
export function blockingUntracked(untracked) {
  return untracked.filter((path) => path.startsWith('migrations/') || path.startsWith('src/'));
}

// The subset of `pending` (migration file basenames) that the working tree
// shows as untracked or modified. `missingOnStaging` proves a NAME reached
// staging, not that the SQL staging validated is the SQL that will later
// reach production, since staging deploys from a dirty tree; this is the
// cheap half of that same finding. A tracked change is matched
// on the CHANGED path only: a porcelain rename line prints "old -> new",
// and only the new path is what is about to be applied. An untracked match
// is either the exact path or a collapsed untracked directory (a `??` line
// ending in `/`) that the path falls under.
export function untrackedOrModifiedPending(pending, dirty, untracked) {
  return pending.filter((name) => {
    const relPath = `migrations/${name}`;
    const isUntracked = untracked.some((path) => path === relPath || (path.endsWith('/') && relPath.startsWith(path)));
    if (isUntracked) return true;
    return dirty.some((line) => {
      const pathPart = line.slice(3);
      const changedPath = pathPart.includes(' -> ') ? pathPart.split(' -> ').pop() : pathPart;
      return changedPath === relPath;
    });
  });
}

const SHA_HEX = /^[0-9a-f]{40}$/i;

// A state that could not be READ cannot be EVALUATED: `run()` in
// scripts/lib/run.mjs never throws, so a failed `git status`, `git rev-parse
// HEAD` or `git rev-parse origin/master` silently hands back an empty
// string, and an empty-string comparison can accidentally read as "clean"
// or "pushed". This checks the four raw `{ status, stdout, stderr }` results
// from those calls (plus the `git fetch` that primes origin/master) and
// returns REFUSAL sentences for anything that could not actually be read,
// BEFORE any guard runs, rather than letting evaluateGuards judge string
// comparisons against garbage. A failed `git fetch` is a hard refusal only
// for production: a stale origin/master that happens to already equal HEAD
// is exactly the failure the production push guard exists to catch. Staging
// has no push guard, so a failed fetch there is a wrapper-printed warning,
// never a refusal here.
export function gitStateProblems({ env, fetch, status, head, upstream }) {
  const problems = [];

  if (status.status !== 0) {
    problems.push(`git status --porcelain failed (exit ${status.status}): ${status.stderr || status.stdout || 'no output'}`);
  }

  if (head.status !== 0) {
    problems.push(`git rev-parse HEAD failed (exit ${head.status}): ${head.stderr || head.stdout || 'no output'}`);
  } else if (!SHA_HEX.test(head.stdout.trim())) {
    problems.push(`git rev-parse HEAD did not return a commit hash: "${head.stdout.trim()}"`);
  }

  if (upstream.status !== 0) {
    problems.push(`git rev-parse origin/master failed (exit ${upstream.status}): ${upstream.stderr || upstream.stdout || 'no output'}`);
  } else if (!SHA_HEX.test(upstream.stdout.trim())) {
    problems.push(`git rev-parse origin/master did not return a commit hash: "${upstream.stdout.trim()}"`);
  }

  if (fetch.status !== 0 && env === 'production') {
    problems.push(
      `git fetch origin master failed (exit ${fetch.status}): ${fetch.stderr || fetch.stdout || 'no output'}. ` +
      'A stale origin/master that happens to equal HEAD is exactly what the push guard exists to catch, so production refuses until the fetch succeeds.'
    );
  }

  return problems;
}

// A dry run cannot rehearse anything (rehearsalOk always stays null), so
// feeding evaluateGuards the real pending list would make the pending-
// migrations guard refuse every dry run that has pending migrations, and
// the dry-run plan (which is meant to show those migrations) would never
// print. The pending-migrations guard is DEFERRED on a dry run, not passed
// and not failed: the wrapper prints the real list and a note that the
// rehearsal would run on the real deploy, but does not let this guard alone
// decide the dry run's exit code. Every other guard (dirty tree, untracked
// files, unpushed HEAD, CI, and migrations already proven on staging) is a
// cheap read, unaffected by this, and still refuses a dry run exactly as it
// refuses a real run.
export function pendingForGuards(pending, dryRun) {
  return dryRun ? [] : pending;
}

// `deploy --var GIT_SHA:<label>` stamps the running Worker with the version
// label that /healthz and the smoke test both read, so all three agree on
// what "this deploy" means without a separate round trip to read it back.
export function wranglerDeployArgs(env, label) {
  const args = ['deploy'];
  if (TARGETS[env].wranglerEnv) args.push('--env', TARGETS[env].wranglerEnv);
  args.push('--var', `GIT_SHA:${label}`);
  return args;
}

export function migrationsApplyArgs(env) {
  const target = TARGETS[env];
  const args = ['d1', 'migrations', 'apply', target.database, '--remote'];
  if (target.wranglerEnv) args.push('--env', target.wranglerEnv);
  return args;
}

// Migrations are forward-only: a rollback undoes the CODE, not the schema.
// This is only ever printed, never run by this script, so it goes through
// npx rather than scripts/lib/run.mjs.
export function rollbackCommand(env) {
  const target = TARGETS[env];
  return target.wranglerEnv ? `npx wrangler rollback -y --env ${target.wranglerEnv}` : 'npx wrangler rollback -y';
}

// wrangler applies and records migration files one at a time, so a failed
// apply with more than one file pending can leave the earlier ones already
// applied. This is the command that shows the truth, printed rather than
// run: `npx wrangler d1 migrations list <database> --remote[ --env <name>]`.
export function migrationsListCommand(env) {
  const target = TARGETS[env];
  const suffix = target.wranglerEnv ? ` --env ${target.wranglerEnv}` : '';
  return `npx wrangler d1 migrations list ${target.database} --remote${suffix}`;
}

// A missing `d1_migrations` table is legitimate only for a database that has
// never taken a migration yet, which in this script only ever happens on a
// fresh staging database. The same error against production means
// production's own migrations table is gone, which is never a state to
// silently read as "nothing applied". The caller passes whether the
// database it just read IS staging, not which environment this run targets:
// production's own missingOnStaging read of staging's table is still
// staging's table, even on a production run.
export function tolerateMissingMigrationsTable(databaseIsStaging, errorMessage) {
  return databaseIsStaging && /no such table/i.test(errorMessage);
}

// Every D1 read in this script fails this same way: a raw stack trace tells
// the operator nothing they can act on, and this exact class of failure has
// already happened live and cleared itself on a retry - the Cloudflare API
// answered "The given account is not valid or is not authorized to access
// this service" once, and the same read worked 60 seconds later (twice on
// 2026-09-18).
export function d1ReadRefusalLines(reason) {
  return [
    'REFUSED:',
    `  ${reason}`,
    '  The Cloudflare API has been seen to refuse a D1 read transiently (twice on 2026-09-18); run this again, and check `npx wrangler whoami` if it repeats.'
  ];
}
