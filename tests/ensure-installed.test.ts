import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { ensureInstalled } from '../src/auth/ensure-installed';
import { Vault } from '../src/vault';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe('ensureInstalled (managed-install token exchange)', () => {
  it('exchanges and persists a sealed offline token on first call', async () => {
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    let calls = 0;
    const exchange = async (shop: string, token: string): Promise<{ accessToken: string; scope: string }> => {
      calls++;
      expect(shop).toBe('a.myshopify.com');
      expect(token).toBe('session-jwt'); // raw session token is passed straight through
      return { accessToken: 'shpat_offline', scope: 'write_products' };
    };

    await ensureInstalled(env.DB, vault, 'a.myshopify.com', 'session-jwt', exchange);

    expect(calls).toBe(1);
    const tenant = await new TenantStore(env.DB, 'a.myshopify.com').getTenant();
    expect(tenant?.access_token_enc).not.toContain('shpat_offline'); // sealed, not plaintext
    expect(await vault.open(tenant!.dek_wrapped, tenant!.access_token_enc)).toBe('shpat_offline');
  });

  it('is a no-op when the tenant already holds a sealed token', async () => {
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    await ensureInstalled(env.DB, vault, 'b.myshopify.com', 'jwt', async () => ({ accessToken: 'tok1', scope: 's' }));

    let secondCalled = false;
    await ensureInstalled(env.DB, vault, 'b.myshopify.com', 'jwt', async () => {
      secondCalled = true;
      return { accessToken: 'tok2', scope: 's' };
    });

    expect(secondCalled).toBe(false); // did not re-exchange
    const tenant = await new TenantStore(env.DB, 'b.myshopify.com').getTenant();
    expect(await vault.open(tenant!.dek_wrapped, tenant!.access_token_enc)).toBe('tok1'); // unchanged
  });

  it('does not persist a tenant when exchange yields an empty token', async () => {
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    await expect(
      ensureInstalled(env.DB, vault, 'c.myshopify.com', 'jwt', async () => ({ accessToken: '', scope: '' }))
    ).rejects.toThrow(/no access token/);
    const tenant = await new TenantStore(env.DB, 'c.myshopify.com').getTenant();
    expect(tenant).toBeNull(); // nothing persisted on a bad exchange
  });
});
