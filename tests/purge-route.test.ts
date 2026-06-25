/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

const SHOP = 'test.myshopify.com';

describe('purgeProductData', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

  it('hard-deletes the product_links + warehouse_products rows for a pid', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.putLink({ cjPid: 'P1', state: 'draft', shopifyProductId: 'gid://shopify/Product/1', category: 'pet-toys' });
    await store.putWarehouseProduct({ cjPid: 'P1', category: 'pet-toys', title: 'Dog Chew Toy', detailJson: '{"origins":{"GB":40}}', priceUsd: 6, listedNum: 20, stock: 50 });
    // a second product that must NOT be touched
    await store.putLink({ cjPid: 'KEEP', state: 'draft', shopifyProductId: 'gid://shopify/Product/2', category: 'pet-toys' });

    expect(await store.getLink('P1')).not.toBeNull();
    expect(await store.getWarehouseProduct('P1')).not.toBeNull();

    await store.purgeProductData('P1');

    expect(await store.getLink('P1')).toBeNull();
    expect(await store.getWarehouseProduct('P1')).toBeNull();
    expect(await store.getLink('KEEP')).not.toBeNull(); // unrelated pid untouched
  });
});
