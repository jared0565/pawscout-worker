import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { handleUninstall } from '../src/auth/uninstall';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe('handleUninstall', () => {
  it('marks the tenant uninstalled and purges secrets', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.upsertTenant({ accessTokenEnc: 'enc', dekWrapped: 'dek', scopes: 's' });
    await store.putSupplierCredential('cj', 'cjenc', 'k');

    await handleUninstall(env.DB, 'a.myshopify.com');

    const t = await store.getTenant();
    expect(t?.status).toBe('uninstalled');
    expect(t?.access_token_enc).toBe('');
    expect(await store.getSupplierCredential('cj')).toBeNull();
  });
});
