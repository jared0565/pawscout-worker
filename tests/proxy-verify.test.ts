import { describe, it, expect } from 'vitest';
import { verifyAppProxy, signAppProxy } from '../src/proxy/verify';

const SECRET = 'shpss_test_secret';

async function signedUrl(params: Record<string, string>): Promise<URL> {
  const sig = await signAppProxy(params, SECRET);
  const u = new URL('https://pawscout.example.com/proxy/search');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('signature', sig);
  return u;
}

function freshParams(extra: Record<string, string> = {}): Record<string, string> {
  return {
    shop: 'a.myshopify.com',
    path_prefix: '/apps/pawscout',
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...extra
  };
}

describe('verifyAppProxy', () => {
  it('accepts a correctly signed, fresh request and returns the shop', async () => {
    const r = await verifyAppProxy(await signedUrl(freshParams({ q: 'dog toy' })), SECRET);
    expect(r).toEqual({ ok: true, shop: 'a.myshopify.com' });
  });

  it('rejects a tampered query param', async () => {
    const u = await signedUrl(freshParams({ q: 'dog toy' }));
    u.searchParams.set('q', 'cat toy');
    expect((await verifyAppProxy(u, SECRET)).ok).toBe(false);
  });

  it('rejects a missing signature', async () => {
    const u = new URL('https://pawscout.example.com/proxy/search?shop=a.myshopify.com');
    expect((await verifyAppProxy(u, SECRET)).ok).toBe(false);
  });

  it('rejects a stale timestamp (replay window)', async () => {
    const r = await verifyAppProxy(
      await signedUrl(freshParams({ timestamp: String(Math.floor(Date.now() / 1000) - 3600) })),
      SECRET
    );
    expect(r).toEqual({ ok: false, status: 401, error: 'Stale timestamp' });
  });

  it('rejects a non-myshopify shop even when correctly signed', async () => {
    const r = await verifyAppProxy(await signedUrl(freshParams({ shop: 'evil.example.com' })), SECRET);
    expect(r).toEqual({ ok: false, status: 401, error: 'Bad shop' });
  });
});
