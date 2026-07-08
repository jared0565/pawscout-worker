import { describe, it, expect } from 'vitest';
import { debrandCatalog } from '../src/catalog-debrand';

/** A fake AdminGraphql that serves two product pages + one blog, and records writes. */
function makeFakeAdmin() {
  const titleUpdates: { id: string; title: string }[] = [];
  const bodyUpdates: { id: string; body: string }[] = [];
  const admin = (async (query: string, vars?: Record<string, unknown>) => {
    if (query.includes('products(first: 100')) {
      const cursor = vars?.cursor as string | null;
      if (!cursor) {
        return { products: {
          nodes: [
            { id: 'gid://p/1', title: 'PawHut Stainless Steel Cat Litter Tray, Extra Large Enclosed' },
            { id: 'gid://p/2', title: 'Hooded Cat Litter Tray with Scoop and Deodorants' }
          ],
          pageInfo: { hasNextPage: true, endCursor: 'CUR2' }
        } };
      }
      return { products: {
        nodes: [
          { id: 'gid://p/3', title: 'PawHut 88cm Cat Tree with Sisal Scratching Post and Hanging Toys' },
          { id: 'gid://p/4', title: 'Pet Water Fountain 3.2L' }
        ],
        pageInfo: { hasNextPage: false, endCursor: null }
      } };
    }
    if (query.includes('productUpdate')) {
      const input = vars?.input as { id: string; title: string };
      titleUpdates.push({ id: input.id, title: input.title });
      return { productUpdate: { userErrors: [] } };
    }
    if (query.includes('blogs(first: 20')) {
      return { blogs: { nodes: [ {
        handle: 'guides',
        articles: { nodes: [
          { id: 'gid://a/1', title: 'Litter smells', body: '<p>The <a href="/products/pawhut-litter-tray">PawHut Stainless Steel Cat Litter Tray</a> helps.</p>' },
          { id: 'gid://a/2', title: 'Nails', body: '<p>Trim with clippers.</p>' }
        ], pageInfo: { hasNextPage: false } }
      } ] } };
    }
    if (query.includes('articleUpdate')) {
      const article = vars?.article as { body: string };
      bodyUpdates.push({ id: vars?.id as string, body: article.body });
      return { articleUpdate: { userErrors: [] } };
    }
    throw new Error('unexpected query: ' + query.slice(0, 40));
  });
  return { admin: admin as unknown as import('../src/shopify-admin').AdminGraphql, titleUpdates, bodyUpdates };
}

describe('debrandCatalog', () => {
  it('renames only branded titles, across pages, and leaves clean ones alone', async () => {
    const { admin, titleUpdates } = makeFakeAdmin();
    const r = await debrandCatalog(admin);
    expect(r.productsScanned).toBe(4);
    expect(r.titlesRenamed).toBe(2);
    expect(titleUpdates).toEqual([
      { id: 'gid://p/1', title: 'Stainless Steel Cat Litter Tray, Extra Large Enclosed' },
      { id: 'gid://p/3', title: '88cm Cat Tree with Sisal Scratching Post and Hanging Toys' }
    ]);
  });

  it('de-brands article body visible text but never the link href/handle', async () => {
    const { admin, bodyUpdates } = makeFakeAdmin();
    const r = await debrandCatalog(admin);
    expect(r.articlesScanned).toBe(2);
    expect(r.bodiesUpdated).toBe(1);
    expect(bodyUpdates).toHaveLength(1);
    const body = bodyUpdates[0].body;
    expect(body).toContain('/products/pawhut-litter-tray'); // handle preserved
    expect(body).toContain('>Stainless Steel Cat Litter Tray</a>'); // visible text de-branded
    expect(body).not.toContain('>PawHut ');
  });

  it('collects userErrors without throwing', async () => {
    const admin = (async (query: string) => {
      if (query.includes('products(first: 100')) {
        return { products: { nodes: [{ id: 'gid://p/9', title: 'PawHut Bed' }], pageInfo: { hasNextPage: false } } };
      }
      if (query.includes('productUpdate')) return { productUpdate: { userErrors: [{ message: 'nope' }] } };
      if (query.includes('blogs(first: 20')) return { blogs: { nodes: [] } };
      throw new Error('unexpected');
    }) as unknown as import('../src/shopify-admin').AdminGraphql;
    const r = await debrandCatalog(admin);
    expect(r.titlesRenamed).toBe(0);
    expect(r.errors.some((e) => e.includes('nope'))).toBe(true);
  });
});
