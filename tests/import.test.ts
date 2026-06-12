import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { importProduct, buildPreview, stripHtml, resolveCategory } from '../src/proxy/import';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, type TenantConfig } from '../src/types';
import type { CjDetail } from '../src/cj';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const CFG: TenantConfig = {
  collectionMap: {
    'pet-toys': { handle: 'pet-toys', tag: 'cj-cat-pet-toys' },
    'more-to-love': { handle: 'more-to-love', tag: 'cj-cat-more-to-love' }
  },
  gates: DEFAULT_GATES,
  pricing: DEFAULT_PRICING,
  floors: DEFAULT_FLOORS,
  target: 12
};

const DETAIL: CjDetail = {
  pid: 'P1',
  nameEn: 'Dog Toy Rope',
  images: ['https://i/1.jpg', 'https://i/2.jpg'],
  descriptionHtml: '<p>Fun <script>alert(1)</script>rope toy</p>',
  variants: [
    { vid: 'v1', name: 'Red', sellPriceUsd: 10, sku: 'S1' },
    { vid: 'v2', name: 'Blue', sellPriceUsd: 12, sku: 'S2' }
  ],
  listedNum: 100,
  categoryName: 'Pet Toys'
};

interface Call { query: string; variables?: Record<string, unknown> }

function fakeAdmin(calls: Call[], overrides: Record<string, unknown> = {}): AdminGraphql {
  return async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('productSet')) {
      return (overrides.productSet as Record<string, unknown>) ?? {
        productSet: { product: { id: 'gid://shopify/Product/1', handle: 'dog-toy-rope' }, userErrors: [] }
      };
    }
    if (query.includes('publications(')) {
      return { publications: { nodes: [{ id: 'gid://shopify/Publication/9', name: 'Online Store' }] } };
    }
    if (query.includes('publishablePublish')) return { publishablePublish: { userErrors: [] } };
    if (query.includes('pawscoutLocation')) return { location: { id: 'gid://shopify/Location/1' } };
    if (query.includes('metafieldsSet')) return { metafieldsSet: { userErrors: [] } };
    if (query.includes('productUpdate')) return { productUpdate: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] } };
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  };
}

describe('preview building', () => {
  it('strips untrusted HTML from descriptions', () => {
    expect(stripHtml(DETAIL.descriptionHtml)).toBe('Fun rope toy');
  });

  it('prices every variant under the tenant rule and exposes plain text only', () => {
    const p = buildPreview(DETAIL, CFG, 'ghost', null);
    expect(p.variants).toEqual([
      { name: 'Red', price: 19.99 },
      { name: 'Blue', price: 23.99 }
    ]);
    expect(p.priceFrom).toBe(19.99);
    expect(p.descriptionText).not.toContain('<');
    expect(p.url).toBeNull();
  });

  it('resolves the category from CJ data, falling back to more-to-love', () => {
    expect(resolveCategory(CFG, DETAIL)).toBe('pet-toys');
    expect(resolveCategory(CFG, { categoryName: 'Aquarium', nameEn: 'Fish Tank Filter' })).toBe('more-to-love');
  });
});

describe('importProduct', () => {
  it('creates, publishes, and records the link with tags and computed prices', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL);

    const setCall = calls.find((c) => c.query.includes('productSet'))!;
    const input = setCall.variables!.input as Record<string, unknown>;
    expect(input.tags).toEqual(['cj-import', 'cj-pid-P1', 'cj-cat-pet-toys']);
    expect((input.variants as { price: string }[]).map((v) => v.price)).toEqual(['19.99', '23.99']);
    expect(calls.some((c) => c.query.includes('publishablePublish'))).toBe(true);

    const link = await store.getLink('P1');
    expect(link).toMatchObject({ state: 'imported', shopify_product_id: 'gid://shopify/Product/1', handle: 'dog-toy-rope', category: 'pet-toys' });
  });

  it('creates tracked DENY inventory at the primary location when stock is known', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const detail = {
      ...DETAIL,
      stock: 30,
      variants: [
        { vid: 'v1', name: 'Red', sellPriceUsd: 10, sku: 'S1', stock: 30 },
        { vid: 'v2', name: 'Blue', sellPriceUsd: 12, sku: 'S2', stock: 15 }
      ]
    };
    await importProduct(store, fakeAdmin(calls), CFG, detail);

    const input = calls.find((c) => c.query.includes('productSet'))!.variables!.input as {
      variants: { inventoryPolicy?: string; inventoryItem?: { tracked: boolean }; inventoryQuantities?: { locationId: string; quantity: number }[] }[];
    };
    expect(input.variants[0].inventoryPolicy).toBe('DENY');
    expect(input.variants[0].inventoryItem).toEqual({ tracked: true });
    expect(input.variants[0].inventoryQuantities![0]).toMatchObject({ locationId: 'gid://shopify/Location/1', quantity: 30 });
    expect(input.variants[1].inventoryQuantities![0].quantity).toBe(15);
    expect(calls.some((c) => c.query.includes('metafieldsSet'))).toBe(true);
  });

  it('imports untracked when stock is unknown (never tracked-at-zero)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL); // DETAIL has no stock
    const input = calls.find((c) => c.query.includes('productSet'))!.variables!.input as {
      variants: { inventoryPolicy?: string }[];
    };
    expect(input.variants[0].inventoryPolicy).toBeUndefined();
    expect(calls.some((c) => c.query.includes('pawscoutLocation'))).toBe(false);
  });

  it('marks the link failed when Shopify rejects the product, without throwing', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const calls: Call[] = [];
    const admin = fakeAdmin(calls, { productSet: { productSet: { product: null, userErrors: [{ field: null, message: 'Title taken' }] } } });
    await importProduct(store, admin, CFG, DETAIL);
    expect((await store.getLink('P1'))?.state).toBe('failed');
  });

  it('revives an archived product instead of duplicating it', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'archived', shopifyProductId: 'gid://shopify/Product/1', handle: 'dog-toy-rope' });
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL);

    expect(calls).toHaveLength(1); // single productUpdate, no productSet
    expect(calls[0].query).toContain('productUpdate');
    expect((calls[0].variables!.input as { status: string }).status).toBe('ACTIVE');
    expect((await store.getLink('P1'))?.state).toBe('imported');
  });

  it('is a no-op when already imported', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://1', handle: 'x' });
    const calls: Call[] = [];
    await importProduct(store, fakeAdmin(calls), CFG, DETAIL);
    expect(calls).toHaveLength(0);
  });
});
