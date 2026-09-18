// scripts/lib/smoke-checks.mjs
//
// Post-deploy smoke test, pure decision layer (deploy-safety phase, 2026-09-18).
//
// These functions take an already-fetched status, body and content type and
// decide pass or fail. The HTTP fetching, retry loop and process exit code
// live in scripts/smoke.mjs; keeping the decisions here, free of fetch and
// timers, is what makes them runnable directly under node:test with no
// network and no fake server.
export function checkHealthz(status, body, expectVersion) {
  if (status !== 200 || !body || body.ok !== true || body.db !== true) {
    return { name: 'healthz', ok: false, detail: `status ${status}, body ${JSON.stringify(body)}` };
  }
  if (expectVersion && body.version !== expectVersion) {
    return {
      name: 'healthz',
      ok: false,
      detail: `expected version ${expectVersion}, deployed version is ${body.version}`
    };
  }
  return { name: 'healthz', ok: true, detail: `env ${body.env}, version ${body.version}` };
}

// A 503 with { error: 'unavailable' } is the answer from a Worker with no
// connected shop, which is what staging is before a store is attached. On
// production the same answer means the route is actually down, so it only
// passes when the caller explicitly allows it.
export function checkPublicEvent(status, body, allowUnavailable) {
  if (status === 503 && body && body.error === 'unavailable') {
    return allowUnavailable
      ? { name: 'public-event', ok: true, detail: 'unavailable and allowed on this target' }
      : { name: 'public-event', ok: false, detail: 'unavailable, and this target does not allow it' };
  }
  if (status === 200 && body && typeof body.active === 'boolean') {
    return { name: 'public-event', ok: true, detail: `active ${body.active}` };
  }
  return { name: 'public-event', ok: false, detail: `status ${status}, body ${JSON.stringify(body)}` };
}

export function checkApp(status, contentType) {
  const ok = status === 200 && typeof contentType === 'string' && /text\/html/i.test(contentType);
  return { name: 'app', ok, detail: `status ${status}, content-type ${contentType}` };
}

// A flag that takes a value must have one: end of the argument list, or the
// next token itself starting with '--', is a missing value, not an empty or
// absent one. Left unchecked, "--expect-version" as the last token silently
// became null and skipped the one check it was there to enforce.
function takeValue(flag, args) {
  if (args.length === 0 || /^--/.test(String(args[0]))) {
    throw new Error(`${flag} requires a value`);
  }
  return args.shift();
}

export function parseSmokeArgs(argv) {
  const args = [...argv];
  const baseUrlRaw = args.shift();
  if (!baseUrlRaw) {
    throw new Error('base url is required');
  }
  if (!/^https?:\/\//i.test(baseUrlRaw)) {
    throw new Error(`base url must start with http:// or https://, got ${baseUrlRaw}`);
  }

  const result = {
    baseUrl: baseUrlRaw.replace(/\/+$/, ''),
    expectVersion: null,
    allowUnavailable: false,
    attempts: 12,
    delayMs: 5000
  };

  while (args.length > 0) {
    const flag = args.shift();
    switch (flag) {
      case '--expect-version':
        result.expectVersion = takeValue(flag, args);
        break;
      case '--allow-unavailable':
        result.allowUnavailable = true;
        break;
      case '--attempts': {
        const n = Number(takeValue(flag, args));
        if (!Number.isInteger(n) || n < 1) {
          throw new Error('attempts must be an integer of at least 1');
        }
        result.attempts = n;
        break;
      }
      case '--delay-ms': {
        const n = Number(takeValue(flag, args));
        if (!Number.isInteger(n) || n < 0) {
          throw new Error('delay-ms must be an integer of at least 0');
        }
        result.delayMs = n;
        break;
      }
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }

  return result;
}

export function allPassed(results) {
  return Array.isArray(results) && results.length > 0 && results.every((r) => r.ok === true);
}
