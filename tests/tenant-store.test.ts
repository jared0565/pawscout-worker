import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('TenantStore', () => {
  it('upserts and reads back a tenant scoped to its shop', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.upsertTenant({ accessTokenEnc: 'tokA', dekWrapped: 'dekA', scopes: 's' });
    const row = await a.getTenant();
    expect(row?.shop).toBe('a.myshopify.com');
    expect(row?.access_token_enc).toBe('tokA');
  });

  it('never returns another shop\'s row', async () => {
    await new TenantStore(env.DB, 'a.myshopify.com').upsertTenant({ accessTokenEnc: 'tokA', dekWrapped: 'd', scopes: 's' });
    const b = new TenantStore(env.DB, 'b.myshopify.com');
    expect(await b.getTenant()).toBeNull();
  });

  it('reads/writes config scoped to shop', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    await a.seedConfig({ collectionMap: { x: { handle: 'x', tag: 'cj-cat-x' } }, gates: { popularityFloor: 10, priceMin: 1, priceMax: 9, relevance: 'title' }, target: 16 });
    const cfg = await a.getConfig();
    expect(cfg?.collectionMap.x.tag).toBe('cj-cat-x');
    expect(await new TenantStore(env.DB, 'b.myshopify.com').getConfig()).toBeNull();
  });

  it('stores and reads a supplier credential scoped to shop', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.putSupplierCredential('cj', 'enc-blob', 'mykey');
    const c = await a.getSupplierCredential('cj');
    expect(c?.api_key_enc).toBe('enc-blob');
    expect(await new TenantStore(env.DB, 'b.myshopify.com').getSupplierCredential('cj')).toBeNull();
  });
});
