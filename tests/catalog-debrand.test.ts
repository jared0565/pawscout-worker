import { describe, it, expect } from 'vitest';
import { debrandCatalog } from '../src/catalog-debrand';

type ArticleInput = { body?: string; image?: { url?: string; altText?: string } };

/** A fake AdminGraphql that serves two product pages + one blog, and records writes. */
function makeFakeAdmin() {
  const titleUpdates: { id: string; title: string }[] = [];
  const articleUpdates: { id: string; article: ArticleInput }[] = [];
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
          // both body link text AND featured-image alt carry the brand
          { id: 'gid://a/1', title: 'Litter smells',
            body: '<p>The <a href="/products/pawhut-litter-tray">PawHut Stainless Steel Cat Litter Tray</a> helps.</p>',
            image: { url: 'https://cdn.shopify.com/x/tray.jpg', altText: 'PawHut Stainless Steel Cat Litter Tray, Extra Large Enclosed' } },
          // clean body, but the image alt is still branded (alt-only update)
          { id: 'gid://a/2', title: 'Cat trees',
            body: '<p>A tall cat tree is great.</p>',
            image: { url: 'https://cdn.shopify.com/x/tree.jpg', altText: 'PawHut 88cm Cat Tree' } },
          // fully clean article - must not be touched
          { id: 'gid://a/3', title: 'Nails',
            body: '<p>Trim with clippers.</p>',
            image: { url: 'https://cdn.shopify.com/x/nail.jpg', altText: 'Nail clipper and grinder' } },
          // competitor/listicle citations authored before the source gate existed -
          // the sweep must scrub them while keeping approved + internal links
          { id: 'gid://a/4', title: 'Cooling beds',
            body: '<p>Dogs pant to cool down. <a href="https://www.purewow.com/family/best-cooling-dog-beds">Dogs only have sweat glands on their paw pads.</a> ' +
              '<a href="https://www.nbcnews.com/select/x">Gel pads stay cool for up to 3 hours and recharge in 15 to 20 minutes.</a> ' +
              'See the <a href="https://www.rspca.org.uk/advice/dogs">RSPCA hot weather advice</a> and our <a href="/collections/pet-accessories">beds</a>.</p>',
            image: { url: 'https://cdn.shopify.com/x/bed.jpg', altText: 'Elevated dog bed' } }
        ], pageInfo: { hasNextPage: false } }
      } ] } };
    }
    if (query.includes('articleUpdate')) {
      articleUpdates.push({ id: vars?.id as string, article: vars?.article as ArticleInput });
      return { articleUpdate: { userErrors: [] } };
    }
    throw new Error('unexpected query: ' + query.slice(0, 40));
  });
  return { admin: admin as unknown as import('../src/shopify-admin').AdminGraphql, titleUpdates, articleUpdates };
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

  it('de-brands article body + image alt, preserves the href handle and the image url', async () => {
    const { admin, articleUpdates } = makeFakeAdmin();
    const r = await debrandCatalog(admin);
    expect(r.articlesScanned).toBe(4);
    expect(r.bodiesUpdated).toBe(3); // a/1 (body+alt), a/2 (alt only), a/4 (links); a/3 untouched

    const a1 = articleUpdates.find((u) => u.id === 'gid://a/1')!;
    expect(a1.article.body).toContain('/products/pawhut-litter-tray');       // handle preserved
    expect(a1.article.body).toContain('>Stainless Steel Cat Litter Tray</a>'); // visible text de-branded
    expect(a1.article.body).not.toContain('>PawHut ');
    expect(a1.article.image).toEqual({ url: 'https://cdn.shopify.com/x/tray.jpg', altText: 'Stainless Steel Cat Litter Tray, Extra Large Enclosed' });

    const a2 = articleUpdates.find((u) => u.id === 'gid://a/2')!;
    expect(a2.article.body).toBeUndefined(); // body was already clean - not rewritten
    expect(a2.article.image).toEqual({ url: 'https://cdn.shopify.com/x/tree.jpg', altText: '88cm Cat Tree' });

    expect(articleUpdates.find((u) => u.id === 'gid://a/3')).toBeUndefined(); // clean article never written
  });

  it('scrubs competitor/listicle links from published bodies, keeping approved + internal links', async () => {
    const { admin, articleUpdates } = makeFakeAdmin();
    await debrandCatalog(admin);
    const a4 = articleUpdates.find((u) => u.id === 'gid://a/4')!;
    expect(a4.article.body).not.toContain('purewow');
    expect(a4.article.body).not.toContain('nbcnews');
    expect(a4.article.body).toContain('Dogs only have sweat glands on their paw pads.'); // words survive, link does not
    expect(a4.article.body).not.toContain('Gel pads stay cool');                          // uncited statistic dropped whole
    expect(a4.article.body).toContain('href="https://www.rspca.org.uk/advice/dogs"');     // approved authority kept
    expect(a4.article.body).toContain('href="/collections/pet-accessories"');             // internal funnel kept
    expect(a4.article.image).toBeUndefined();                                             // clean alt not rewritten
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
