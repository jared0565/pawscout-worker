/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX } from '../src/types';

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('TenantStore', () => {
  it('upserts and reads back a tenant scoped to its shop', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.upsertTenant({ accessTokenEnc: 'tokA', dekWrapped: 'dekA', scopes: 's' });
    const row = await a.getTenant();
    expect(row?.shop).toBe('a.myshopify.com');
    expect(row?.access_token_enc).toBe('tokA');
  });

  it('never returns another shop\'s row', async () => {
    await new TenantStore(env.DB, 'a.myshopify.com').upsertTenant({ accessTokenEnc: 'tokA', dekWrapped: 'd', scopes: 's' });
    const b = new TenantStore(env.DB, 'b.myshopify.com');
    expect(await b.getTenant()).toBeNull();
  });

  it('reads/writes config scoped to shop', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    await a.seedConfig({ collectionMap: { x: { handle: 'x', tag: 'cj-pet-x' } }, gates: { popularityFloor: 10, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS,
  llm: DEFAULT_LLM,
  addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 16 });
    const cfg = await a.getConfig();
    expect(cfg?.collectionMap.x.tag).toBe('cj-pet-x');
    expect(await new TenantStore(env.DB, 'b.myshopify.com').getConfig()).toBeNull();
  });

  it('stores and reads a supplier credential scoped to shop', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.putSupplierCredential('cj', 'enc-blob', 'mykey');
    const c = await a.getSupplierCredential('cj');
    expect(c?.api_key_enc).toBe('enc-blob');
    expect(await new TenantStore(env.DB, 'b.myshopify.com').getSupplierCredential('cj')).toBeNull();
  });
});


// The admission funnel (migration 0037). On 2026-08-01 product_links held 270
// rows in state 'failed' against 48 live, written from seven different places,
// with nothing recording which. "Is the gate protecting our margin or are
// imports crashing?" was unanswerable from the data.
describe('fail_reason and the admission funnel', () => {
  let store: TenantStore;
  beforeEach(() => { store = new TenantStore(env.DB, 'funnel.myshopify.com'); });

  it('records the reason a product was kept out, grouped for counting', async () => {
    await store.putLink({ cjPid: 'a', state: 'failed', failReason: 'below-profit-floor' });
    await store.putLink({ cjPid: 'b', state: 'failed', failReason: 'below-profit-floor' });
    await store.putLink({ cjPid: 'c', state: 'failed', failReason: 'no-local-stock' });
    const counts = await store.failureReasonCounts();
    expect(counts).toEqual([
      { reason: 'below-profit-floor', n: 2 },
      { reason: 'no-local-stock', n: 1 },
    ]);
  });

  it('CLEARS the reason when the product later imports fine', async () => {
    // A stale explanation on a live product is worse than none: it would be
    // counted as a rejection forever and make the binding gate look wrong.
    await store.putLink({ cjPid: 'a', state: 'failed', failReason: 'stock-below-floor' });
    await store.putLink({ cjPid: 'a', state: 'imported', shopifyProductId: 'gid://p/1' });
    expect(await store.failureReasonCounts()).toEqual([]);
    const link = await store.getLink('a');
    expect(link?.fail_reason).toBeNull();
  });

  it('counts a failed row with no reason as unrecorded, not as a mystery', async () => {
    // The 270 rows that predate the migration. Naming them keeps the roll-up
    // honest instead of quietly under-reporting the total.
    await store.putLink({ cjPid: 'old', state: 'failed' });
    expect(await store.failureReasonCounts()).toEqual([{ reason: 'unrecorded', n: 1 }]);
  });

  it('does not record a reason against a non-failed state', async () => {
    await store.putLink({ cjPid: 'a', state: 'imported', failReason: 'below-profit-floor' });
    const link = await store.getLink('a');
    expect(link?.fail_reason).toBeNull();
  });
});
