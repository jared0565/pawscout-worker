import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { handlesInBody, rebuildBlogReferrers } from '../src/catalog/referrers';

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
        handle: 'indoor-cat-boredom',
        bodyHtml: '<p>Try the <a href="/products/cat-tree-88">tall tree</a>.</p>',
        relatedHandles: ['scratch-post-63'],
      },
    ]);
    expect(n).toBe(2);
    expect((await store.referrersFor('cat-tree-88'))[0].referrer_id).toBe('indoor-cat-boredom');
    expect((await store.referrersFor('scratch-post-63'))[0].referrer_type).toBe('blog');
  });

  it('a rebuild DROPS a handle the article no longer mentions', async () => {
    await rebuildBlogReferrers(store, [
      { handle: 'guide-a', bodyHtml: '<a href="/products/old-item">x</a>', relatedHandles: [] },
    ]);
    expect(await store.referrersFor('old-item')).toHaveLength(1);

    await rebuildBlogReferrers(store, [
      { handle: 'guide-a', bodyHtml: '<a href="/products/new-item">y</a>', relatedHandles: [] },
    ]);
    expect(await store.referrersFor('old-item')).toEqual([]);
    expect(await store.referrersFor('new-item')).toHaveLength(1);
  });

  it('does not disturb another article referencing the same product', async () => {
    await rebuildBlogReferrers(store, [
      { handle: 'guide-a', bodyHtml: '<a href="/products/shared">x</a>', relatedHandles: [] },
      { handle: 'guide-b', bodyHtml: '<a href="/products/shared">y</a>', relatedHandles: [] },
    ]);
    await rebuildBlogReferrers(store, [
      { handle: 'guide-a', bodyHtml: '<p>no links now</p>', relatedHandles: [] },
    ]);
    const rows = await store.referrersFor('shared');
    expect(rows.map((r) => r.referrer_id)).toEqual(['guide-b']);
  });

  it('is case-insensitive on handles', async () => {
    await rebuildBlogReferrers(store, [
      { handle: 'guide-a', bodyHtml: '<a href="/products/Mixed-Case">x</a>', relatedHandles: ['UPPER'] },
    ]);
    expect(await store.referrersFor('mixed-case')).toHaveLength(1);
    expect(await store.referrersFor('upper')).toHaveLength(1);
  });
});
