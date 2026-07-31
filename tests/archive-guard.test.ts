import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { archiveProductGuarded, writesArchivedStatus } from '../src/catalog/archive-guard';

const SHOP = 'test.myshopify.com';
const noopAdmin = async () => ({});

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe('archiveProductGuarded', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  it('REFUSES to archive a product a blog article references', async () => {
    await store.putProductReferrers('cat-tree-88', [
      { referrerType: 'blog', referrerId: 'indoor-cat-boredom' },
    ]);
    const out = await archiveProductGuarded(noopAdmin, store, {
      cjPid: '1', productId: 'gid://shopify/Product/1', handle: 'cat-tree-88', reason: 'cull',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.refusal).toBe('referenced');
      expect(out.detail).toContain('indoor-cat-boredom');
    }
  });

  it('refuses with missing-scope (not a generic abort) when redirects are unavailable', async () => {
    const out = await archiveProductGuarded(noopAdmin, store, {
      cjPid: '2', productId: 'gid://shopify/Product/2', handle: 'unreferenced-item', reason: 'cull',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.refusal).toBe('missing-scope');
      expect(out.detail).toContain('write_online_store_navigation');
    }
  });

  it('never calls Shopify when it refuses', async () => {
    let called = 0;
    const admin = async () => { called++; return {}; };
    await store.putProductReferrers('watched', [{ referrerType: 'blog', referrerId: 'g' }]);
    await archiveProductGuarded(admin, store, {
      cjPid: '3', productId: 'gid://shopify/Product/3', handle: 'watched', reason: 'cull',
    });
    expect(called).toBe(0);
  });
});

describe('archive tripwire', () => {
  it('flags a real ARCHIVED status write but not an innocent state comparison', () => {
    // Positive controls: genuine archive mutations must be caught.
    expect(writesArchivedStatus(`admin(M, { input: { id, status: 'ARCHIVED' } })`)).toBe(true);
    expect(writesArchivedStatus(`status: "ARCHIVED"`)).toBe(true);
    expect(writesArchivedStatus(`{ input: { id: pid, status:'ARCHIVED' } }`)).toBe(true);

    // Negative controls. These appear throughout src/ and are innocent - this
    // repo already lost time to a guard regex that was too broad (guard.test.ts
    // matched `.exec(` and flagged RegExp.exec as raw D1 access). The fix there
    // was to narrow the TEST, not to "fix" the innocent source.
    expect(writesArchivedStatus(`if (link.state === 'archived') return;`)).toBe(false);
    expect(writesArchivedStatus(`// archived under the CURRENT rules`)).toBe(false);
    expect(writesArchivedStatus(`state: 'ghost' | 'imported' | 'archived'`)).toBe(false);
    expect(writesArchivedStatus(`await store.putLink({ cjPid, state: 'archived' })`)).toBe(false);
    expect(writesArchivedStatus(`WHERE pl.state = 'archived'`)).toBe(false);
  });
});
