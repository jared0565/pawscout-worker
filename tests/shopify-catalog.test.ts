import { describe, it, expect } from 'vitest';
import { searchShopifyProducts, resolveLineRequest, findCustomerByEmail, variantsByIds } from '../src/shopify-catalog';
import { makeAdminGraphql } from '../src/shopify-admin';

function fakeAdmin(payload: unknown) {
  const f = (async () => new Response(JSON.stringify({ data: payload }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return makeAdminGraphql('a.myshopify.com', 'tok', f);
}
const PRODUCTS = (variants: { id: string; title: string; sku: string | null; price: string; available: boolean }[]) => ({
  products: { edges: [{ node: { id: 'gid://shopify/Product/1', title: 'Dog Collar', variants: { edges: variants.map((v) => ({ node: { id: v.id, title: v.title, sku: v.sku, price: v.price, availableForSale: v.available } })) } } }] }
});

describe('shopify-catalog', () => {
  it('parses variants from a product search', async () => {
    const admin = fakeAdmin(PRODUCTS([{ id: 'gid://shopify/ProductVariant/10', title: 'Red / M', sku: 'C-RED-M', price: '12.50', available: true }]));
    const out = await searchShopifyProducts(admin, 'collar');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ variantId: 'gid://shopify/ProductVariant/10', sku: 'C-RED-M', priceGbp: 12.5, available: true });
  });
  it('resolves to one variant when there is a single match', async () => {
    const admin = fakeAdmin(PRODUCTS([{ id: 'gid://shopify/ProductVariant/10', title: 'Default', sku: 'C1', price: '9.99', available: true }]));
    const r = await resolveLineRequest(admin, 'collar');
    expect(r.status).toBe('resolved');
    expect(r.variant?.variantId).toBe('gid://shopify/ProductVariant/10');
  });
  it('is ambiguous when multiple variants match', async () => {
    const admin = fakeAdmin(PRODUCTS([
      { id: 'gid://shopify/ProductVariant/10', title: 'Red', sku: 'C1', price: '9.99', available: true },
      { id: 'gid://shopify/ProductVariant/11', title: 'Blue', sku: 'C2', price: '9.99', available: true }
    ]));
    const r = await resolveLineRequest(admin, 'collar');
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toHaveLength(2);
  });
  it('is none when nothing matches', async () => {
    const admin = fakeAdmin({ products: { edges: [] } });
    expect((await resolveLineRequest(admin, 'spaceship')).status).toBe('none');
  });
  it('finds a customer by email', async () => {
    const admin = fakeAdmin({ customers: { edges: [{ node: { id: 'gid://shopify/Customer/7' } }] } });
    expect(await findCustomerByEmail(admin, 'x@y.com')).toEqual({ customerId: 'gid://shopify/Customer/7' });
  });
  it('returns null for an unknown customer', async () => {
    const admin = fakeAdmin({ customers: { edges: [] } });
    expect(await findCustomerByEmail(admin, 'no@one.com')).toBeNull();
  });
});

describe('variantsByIds', () => {
  it('resolves variant ids to CatalogVariant objects', async () => {
    const admin = fakeAdmin({
      nodes: [
        {
          id: 'gid://shopify/ProductVariant/10',
          title: 'Red / M',
          sku: 'C-RED-M',
          price: '12.50',
          product: { id: 'gid://shopify/Product/1', title: 'Dog Collar' }
        }
      ]
    });
    const out = await variantsByIds(admin, ['gid://shopify/ProductVariant/10']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      variantId: 'gid://shopify/ProductVariant/10',
      productId: 'gid://shopify/Product/1',
      title: 'Dog Collar',
      variantTitle: 'Red / M',
      sku: 'C-RED-M',
      priceGbp: 12.5,
      available: true
    });
  });

  it('returns empty array for empty id list', async () => {
    const admin = fakeAdmin({ nodes: [] });
    const out = await variantsByIds(admin, []);
    expect(out).toHaveLength(0);
  });

  it('filters out null nodes (unknown ids)', async () => {
    const admin = fakeAdmin({ nodes: [null, { id: 'gid://shopify/ProductVariant/5', title: 'Blue', sku: null, price: '8.00', product: { id: 'gid://shopify/Product/2', title: 'Lead' } }] });
    const out = await variantsByIds(admin, ['gid://shopify/ProductVariant/99', 'gid://shopify/ProductVariant/5']);
    expect(out).toHaveLength(1);
    expect(out[0].variantId).toBe('gid://shopify/ProductVariant/5');
  });
});
