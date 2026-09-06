/// <reference types="@cloudflare/vitest-pool-workers" />
import { it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
it('links a contact to a shopify customer id', async () => {
  const s = new TenantStore(env.DB, 'a.myshopify.com');
  await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
  await s.upsertContact({ email: 'c@x.com', name: 'C' });
  await s.linkContactToShopifyCustomer('c@x.com', 'gid://shopify/Customer/5');
  expect((await s.getContactByEmail('c@x.com'))?.shopify_customer_id).toBe('gid://shopify/Customer/5');
});
