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
});
