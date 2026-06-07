import { describe, it, expect } from 'vitest';
import { resolveShopFromToken } from '../src/console/session';

describe('resolveShopFromToken', () => {
  it('extracts the shop host from a decoded session token', async () => {
    const decode = async () => ({ dest: 'https://a.myshopify.com', aud: 'apikey' });
    expect(await resolveShopFromToken('Bearer x', 'apikey', decode)).toEqual({ ok: true, shop: 'a.myshopify.com' });
  });

  it('rejects a missing bearer token', async () => {
    const decode = async () => ({ dest: 'https://a.myshopify.com' });
    expect((await resolveShopFromToken(null, 'apikey', decode)).ok).toBe(false);
  });

  it('rejects an audience mismatch', async () => {
    const decode = async () => ({ dest: 'https://a.myshopify.com', aud: 'someone-else' });
    expect((await resolveShopFromToken('Bearer x', 'apikey', decode)).ok).toBe(false);
  });
});
