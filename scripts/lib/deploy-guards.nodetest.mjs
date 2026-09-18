import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDeployArgs, versionLabel, ciVerdict, evaluateGuards,
  wranglerDeployArgs, migrationsApplyArgs, rollbackCommand, pendingForGuards,
  gitStateProblems
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
