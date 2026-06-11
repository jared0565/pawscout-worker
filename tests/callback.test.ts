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
});
