import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { archiveProductGuarded, writesArchivedStatus, indexUsable, INDEX_MAX_AGE_MS } from '../src/catalog/archive-guard';

const SHOP = 'test.myshopify.com';
const noopAdmin = async () => ({});

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

/** A complete, just-built index. Every archive attempt in the real system runs
 *  after the nightly referrer-index stage, so a test that omits this is testing
 *  the dormant path, not the guard. */
async function freshIndex(store: TenantStore, over: Partial<{ truncated: boolean; ageMs: number }> = {}) {
  await store.putReferrerIndexStamp({
    indexedAt: new Date(Date.now() - (over.ageMs ?? 0)).toISOString(),
    articleCount: 3, rowCount: 5, truncated: over.truncated ?? false,
  });
}

describe('archiveProductGuarded', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  it('REFUSES to archive a product a blog article references', async () => {
    await freshIndex(store);
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
    await freshIndex(store);
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
    await freshIndex(store);
    await store.putProductReferrers('watched', [{ referrerType: 'blog', referrerId: 'g' }]);
    await archiveProductGuarded(admin, store, {
      cjPid: '3', productId: 'gid://shopify/Product/3', handle: 'watched', reason: 'cull',
    });
    expect(called).toBe(0);
  });
});

// Vite inlines these file contents as strings at build time (?raw) - no node:fs,
// which workerd does not implement. Mirrors the pattern in tests/guard.test.ts.
declare global {
  interface ImportMeta {
    glob(pattern: string, opts: { query?: string; eager?: boolean; import?: string }): Record<string, string>;
  }
}
const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', eager: true, import: 'default' });

describe('single archive door', () => {
  it('only archive-guard.ts writes status ARCHIVED', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0); // fail loudly if the glob matched nothing
    const offenders = Object.entries(sources)
      .filter(([p]) => !p.endsWith('catalog/archive-guard.ts'))
      .filter(([, src]) => writesArchivedStatus(src))
      .map(([p]) => p);
    expect(offenders, `archive outside the guard: ${offenders.join(', ')}`).toEqual([]);
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

// THE MISS-MEANS-UNKNOWN INVARIANT.
//
// referrersFor() returning [] has two causes with opposite meanings: the product
// really is unreferenced, or the index never saw the article that references it.
// Only the stamp tells them apart, and without it the guard degrades from a 404
// preventer into a 404 generator the moment the redirect scope lands and
// missing-scope stops masking everything.
describe('indexUsable', () => {
  const now = Date.parse('2026-07-31T12:00:00Z');
  const stamp = (over: Partial<{ indexedAt: string; truncated: boolean }> = {}) =>
    ({ indexedAt: '2026-07-31T04:00:00Z', truncated: false, ...over });

  it('accepts a complete index built inside the window', () => {
    expect(indexUsable(stamp(), now).ok).toBe(true);
  });

  it('rejects a NEVER-BUILT index', () => {
    const r = indexUsable(null, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('never been built');
  });

  it('rejects a TRUNCATED index even when it is fresh', () => {
    const r = indexUsable(stamp({ indexedAt: new Date(now).toISOString(), truncated: true }), now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('truncated');
  });

  it('rejects a STALE index and names the age', () => {
    const old = new Date(now - INDEX_MAX_AGE_MS - 60_000).toISOString();
    const r = indexUsable(stamp({ indexedAt: old }), now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('stale');
  });

  it('tolerates ONE skipped nightly run but not two', () => {
    // 24h = a single missed run, still trusted. 48h = two, refused.
    expect(indexUsable(stamp({ indexedAt: new Date(now - 24 * 3600_000).toISOString() }), now).ok).toBe(true);
    expect(indexUsable(stamp({ indexedAt: new Date(now - 48 * 3600_000).toISOString() }), now).ok).toBe(false);
  });

  it('rejects an unparseable timestamp rather than treating NaN as fresh', () => {
    const r = indexUsable(stamp({ indexedAt: 'not-a-date' }), now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('unreadable');
  });
});

describe('archiveProductGuarded index gate', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, SHOP); });

  const attempt = () => archiveProductGuarded(noopAdmin, store, {
    cjPid: '9', productId: 'gid://shopify/Product/9', handle: 'unreferenced-item', reason: 'cull',
  });

  it('refuses an UNREFERENCED product when the index was never built', async () => {
    // The dangerous case: nothing in product_referrers, so the naive read is
    // "safe to archive". It is not - the index simply does not know yet.
    const out = await attempt();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('index-incomplete');
  });

  it('refuses on a truncated index', async () => {
    await freshIndex(store, { truncated: true });
    const out = await attempt();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('index-incomplete');
  });

  it('refuses on a stale index', async () => {
    await freshIndex(store, { ageMs: INDEX_MAX_AGE_MS + 60_000 });
    const out = await attempt();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('index-incomplete');
  });

  it('gets PAST the index gate once the stamp is good', async () => {
    // Proves the gate is a gate and not a permanent block: the refusal reason
    // moves on to the next check in the chain.
    await freshIndex(store);
    const out = await attempt();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusal).toBe('missing-scope');
  });

  it('checks the index BEFORE calling Shopify', async () => {
    let called = 0;
    const admin = async () => { called++; return {}; };
    await archiveProductGuarded(admin, store, {
      cjPid: '9', productId: 'gid://shopify/Product/9', handle: 'x', reason: 'cull',
    });
    expect(called).toBe(0);
  });
});
