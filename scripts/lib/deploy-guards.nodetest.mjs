import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDeployArgs, versionLabel, ciVerdict, evaluateGuards,
  wranglerDeployArgs, migrationsApplyArgs, rollbackCommand, pendingForGuards,
  gitStateProblems, missingOnStaging, parsePorcelain, blockingUntracked,
  untrackedOrModifiedPending, tolerateMissingMigrationsTable,
  migrationsListCommand, d1ReadRefusalLines
} from './deploy-guards.mjs';

const SHA = 'abc123def4567890abc123def4567890abc123de';
const clean = {
  env: 'production', dirty: [], head: SHA, upstreamHead: SHA,
  ci: { state: 'success', detail: 'completed/success' }, skipCiReason: null,
  pending: [], rehearsalOk: null
};

test('args: --env is required and must be staging or production', () => {
  assert.throws(() => parseDeployArgs([]), /--env/);
  assert.throws(() => parseDeployArgs(['--env', 'prod']), /staging|production/);
  assert.deepEqual(parseDeployArgs(['--env', 'staging']), { env: 'staging', dryRun: false, skipCiReason: null, allowShrink: [] });
  assert.deepEqual(
    parseDeployArgs(['--env', 'production', '--dry-run', '--skip-ci', 'GitHub is down', '--allow-shrink', 'a,b']),
    { env: 'production', dryRun: true, skipCiReason: 'GitHub is down', allowShrink: ['a', 'b'] }
  );
  assert.throws(() => parseDeployArgs(['--env', 'production', '--skip-ci']), /reason/i);
  assert.throws(() => parseDeployArgs(['--env', 'production', '--skip-ci', '--dry-run']), /reason/i);
  assert.throws(() => parseDeployArgs(['--env', 'staging', '--nope']), /unknown/i);
});

test('version label is 12 characters, marked dirty only when asked', () => {
  assert.equal(versionLabel(SHA, false), 'abc123def456');
  assert.equal(versionLabel(SHA, true), 'abc123def456-dirty');
});

test('ci verdict reads the newest run for the commit', () => {
  assert.deepEqual(ciVerdict('[{"status":"completed","conclusion":"success"}]'), { state: 'success', detail: 'completed/success' });
  assert.equal(ciVerdict('[{"status":"completed","conclusion":"failure"}]').state, 'failure');
  assert.equal(ciVerdict('[{"status":"in_progress","conclusion":null}]').state, 'pending');
  assert.equal(ciVerdict('[]').state, 'missing');
  assert.equal(ciVerdict('not json').state, 'missing');
});

test('a clean, pushed, green commit with no pending migrations may deploy to production', () => {
  assert.deepEqual(evaluateGuards(clean), { ok: true, failures: [] });
});

test('production refuses a dirty tree, and names the files', () => {
  const r = evaluateGuards({ ...clean, dirty: [' M src/index.ts'] });
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /src\/index\.ts/);
});

test('production refuses a commit that is not what origin/master points to', () => {
  const r = evaluateGuards({ ...clean, upstreamHead: 'f'.repeat(40) });
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /push/i);
});

test('production refuses anything but green CI, unless a reason to skip was given', () => {
  for (const state of ['failure', 'pending', 'missing']) {
    assert.equal(evaluateGuards({ ...clean, ci: { state, detail: state } }).ok, false, state);
  }
  assert.equal(evaluateGuards({ ...clean, ci: { state: 'missing', detail: 'missing' }, skipCiReason: 'GitHub is down' }).ok, true);
});

test('production refuses pending migrations without a passing rehearsal', () => {
  assert.equal(evaluateGuards({ ...clean, pending: ['0041_x.sql'], rehearsalOk: null }).ok, false);
  assert.equal(evaluateGuards({ ...clean, pending: ['0041_x.sql'], rehearsalOk: false }).ok, false);
  assert.equal(evaluateGuards({ ...clean, pending: ['0041_x.sql'], rehearsalOk: true }).ok, true);
});

test('every failing guard is reported, not only the first', () => {
  const r = evaluateGuards({ ...clean, dirty: [' M a'], upstreamHead: 'f'.repeat(40), ci: { state: 'failure', detail: 'x' } });
  assert.equal(r.failures.length, 3);
});

test('staging is never refused', () => {
  const r = evaluateGuards({ ...clean, env: 'staging', dirty: [' M a'], upstreamHead: 'f'.repeat(40), ci: { state: 'missing', detail: 'x' }, pending: ['0041_x.sql'] });
  assert.deepEqual(r, { ok: true, failures: [] });
});

test('wrangler arguments name the environment every time', () => {
  assert.deepEqual(wranglerDeployArgs('production', 'abc123def456'), ['deploy', '--var', 'GIT_SHA:abc123def456']);
  assert.deepEqual(wranglerDeployArgs('staging', 'abc123def456'), ['deploy', '--env', 'staging', '--var', 'GIT_SHA:abc123def456']);
  assert.deepEqual(migrationsApplyArgs('production'), ['d1', 'migrations', 'apply', 'pawscout', '--remote']);
  assert.deepEqual(migrationsApplyArgs('staging'), ['d1', 'migrations', 'apply', 'pawscout-staging', '--remote', '--env', 'staging']);
  assert.equal(rollbackCommand('production'), 'npx wrangler rollback -y');
  assert.equal(rollbackCommand('staging'), 'npx wrangler rollback -y --env staging');
});

test('a dry run defers the pending-migrations guard to a later real run', () => {
  assert.deepEqual(pendingForGuards(['0041_x.sql'], true), []);
  assert.deepEqual(pendingForGuards(['0041_x.sql'], false), ['0041_x.sql']);
  assert.deepEqual(pendingForGuards([], true), []);
  assert.deepEqual(pendingForGuards([], false), []);
});

const goodRead = { status: 0, stdout: `${SHA}\n`, stderr: '' };
const goodStatus = { status: 0, stdout: '', stderr: '' };
const failedRead = { status: 1, stdout: '', stderr: 'fatal: not a git repository' };

test('gitStateProblems: four good reads is no problem', () => {
  assert.deepEqual(
    gitStateProblems({ env: 'production', fetch: goodStatus, status: goodStatus, head: goodRead, upstream: goodRead }),
    []
  );
});

test('gitStateProblems: each of the three reads failing alone is refused', () => {
  assert.equal(gitStateProblems({ env: 'production', fetch: goodStatus, status: failedRead, head: goodRead, upstream: goodRead }).length, 1);
  assert.equal(gitStateProblems({ env: 'production', fetch: goodStatus, status: goodStatus, head: failedRead, upstream: goodRead }).length, 1);
  assert.equal(gitStateProblems({ env: 'production', fetch: goodStatus, status: goodStatus, head: goodRead, upstream: failedRead }).length, 1);
});

test('gitStateProblems: HEAD with exit 0 but empty or non-hex output is refused', () => {
  const empty = { status: 0, stdout: '', stderr: '' };
  const notHex = { status: 0, stdout: 'error: detected dubious ownership\n', stderr: '' };
  assert.equal(gitStateProblems({ env: 'production', fetch: goodStatus, status: goodStatus, head: empty, upstream: goodRead }).length, 1);
  assert.equal(gitStateProblems({ env: 'production', fetch: goodStatus, status: goodStatus, head: notHex, upstream: goodRead }).length, 1);
});

test('gitStateProblems: origin/master with exit 0 but empty or non-hex output is refused too', () => {
  const empty = { status: 0, stdout: '', stderr: '' };
  const notHex = { status: 0, stdout: 'error: detected dubious ownership\n', stderr: '' };
  assert.equal(gitStateProblems({ env: 'production', fetch: goodStatus, status: goodStatus, head: goodRead, upstream: empty }).length, 1);
  assert.equal(gitStateProblems({ env: 'production', fetch: goodStatus, status: goodStatus, head: goodRead, upstream: notHex }).length, 1);
});

test('gitStateProblems: a failed fetch refuses production but not staging', () => {
  const badFetch = { status: 128, stdout: '', stderr: 'fatal: unable to access origin' };
  assert.equal(gitStateProblems({ env: 'production', fetch: badFetch, status: goodStatus, head: goodRead, upstream: goodRead }).length, 1);
  assert.deepEqual(
    gitStateProblems({ env: 'staging', fetch: badFetch, status: goodStatus, head: goodRead, upstream: goodRead }),
    []
  );
});

test('gitStateProblems: two failures at once are both reported', () => {
  const notHex = { status: 0, stdout: 'error: detected dubious ownership\n', stderr: '' };
  const problems = gitStateProblems({ env: 'production', fetch: goodStatus, status: failedRead, head: notHex, upstream: goodRead });
  assert.equal(problems.length, 2);
});

test('missingOnStaging: nothing pending, all applied, some missing in order, staging extras ignored', () => {
  assert.deepEqual(missingOnStaging([], ['0001_init.sql']), []);
  assert.deepEqual(missingOnStaging(['0001_init.sql', '0002_x.sql'], ['0001_init.sql', '0002_x.sql']), []);
  assert.deepEqual(
    missingOnStaging(['0001_init.sql', '0002_x.sql', '0003_y.sql'], ['0001_init.sql']),
    ['0002_x.sql', '0003_y.sql']
  );
  assert.deepEqual(missingOnStaging(['0001_init.sql'], ['0001_init.sql', '0099_staging_only.sql']), []);
});

test('production refuses when pending migrations have not reached staging first', () => {
  const r = evaluateGuards({ ...clean, pending: ['0041_x.sql'], rehearsalOk: true, missingOnStaging: ['0041_x.sql'] });
  assert.equal(r.ok, false);
  assert.equal(
    r.failures[0],
    'These pending migrations have not been applied to staging yet: 0041_x.sql. Deploy to staging first (npm run deploy -- --env staging): staging is the only place that proves real D1 accepts the SQL.'
  );
});

test('staging never evaluates the staging-first guard', () => {
  const r = evaluateGuards({ ...clean, env: 'staging', missingOnStaging: ['0041_x.sql'] });
  assert.deepEqual(r, { ok: true, failures: [] });
});

test('the staging-first guard is not deferred on a dry run, unlike the rehearsal guard', () => {
  const r = evaluateGuards({
    ...clean,
    pending: pendingForGuards(['0041_x.sql'], true),
    rehearsalOk: null,
    missingOnStaging: ['0041_x.sql']
  });
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /have not been applied to staging yet/);
});

test('failures accumulate: dirty tree and missing on staging are both reported', () => {
  const r = evaluateGuards({ ...clean, dirty: [' M a'], missingOnStaging: ['0041_x.sql'] });
  assert.equal(r.failures.length, 2);
});

test('phase one (before any rehearsal runs): passes with the pending guard deferred and missingOnStaging clear', () => {
  const r = evaluateGuards({
    ...clean,
    pending: pendingForGuards(['0041_x.sql'], true),
    rehearsalOk: null,
    missingOnStaging: []
  });
  assert.deepEqual(r, { ok: true, failures: [] });
});

test('phase two (after a real rehearsal ran): refuses when the rehearsal failed', () => {
  const r = evaluateGuards({
    ...clean,
    pending: ['0041_x.sql'],
    rehearsalOk: false,
    missingOnStaging: []
  });
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /no passing rehearsal/);
});

test('args: --skip-ci trims its reason and refuses a blank one', () => {
  assert.equal(parseDeployArgs(['--env', 'production', '--skip-ci', '  GitHub is down  ']).skipCiReason, 'GitHub is down');
  assert.throws(() => parseDeployArgs(['--env', 'production', '--skip-ci', '   ']), /reason/i);
});

test('parsePorcelain: splits dirty (tracked-change) lines from untracked paths, CRLF tolerant', () => {
  const stdout = ' M src/index.ts\r\n?? migrations/0041_x.sql\r\nA  src/health.ts\r\n?? cart-summary.png\r\n';
  assert.deepEqual(parsePorcelain(stdout), {
    dirty: [' M src/index.ts', 'A  src/health.ts'],
    untracked: ['migrations/0041_x.sql', 'cart-summary.png']
  });
});

test('parsePorcelain: strips git quoting from a path and normalises backslashes', () => {
  const stdout = '?? "migrations/0041 has space.sql"\n?? src\\newdir\\file.ts\n';
  assert.deepEqual(parsePorcelain(stdout).untracked, ['migrations/0041 has space.sql', 'src/newdir/file.ts']);
});

test('blockingUntracked: untracked migrations/ and src/ paths block; everything else is ignored', () => {
  const untracked = ['migrations/0041_x.sql', 'src/health.ts', 'cart-summary.png', 'docs/RUNBOOK-DEPLOY.md', 'src/newdir/'];
  assert.deepEqual(blockingUntracked(untracked), ['migrations/0041_x.sql', 'src/health.ts', 'src/newdir/']);
});

test('blockingUntracked: a path that merely STARTS LIKE migrations or src does not block', () => {
  // Pins the rule as a directory prefix ("src/"), not a substring: a refactor
  // to includes() or startsWith('src') would start refusing these.
  assert.deepEqual(blockingUntracked(['migrations.bak/0041_x.sql', 'src-old/x.ts', 'docs/src/x.ts', 'notes/migrations/x.sql']), []);
});

test('blockingUntracked: nothing untracked is nothing blocking', () => {
  assert.deepEqual(blockingUntracked([]), []);
});

test('production refuses on an untracked migration or source file', () => {
  const r = evaluateGuards({ ...clean, blockingUntracked: ['migrations/0041_x.sql'] });
  assert.equal(r.ok, false);
  assert.equal(
    r.failures[0],
    'Untracked files that a deploy would ship or apply: migrations/0041_x.sql. Commit them (git add) or remove them: a migration or source file that is in no commit must never reach production.'
  );
});

test('staging never evaluates the untracked-files guard', () => {
  const r = evaluateGuards({ ...clean, env: 'staging', blockingUntracked: ['migrations/0041_x.sql'] });
  assert.deepEqual(r, { ok: true, failures: [] });
});

test('the untracked-files guard is not deferred on a dry run', () => {
  const r = evaluateGuards({
    ...clean,
    pending: pendingForGuards(['0041_x.sql'], true),
    rehearsalOk: null,
    blockingUntracked: ['migrations/0041_x.sql']
  });
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /Untracked files/);
});

test('untrackedOrModifiedPending: names pending migrations that are modified (by rename target) or untracked', () => {
  const dirty = ['R  migrations/0039_old_name.sql -> migrations/0040_x.sql'];
  const untracked = ['migrations/0041_y.sql'];
  assert.deepEqual(
    untrackedOrModifiedPending(['0040_x.sql', '0041_y.sql', '0042_z.sql'], dirty, untracked),
    ['0040_x.sql', '0041_y.sql']
  );
  assert.deepEqual(untrackedOrModifiedPending(['0042_z.sql'], dirty, untracked), []);
});

test('untrackedOrModifiedPending: a rename AWAY from a pending path is not a false match', () => {
  const dirty = ['R  migrations/0040_x.sql -> migrations/0040_x_renamed.sql'];
  assert.deepEqual(untrackedOrModifiedPending(['0040_x.sql'], dirty, []), []);
});

test('untrackedOrModifiedPending: a wholly untracked migrations directory catches every pending file inside it', () => {
  assert.deepEqual(
    untrackedOrModifiedPending(['0041_y.sql', '0042_z.sql'], [], ['migrations/']),
    ['0041_y.sql', '0042_z.sql']
  );
});

test('tolerateMissingMigrationsTable: a missing table is only ever legitimate on the staging database', () => {
  assert.equal(tolerateMissingMigrationsTable(true, 'D1_ERROR: no such table: d1_migrations'), true);
  assert.equal(tolerateMissingMigrationsTable(false, 'no such table: d1_migrations'), false);
  assert.equal(tolerateMissingMigrationsTable(true, 'auth error'), false);
});

test('migrationsListCommand: shows the truth after a failed apply', () => {
  assert.equal(migrationsListCommand('production'), 'npx wrangler d1 migrations list pawscout --remote');
  assert.equal(migrationsListCommand('staging'), 'npx wrangler d1 migrations list pawscout-staging --remote --env staging');
});

test('d1ReadRefusalLines: names the reason and the known transient-failure advice', () => {
  const lines = d1ReadRefusalLines('Could not read applied migrations for pawscout (auth error).');
  assert.equal(lines[0], 'REFUSED:');
  assert.match(lines[1], /Could not read applied migrations for pawscout/);
  assert.match(lines[2], /transiently/);
});
