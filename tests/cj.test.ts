import { describe, it, expect } from 'vitest';
import { validateCjKey } from '../src/cj';

describe('validateCjKey', () => {
  it('returns ok when CJ auth succeeds', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ result: true, data: { accessToken: 'tok' } }), { status: 200 });
    expect(await validateCjKey('CJemail@api@token', fakeFetch as typeof fetch)).toEqual({ ok: true });
  });

  it('returns an error when CJ rejects the key', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ result: false, message: 'bad key' }), { status: 200 });
    const r = await validateCjKey('bad', fakeFetch as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('bad key');
  });

  it('returns an error on a non-200', async () => {
    const fakeFetch = async () => new Response('nope', { status: 500 });
    expect((await validateCjKey('x', fakeFetch as typeof fetch)).ok).toBe(false);
  });
});
