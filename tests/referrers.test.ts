import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

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
