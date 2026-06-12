import { describe, it, expect } from 'vitest';
import { relayedFetch, cjFetchFromEnv, CjClient } from '../src/cj';

const RELAY = { url: 'https://pawscout-relay.fly.dev/', token: 'sekrit' };

function capture(): { calls: { url: string; headers: Headers }[]; fetchImpl: typeof fetch } {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({ result: true, data: { list: [] } }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('relayedFetch', () => {
  it('rewrites CJ origins to the relay and injects the token', async () => {
    const { calls, fetchImpl } = capture();
    const f = relayedFetch(RELAY, fetchImpl);
    await f('https://developers.cjdropshipping.com/api2.0/v1/product/list?q=x', { headers: { 'CJ-Access-Token': 't' } });
    expect(calls[0].url).toBe('https://pawscout-relay.fly.dev/cj/api2.0/v1/product/list?q=x');
    expect(calls[0].headers.get('X-Relay-Token')).toBe('sekrit');
    expect(calls[0].headers.get('CJ-Access-Token')).toBe('t'); // original headers preserved
  });

  it('passes non-CJ URLs through untouched', async () => {
    const { calls, fetchImpl } = capture();
    const f = relayedFetch(RELAY, fetchImpl);
    await f('https://example.myshopify.com/admin/api/graphql.json');
    expect(calls[0].url).toBe('https://example.myshopify.com/admin/api/graphql.json');
    expect(calls[0].headers.get('X-Relay-Token')).toBeNull();
  });

  it('CjClient calls flow through the relay end to end', async () => {
    const { calls, fetchImpl } = capture();
    const cj = new CjClient(async () => 'tok', relayedFetch(RELAY, fetchImpl));
    await cj.search('dog');
    expect(calls[0].url).toContain('https://pawscout-relay.fly.dev/cj/api2.0/v1/product/list');
    expect(calls[0].headers.get('X-Relay-Token')).toBe('sekrit');
    expect(calls[0].headers.get('CJ-Access-Token')).toBe('tok');
  });
});

describe('cjFetchFromEnv', () => {
  it('returns a relayed fetch only when both settings are present', () => {
    // No relay configured: must be the plain default (no rewrite logic).
    const direct = cjFetchFromEnv({});
    const relayed = cjFetchFromEnv({ CJ_RELAY_URL: RELAY.url, CJ_RELAY_TOKEN: RELAY.token });
    const half = cjFetchFromEnv({ CJ_RELAY_URL: RELAY.url });
    expect(direct).not.toBe(relayed);
    expect(half).toBe(direct); // partial config = no relay
  });
});
