import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealthz, checkPublicEvent, checkApp, parseSmokeArgs, allPassed } from './smoke-checks.mjs';

const healthy = { ok: true, env: 'staging', version: 'abc123def456', db: true };

test('healthz passes on a healthy body and reports env and version', () => {
  const r = checkHealthz(200, healthy, 'abc123def456');
  assert.equal(r.ok, true);
  assert.match(r.detail, /staging/);
  assert.match(r.detail, /abc123def456/);
});

test('healthz fails when the deployed version is not the expected one', () => {
  const r = checkHealthz(200, healthy, 'ffffffffffff');
  assert.equal(r.ok, false);
  assert.match(r.detail, /abc123def456/);
  assert.match(r.detail, /ffffffffffff/);
});

test('healthz passes without an expected version', () => {
  assert.equal(checkHealthz(200, healthy, null).ok, true);
});

test('healthz fails on a non-200, a false ok, a false db, and a missing body', () => {
  assert.equal(checkHealthz(503, { ...healthy, ok: false, db: false }, null).ok, false);
  assert.equal(checkHealthz(200, { ...healthy, ok: false }, null).ok, false);
  assert.equal(checkHealthz(200, { ...healthy, db: false }, null).ok, false);
  assert.equal(checkHealthz(200, null, null).ok, false);
});

test('public event passes on a boolean active', () => {
  assert.equal(checkPublicEvent(200, { active: false }, false).ok, true);
  assert.equal(checkPublicEvent(200, { active: true, code: 'X' }, false).ok, true);
});

test('public event fails when active is not a boolean', () => {
  assert.equal(checkPublicEvent(200, { active: 'no' }, false).ok, false);
  assert.equal(checkPublicEvent(200, null, false).ok, false);
});

test('503 unavailable fails on production and passes only when explicitly allowed', () => {
  assert.equal(checkPublicEvent(503, { error: 'unavailable' }, false).ok, false);
  assert.equal(checkPublicEvent(503, { error: 'unavailable' }, true).ok, true);
  assert.equal(checkPublicEvent(503, { error: 'boom' }, true).ok, false);
  assert.equal(checkPublicEvent(500, { error: 'unavailable' }, true).ok, false);
});

test('app passes only on 200 html', () => {
  assert.equal(checkApp(200, 'text/html; charset=UTF-8').ok, true);
  assert.equal(checkApp(200, 'application/json').ok, false);
  assert.equal(checkApp(500, 'text/html').ok, false);
  assert.equal(checkApp(200, null).ok, false);
});

test('args: base url is required, trailing slash is dropped, flags are read', () => {
  assert.throws(() => parseSmokeArgs([]), /base url/i);
  assert.throws(() => parseSmokeArgs(['ftp://x']), /http/i);
  assert.deepEqual(parseSmokeArgs(['https://x.example/']), {
    baseUrl: 'https://x.example', expectVersion: null, allowUnavailable: false, attempts: 12, delayMs: 5000
  });
  assert.deepEqual(
    parseSmokeArgs(['https://x.example', '--expect-version', 'abc123def456', '--allow-unavailable', '--attempts', '3', '--delay-ms', '10']),
    { baseUrl: 'https://x.example', expectVersion: 'abc123def456', allowUnavailable: true, attempts: 3, delayMs: 10 }
  );
  assert.throws(() => parseSmokeArgs(['https://x.example', '--nope']), /unknown/i);
  assert.throws(() => parseSmokeArgs(['https://x.example', '--attempts', '0']), /attempts/i);
});

test('allPassed is true only when every result is ok and there is at least one', () => {
  assert.equal(allPassed([{ ok: true }, { ok: true }]), true);
  assert.equal(allPassed([{ ok: true }, { ok: false }]), false);
  assert.equal(allPassed([]), false);
});
