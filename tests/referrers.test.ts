import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { handlesInBody, rebuildBlogReferrers, listArticlesForIndex, rebuildReferrerIndex } from '../src/catalog/referrers';

const SHOP = 'test.myshopify.com';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe('product_referrers store', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  it('round-trips referrers for a handle', async () => {
    await store.putProductReferrers('cat-tree-88', [
      { referrerType: 'blog', referrerId: 'indoor-cat-boredom' },
    ]);
    const rows = await store.referrersFor('cat-tree-88');
    expect(rows).toHaveLength(1);
    expect(rows[0].referrer_type).toBe('blog');
    expect(rows[0].referrer_id).toBe('indoor-cat-boredom');
  });

  it('returns an empty array for an unreferenced handle', async () => {
    expect(await store.referrersFor('never-mentioned')).toEqual([]);
  });

  it('is idempotent - re-putting the same row does not duplicate it', async () => {
    const row = [{ referrerType: 'blog', referrerId: 'guide-a' }];
    await store.putProductReferrers('cat-tree-88', row);
    await store.putProductReferrers('cat-tree-88', row);
    expect(await store.referrersFor('cat-tree-88')).toHaveLength(1);
  });

  it('clearProductReferrers removes only that source', async () => {
    await store.putProductReferrers('cat-tree-88', [
      { referrerType: 'blog', referrerId: 'article-a' },
      { referrerType: 'blog', referrerId: 'article-b' },
    ]);
    await store.clearProductReferrers('blog', 'article-a');
    const rows = await store.referrersFor('cat-tree-88');
    expect(rows.map((r) => r.referrer_id)).toEqual(['article-b']);
  });

  it('scopes rows to the shop - another tenant cannot see them', async () => {
    await store.putProductReferrers('cat-tree-88', [
      { referrerType: 'blog', referrerId: 'guide-a' },
    ]);
    const other = new TenantStore(env.DB, 'other.myshopify.com');
    expect(await other.referrersFor('cat-tree-88')).toEqual([]);
  });
});

describe('handlesInBody', () => {
  it('extracts distinct product handles in order of appearance', () => {
    const html = `<a href="/products/b-item">b</a> <a href='/products/a-item'>a</a> <a href="/products/b-item">again</a>`;
    expect(handlesInBody(html)).toEqual(['b-item', 'a-item']);
  });

  it('ignores non-product links', () => {
    expect(handlesInBody('<a href="/collections/pet-toys">toys</a>')).toEqual([]);
  });
});

describe('rebuildBlogReferrers', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  it('indexes handles from the body and the related list', async () => {
    const n = await rebuildBlogReferrers(store, [
      {
        articleId: 'gid://shopify/Article/1',
        bodyHtml: '<p>Try the <a href="/products/cat-tree-88">tall tree</a>.</p>',
        relatedHandles: ['scratch-post-63'],
      },
    ]);
    expect(n).toBe(2);
    expect((await store.referrersFor('cat-tree-88'))[0].referrer_id).toBe('gid://shopify/Article/1');
    expect((await store.referrersFor('scratch-post-63'))[0].referrer_type).toBe('blog');
  });

  it('a rebuild DROPS a handle the article no longer mentions', async () => {
    await rebuildBlogReferrers(store, [
      { articleId: 'gid://shopify/Article/A', bodyHtml: '<a href="/products/old-item">x</a>', relatedHandles: [] },
    ]);
    expect(await store.referrersFor('old-item')).toHaveLength(1);

    await rebuildBlogReferrers(store, [
      { articleId: 'gid://shopify/Article/A', bodyHtml: '<a href="/products/new-item">y</a>', relatedHandles: [] },
    ]);
    expect(await store.referrersFor('old-item')).toEqual([]);
    expect(await store.referrersFor('new-item')).toHaveLength(1);
  });

  it('does not disturb another article referencing the same product', async () => {
    await rebuildBlogReferrers(store, [
      { articleId: 'gid://shopify/Article/A', bodyHtml: '<a href="/products/shared">x</a>', relatedHandles: [] },
      { articleId: 'gid://shopify/Article/B', bodyHtml: '<a href="/products/shared">y</a>', relatedHandles: [] },
    ]);
    await rebuildBlogReferrers(store, [
      { articleId: 'gid://shopify/Article/A', bodyHtml: '<p>no links now</p>', relatedHandles: [] },
    ]);
    const rows = await store.referrersFor('shared');
    expect(rows.map((r) => r.referrer_id)).toEqual(['gid://shopify/Article/B']);
  });

  it('is case-insensitive on handles', async () => {
    await rebuildBlogReferrers(store, [
      { articleId: 'gid://shopify/Article/A', bodyHtml: '<a href="/products/Mixed-Case">x</a>', relatedHandles: ['UPPER'] },
    ]);
    expect(await store.referrersFor('mixed-case')).toHaveLength(1);
    expect(await store.referrersFor('upper')).toHaveLength(1);
  });
});

describe('listArticlesForIndex', () => {
  const page = (over: Record<string, unknown> = {}) => ({
    blogs: {
      nodes: [{
        handle: 'guides',
        articles: {
          nodes: [{
            id: 'gid://shopify/Article/1',
            body: '<a href="/products/cat-tree-88">tree</a>',
            metafield: { value: '["scratch-post-63"]' },
          }],
          pageInfo: { hasNextPage: false },
        },
      }],
      pageInfo: { hasNextPage: false },
    },
    ...over,
  });

  it('reads the body and the blog/related_products metafield', async () => {
    const scan = await listArticlesForIndex((async () => page()) as never);
    expect(scan.truncated).toBe(false);
    expect(scan.articles).toEqual([{
      articleId: 'gid://shopify/Article/1',
      bodyHtml: '<a href="/products/cat-tree-88">tree</a>',
      relatedHandles: ['scratch-post-63'],
    }]);
  });

  it('reports truncation from the ARTICLE page boundary', async () => {
    const p = page();
    p.blogs.nodes[0].articles.pageInfo.hasNextPage = true;
    const scan = await listArticlesForIndex((async () => p) as never);
    expect(scan.truncated).toBe(true);
  });

  it('reports truncation from the BLOG page boundary', async () => {
    const p = page();
    p.blogs.pageInfo.hasNextPage = true;
    expect((await listArticlesForIndex((async () => p) as never)).truncated).toBe(true);
  });

  it('survives a malformed metafield rather than dropping the article', async () => {
    const p = page();
    p.blogs.nodes[0].articles.nodes[0].metafield = { value: 'not json' };
    const scan = await listArticlesForIndex((async () => p) as never);
    expect(scan.articles[0].relatedHandles).toEqual([]);
  });

  it('THROWS on a query failure - a caught error would read as "nothing is referenced"', async () => {
    const boom = (async () => { throw new Error('admin down'); }) as never;
    await expect(listArticlesForIndex(boom)).rejects.toThrow('admin down');
  });
});

describe('rebuildReferrerIndex', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  const admin = (truncated: boolean) => (async () => ({
    blogs: {
      nodes: [{
        handle: 'guides',
        articles: {
          nodes: [{ id: 'gid://shopify/Article/1', body: '<a href="/products/cat-tree-88">t</a>', metafield: null }],
          pageInfo: { hasNextPage: truncated },
        },
      }],
      pageInfo: { hasNextPage: false },
    },
  })) as never;

  it('writes the rows AND a complete stamp', async () => {
    const r = await rebuildReferrerIndex(store, admin(false));
    expect(r).toEqual({ articleCount: 1, rowCount: 1, truncated: false });
    const stamp = (await store.getReferrerIndexStamp())!;
    expect(stamp.truncated).toBe(false);
    expect(stamp.articleCount).toBe(1);
    expect(Date.parse(stamp.indexedAt)).toBeGreaterThan(0);
  });

  it('still stamps a TRUNCATED scan - no stamp would look like "never ran"', async () => {
    await rebuildReferrerIndex(store, admin(true));
    expect((await store.getReferrerIndexStamp())!.truncated).toBe(true);
  });

  it('overwrites rather than accumulating stamps', async () => {
    await rebuildReferrerIndex(store, admin(true));
    await rebuildReferrerIndex(store, admin(false));
    expect((await store.getReferrerIndexStamp())!.truncated).toBe(false);
  });

  it('a shop that never ran it reads null, not an empty stamp', async () => {
    expect(await new TenantStore(env.DB, 'fresh.myshopify.com').getReferrerIndexStamp()).toBeNull();
  });
});
