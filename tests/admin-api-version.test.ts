// Admin API version pin (2026-07-06): the worker migrated off the library's
// LATEST_API_VERSION (capped at 2025-07, whose inventorySetQuantities shape is
// deprecated with a Jan 2027 sunset) onto an explicitly pinned, empirically
// validated version. These tests pin the version string and the migrated
// inventory input shape so neither can drift silently.
import { describe, it, expect } from 'vitest';
import { makeAdminGraphql, ADMIN_API_VERSION } from '../src/shopify-admin';
import { setInventoryQuantities } from '../src/proxy/inventory';
import type { AdminGraphql } from '../src/shopify-admin';

describe('ADMIN_API_VERSION', () => {
  it('is 2026-04 or later (the dev-dashboard deprecation deadline)', () => {
    expect(ADMIN_API_VERSION >= '2026-04').toBe(true);
  });

  it('every raw admin call hits the pinned version', async () => {
    let url = '';
    const fetchImpl = (async (u: RequestInfo | URL) => {
      url = String(u);
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const admin = makeAdminGraphql('a.myshopify.com', 'tok', fetchImpl);
    await admin('query { shop { name } }');
    expect(url).toBe(`https://a.myshopify.com/admin/api/${ADMIN_API_VERSION}/graphql.json`);
  });
});

describe('makeAdminGraphql throttle retry', () => {
  const noSleep = async () => {};

  it('retries a GraphQL THROTTLED error then succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }), { status: 200 });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const admin = makeAdminGraphql('a.myshopify.com', 'tok', fetchImpl, noSleep);
    expect(await admin('q')).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('retries an HTTP 429 then succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('rate', { status: 429 });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const admin = makeAdminGraphql('a.myshopify.com', 'tok', fetchImpl, noSleep);
    await admin('q');
    expect(calls).toBe(2);
  });

  it('does NOT retry a real (non-throttle) GraphQL error', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ errors: [{ message: 'Field does not exist' }] }), { status: 200 }); }) as unknown as typeof fetch;
    const admin = makeAdminGraphql('a.myshopify.com', 'tok', fetchImpl, noSleep);
    await expect(admin('q')).rejects.toThrow(/Field does not exist/);
    expect(calls).toBe(1);
  });

  it('gives up after 4 attempts of persistent throttling', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }), { status: 200 }); }) as unknown as typeof fetch;
    const admin = makeAdminGraphql('a.myshopify.com', 'tok', fetchImpl, noSleep);
    await expect(admin('q')).rejects.toThrow(/[Tt]hrottl/);
    expect(calls).toBe(4);
  });
});

describe('makeAdminGraphql idempotency (2026-04)', () => {
  const noSleep = async () => {};
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function capture() {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }
  const vars = (b: Record<string, unknown>) => b.variables as Record<string, unknown>;

  it('mints a UUID idempotencyKey when the document uses @idempotent', async () => {
    const { bodies, fetchImpl } = capture();
    const admin = makeAdminGraphql('a.myshopify.com', 'tok', fetchImpl, noSleep);
    await admin('mutation X($input: I!, $idempotencyKey: String!) { foo(input: $input) @idempotent(key: $idempotencyKey) { id } }', { input: {} });
    expect(vars(bodies[0]).idempotencyKey).toMatch(UUID);
  });

  it('reuses the SAME key across throttle retries so a retried write dedupes', async () => {
    const keys: string[] = [];
    let calls = 0;
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      keys.push((JSON.parse(String(init?.body)).variables as { idempotencyKey: string }).idempotencyKey);
      if (calls < 2) return new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }), { status: 200 });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const admin = makeAdminGraphql('a.myshopify.com', 'tok', fetchImpl, noSleep);
    await admin('mutation X { foo @idempotent(key: $idempotencyKey) { id } }', {});
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('does not inject a key when the document has no @idempotent', async () => {
    const { bodies, fetchImpl } = capture();
    const admin = makeAdminGraphql('a.myshopify.com', 'tok', fetchImpl, noSleep);
    await admin('mutation { productUpdate(input: {}) { product { id } } }', {});
    expect('idempotencyKey' in vars(bodies[0])).toBe(false);
  });

  it('does not override a caller-supplied idempotencyKey', async () => {
    const { bodies, fetchImpl } = capture();
    const admin = makeAdminGraphql('a.myshopify.com', 'tok', fetchImpl, noSleep);
    await admin('mutation X { foo @idempotent(key: $idempotencyKey) { id } }', { idempotencyKey: 'caller-fixed' });
    expect(vars(bodies[0]).idempotencyKey).toBe('caller-fixed');
  });
});

describe('setInventoryQuantities (2026-04 shape)', () => {
  it('sends changeFromQuantity: null per line and never the removed fields', async () => {
    let vars: Record<string, unknown> = {};
    const admin: AdminGraphql = async (_q, v) => {
      vars = v ?? {};
      return { inventorySetQuantities: { userErrors: [] } };
    };
    await setInventoryQuantities(admin, 'gid://loc/1', [
      { inventoryItemId: 'gid://item/1', quantity: 5 },
      { inventoryItemId: 'gid://item/2', quantity: 0 }
    ]);
    const input = vars.input as Record<string, unknown>;
    expect(input.reason).toBe('correction');
    expect('ignoreCompareQuantity' in input).toBe(false);
    expect('compareQuantity' in input).toBe(false);
    const quantities = input.quantities as Record<string, unknown>[];
    expect(quantities.length).toBe(2);
    for (const q of quantities) {
      expect('changeFromQuantity' in q).toBe(true); // required on 2026-04
      expect(q.changeFromQuantity).toBeNull();      // null = force-set opt-out
    }
  });

  it('carries @idempotent(key: $idempotencyKey) on the field (2026-04 runtime requirement)', async () => {
    let doc = '';
    const admin: AdminGraphql = async (query) => { doc = query; return { inventorySetQuantities: { userErrors: [] } }; };
    await setInventoryQuantities(admin, 'gid://loc/1', [{ inventoryItemId: 'gid://item/1', quantity: 5 }]);
    // inventorySetQuantities is on Shopify's mandatory-idempotency list for 2026-04:
    // without the directive the live API throws "The @idempotent directive is required".
    expect(doc).toMatch(/inventorySetQuantities\(input: \$input\) @idempotent\(key: \$idempotencyKey\)/);
    expect(doc).toMatch(/\$idempotencyKey: String!/);
  });
});
