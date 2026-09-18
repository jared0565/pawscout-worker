// scripts/lib/deploy-guards.mjs
//
// Every decision the guarded deploy makes lives here as a pure function, so
// scripts/deploy.mjs stays a thin wrapper that only gathers state (git, gh,
// wrangler, the rehearsal) and prints what these functions decide. Pure
// functions are what scripts/lib/deploy-guards.nodetest.mjs pins, with no
// process spawning in the tests (deploy-safety phase 1, 2026-09-18).

// The staging URL is the one the orchestrator's first staging deploy printed
// (task 7); PAWSCOUT_STAGING_URL still overrides it for a future respin of
// the staging Worker under a different subdomain.
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
      skipCiReason = readFlagValue(argv, i, '--skip-ci', 'a reason describing why CI is being skipped');
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

  return { ok: failures.length === 0, failures };
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
// never a refusal here (found in review, 2026-09-18).
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
// decide the dry run's exit code (fix to a plan defect found in review,
// 2026-09-18). The other three guards (dirty tree, unpushed HEAD, CI) are
// unaffected and still refuse a dry run exactly as they refuse a real run.
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

// Migrations are forward-only (see scripts/deploy.mjs step 8): a rollback
// undoes the CODE, not the schema. This is only ever printed, never run by
// this script, so it goes through npx rather than scripts/lib/run.mjs.
export function rollbackCommand(env) {
  const target = TARGETS[env];
  return target.wranglerEnv ? `npx wrangler rollback -y --env ${target.wranglerEnv}` : 'npx wrangler rollback -y';
}
