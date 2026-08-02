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

  // fail_detail is HOW FAR a product missed, next to the coarse reason. The
  // counts alone cannot separate "missed by 20p" from "missed by GBP 5", and
  // those imply opposite decisions about the gate.
  it('records the magnitude alongside the reason', async () => {
    await store.putLink({
      cjPid: 'a', state: 'failed', failReason: 'curation-score',
      failDetail: 'score 58 < threshold 60',
    });
    const link = await store.getLink('a');
    expect(link?.fail_reason).toBe('curation-score');
    expect(link?.fail_detail).toBe('score 58 < threshold 60');
  });

  it('clears the detail when a product later imports fine', async () => {
    // A detail surviving a success would read as a live product that also
    // failed - worse than silence, because it looks like real evidence.
    await store.putLink({ cjPid: 'a', state: 'failed', failReason: 'curation-score', failDetail: 'score 58 < threshold 60' });
    await store.putLink({ cjPid: 'a', state: 'imported' });
    const link = await store.getLink('a');
    expect(link?.fail_detail).toBeNull();
    expect(link?.fail_reason).toBeNull();
  });

  it('failureDetails returns only rows that HAVE a detail, scoped to the shop', async () => {
    await store.putLink({ cjPid: 'withDetail', state: 'failed', failReason: 'below-profit-floor', failDetail: 'best sub-market net ~GBP 4.80' });
    await store.putLink({ cjPid: 'noDetail', state: 'failed', failReason: 'curation-score' });
    await store.putLink({ cjPid: 'live', state: 'imported' });
    const other = new TenantStore(env.DB, 'other.myshopify.com');
    await other.putLink({ cjPid: 'theirs', state: 'failed', failReason: 'exception', failDetail: 'not mine' });

    const rows = await store.failureDetails();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('below-profit-floor');
    expect(rows[0].detail).toBe('best sub-market net ~GBP 4.80');
  });

  // The whole point of a separate column: free text in fail_reason would
  // shatter the funnel's GROUP BY into one row per product.
  it('keeps the funnel roll-up intact however varied the details are', async () => {
    await store.putLink({ cjPid: 'a', state: 'failed', failReason: 'below-profit-floor', failDetail: 'missed by GBP 0.20' });
    await store.putLink({ cjPid: 'b', state: 'failed', failReason: 'below-profit-floor', failDetail: 'missed by GBP 5.00' });
    expect(await store.failureReasonCounts()).toEqual([{ reason: 'below-profit-floor', n: 2 }]);
  });
});
