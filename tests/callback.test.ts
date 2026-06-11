import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { persistInstall } from '../src/auth/callback';
import { Vault } from '../src/vault';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe('persistInstall', () => {
  it('seals the access token, upserts the tenant, and seeds default config', async () => {
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    await persistInstall(env.DB, vault, { shop: 'a.myshopify.com', accessToken: 'shpat_live', scope: 'write_products' });

    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const tenant = await store.getTenant();
    expect(tenant?.access_token_enc).not.toContain('shpat_live'); // sealed, not plaintext
    expect(await vault.open(tenant!.dek_wrapped, tenant!.access_token_enc)).toBe('shpat_live');

    const cfg = await store.getConfig();
    expect(cfg?.gates.popularityFloor).toBe(50); // DEFAULT_GATES
  });

  it('registers the uninstall webhook with the plaintext token after persisting', async () => {
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    const calls: [string, string][] = [];
    const register = async (shop: string, token: string) => {
      calls.push([shop, token]);
      return { ok: true as const };
    };
    await persistInstall(env.DB, vault, { shop: 'b.myshopify.com', accessToken: 'shpat_x', scope: 's' }, register);
    expect(calls).toEqual([['b.myshopify.com', 'shpat_x']]);
  });

  it('still installs when webhook registration fails', async () => {
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    const register = async () => ({ ok: false as const, error: 'boom' });
    await persistInstall(env.DB, vault, { shop: 'c.myshopify.com', accessToken: 'shpat_y', scope: 's' }, register);
    const tenant = await new TenantStore(env.DB, 'c.myshopify.com').getTenant();
    expect(await vault.open(tenant!.dek_wrapped, tenant!.access_token_enc)).toBe('shpat_y');
  });

  it('reinstall reuses the DEK so sealed supplier credentials survive re-auth', async () => {
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    await persistInstall(env.DB, vault, { shop: 'd.myshopify.com', accessToken: 'tok1', scope: 's' });
    const store = new TenantStore(env.DB, 'd.myshopify.com');
    const before = await store.getTenant();
    await store.putSupplierCredential('cj', await vault.seal(before!.dek_wrapped, 'cj-key'), 'cj');

    // Re-auth (e.g. scope update): must NOT rotate the DEK.
    await persistInstall(env.DB, vault, { shop: 'd.myshopify.com', accessToken: 'tok2', scope: 's2' });

    const after = await store.getTenant();
    expect(after!.dek_wrapped).toBe(before!.dek_wrapped);
    expect(await vault.open(after!.dek_wrapped, after!.access_token_enc)).toBe('tok2'); // fresh token sealed
    const cred = await store.getSupplierCredential('cj');
    expect(await vault.open(after!.dek_wrapped, cred!.api_key_enc)).toBe('cj-key'); // still opens
  });

  it('a wiped tenant (post-uninstall) gets a brand-new DEK on reinstall', async () => {
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    await persistInstall(env.DB, vault, { shop: 'e.myshopify.com', accessToken: 'tok1', scope: 's' });
    const store = new TenantStore(env.DB, 'e.myshopify.com');
    const before = await store.getTenant();
    await store.deleteAllSecrets(); // uninstall crypto-shred

    await persistInstall(env.DB, vault, { shop: 'e.myshopify.com', accessToken: 'tok2', scope: 's' });
    const after = await store.getTenant();
    expect(after!.dek_wrapped).not.toBe('');
    expect(after!.dek_wrapped).not.toBe(before!.dek_wrapped);
    expect(await vault.open(after!.dek_wrapped, after!.access_token_enc)).toBe('tok2');
  });
});
