import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { CjTokenManager, CjClient, parseCjPrice } from '../src/cj';
import { Vault } from '../src/vault';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';

async function seed(): Promise<{ store: TenantStore; vault: Vault }> {
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  const store = new TenantStore(env.DB, SHOP);
  const dek = await vault.newTenantDek();
  await store.upsertTenant({ accessTokenEnc: await vault.seal(dek, 'shpat'), dekWrapped: dek, scopes: 's' });
  await store.putSupplierCredential('cj', await vault.seal(dek, 'cj-api-key'), 'cj');
  return { store, vault };
}

function authFetch(calls: { body: string }[], token = 'cj-token-1'): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    calls.push({ body: String(init?.body) });
    return new Response(
      JSON.stringify({ result: true, data: { accessToken: token, accessTokenExpiryDate: new Date(Date.now() + 14 * 86400_000).toISOString() } }),
      { status: 200 }
    );
  }) as typeof fetch;
}

describe('CjTokenManager', () => {
  it('authenticates once and serves subsequent calls from the sealed cache', async () => {
    const { store, vault } = await seed();
    const calls: { body: string }[] = [];
    const tm = new CjTokenManager(store, vault, authFetch(calls));

    expect(await tm.getToken()).toBe('cj-token-1');
    expect(await tm.getToken()).toBe('cj-token-1');
    expect(calls).toHaveLength(1); // one auth, not two
    expect(calls[0].body).toContain('cj-api-key');

    const row = await store.getCjToken();
    expect(row?.token_enc).not.toContain('cj-token-1'); // sealed at rest
  });

  it('re-authenticates after the cooldown when the cached token is stale', async () => {
    const { store, vault } = await seed();
    const base = Date.now();
    let now = base;
    const calls: { body: string }[] = [];
    const tm = new CjTokenManager(store, vault, authFetch(calls), () => now);

    await tm.getToken();
    // Jump past expiry AND the 300s refresh cooldown.
    now = base + 15 * 86400_000;
    await tm.getToken();
    expect(calls).toHaveLength(2);
  });

  it('refuses to hammer CJ auth: stale-but-rate-limited throws instead of re-authing', async () => {
    const { store, vault } = await seed();
    const base = Date.now();
    let now = base;
    const calls: { body: string }[] = [];
    const tm = new CjTokenManager(store, vault, authFetch(calls), () => now);

    await tm.getToken();
    // Force the cached row to look expired while refreshed_at stays "just now".
    await env.DB.prepare(`UPDATE cj_tokens SET expires_at = ?1 WHERE shop = ?2`)
      .bind(new Date(base - 1000).toISOString(), SHOP).run();
    now = base + 60_000; // only 60s later — inside the 300s cooldown

    await expect(tm.getToken()).rejects.toThrow(/rate-limited/);
    expect(calls).toHaveLength(1);
  });
});

describe('parseCjPrice', () => {
  it('handles numbers, strings, and ranges', () => {
    expect(parseCjPrice(12.5)).toBe(12.5);
    expect(parseCjPrice('7.99')).toBe(7.99);
    expect(parseCjPrice('5.99 -- 12.99')).toBe(5.99);
    expect(parseCjPrice(null)).toBe(0);
  });
});

describe('CjClient 429 backoff', () => {
  const ok = () =>
    new Response(JSON.stringify({ result: true, data: { list: [] } }), { status: 200 });

  it('retries after a 429 and succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    const fetchImpl = (async () => (++calls === 1 ? new Response('', { status: 429 }) : ok())) as typeof fetch;
    const cj = new CjClient(async () => 't', fetchImpl, async (ms) => { waits.push(ms); });
    expect(await cj.search('dog')).toEqual([]);
    expect(calls).toBe(2);
    expect(waits).toEqual([1200]);
  });

  it('gives up after repeated 429s with the status in the error', async () => {
    const fetchImpl = (async () => new Response('', { status: 429 })) as typeof fetch;
    const cj = new CjClient(async () => 't', fetchImpl, async () => {});
    await expect(cj.search('dog')).rejects.toThrow('CJ HTTP 429');
  });
});
