/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { backfillOriginSignatures } from '../src/jobs';
import type { CjClient, CjDetail } from '../src/cj';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
import { DEFAULT_INBOX } from '../src/inbox/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';
const CFG: TenantConfig = {
  collectionMap: {}, gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS,
  llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
};
const noPause = { pause: async () => undefined };

function store() { return new TenantStore(env.DB, SHOP); }

function detailOf(pid: string, origins: Record<string, number>): CjDetail {
  return {
    pid, nameEn: `Product ${pid}`, images: [], descriptionHtml: '',
    variants: [{ vid: `v-${pid}`, name: 'Default', sku: `sku-${pid}`, sellPriceUsd: 8, stock: 20 }],
    listedNum: 3, stock: 20, origins
  } as unknown as CjDetail;
}

function cjMock(details: Record<string, CjDetail | null>, freightUsd: number | null, calls: string[] = []): CjClient {
  return {
    detail: async (pid: string) => { calls.push(`detail:${pid}`); return details[pid] ?? null; },
    freightEstimate: async (vid: string, origin: string) => {
      calls.push(`freight:${vid}:${origin}`);
      return freightUsd === null ? null : { name: 'Line', priceUsd: freightUsd, days: '4-7' };
    }
  } as unknown as CjClient;
}

describe('importedCjPidsWithoutOrigins', () => {
  it('lists imported products lacking an origins-bearing warehouse row (missing OR empty origins)', async () => {
    const s = store();
    await s.putLink({ cjPid: 'p-none', state: 'imported', shopifyProductId: 'gid://shopify/Product/1' });   // no warehouse row
    await s.putLink({ cjPid: 'p-empty', state: 'imported', shopifyProductId: 'gid://shopify/Product/2' });  // row, empty origins
    await s.putWarehouseProduct({ cjPid: 'p-empty', category: null, title: 'E', detailJson: JSON.stringify(detailOf('p-empty', {})), priceUsd: 5, listedNum: 1, stock: 1 });
    await s.putLink({ cjPid: 'p-signed', state: 'imported', shopifyProductId: 'gid://shopify/Product/3' }); // row WITH origins
    await s.putWarehouseProduct({ cjPid: 'p-signed', category: null, title: 'S', detailJson: JSON.stringify(detailOf('p-signed', { GB: 9 })), priceUsd: 5, listedNum: 1, stock: 9 });
    await s.putLink({ cjPid: 'p-ghost', state: 'ghost' });                                                  // not imported
    const rows = await s.importedCjPidsWithoutOrigins();
    expect(rows.map((r) => r.cj_pid).sort()).toEqual(['p-empty', 'p-none']);
  });
});

describe('backfillOriginSignatures', () => {
  it('backfills the warehouse row (with freight) so the product gains its origin signature', async () => {
    const s = store();
    await s.putLink({ cjPid: 'p1', state: 'imported', shopifyProductId: 'gid://shopify/Product/10', category: 'pet-toys' });
    const calls: string[] = [];
    const n = await backfillOriginSignatures(s, cjMock({ p1: detailOf('p1', { CN: 500 }) }, 5.02, calls), CFG, noPause);
    expect(n).toBe(1);
    // signature now visible to the profile sync
    const sigs = await s.listSignatureMemberships();
    expect(sigs.get('CN')).toEqual(['gid://shopify/Product/10']);
    // the stored detail carries the freight the pricing rule bakes into the sticker
    const wh = await s.getWarehouseProduct('p1');
    expect(JSON.parse(wh!.detail).freightUsd).toBe(5.02);
    expect(calls).toContain('detail:p1');
  });

  it('keeps a domestic (GB) product at freight 0 and signs it GB', async () => {
    const s = store();
    await s.putLink({ cjPid: 'p2', state: 'imported', shopifyProductId: 'gid://shopify/Product/11' });
    const n = await backfillOriginSignatures(s, cjMock({ p2: detailOf('p2', { GB: 30 }) }, 0), CFG, noPause);
    expect(n).toBe(1);
    expect((await s.listSignatureMemberships()).get('GB')).toEqual(['gid://shopify/Product/11']);
    expect(JSON.parse((await s.getWarehouseProduct('p2'))!.detail).freightUsd).toBe(0);
  });

  it('leaves products with no stocked origin on the default profile (no row written)', async () => {
    const s = store();
    await s.putLink({ cjPid: 'p3', state: 'imported', shopifyProductId: 'gid://shopify/Product/12' });
    const n = await backfillOriginSignatures(s, cjMock({ p3: detailOf('p3', {}) }, 5), CFG, noPause);
    expect(n).toBe(0);
    expect(await s.getWarehouseProduct('p3')).toBeNull();
    expect((await s.listSignatureMemberships()).size).toBe(0);
  });

  it('survives a failed freight estimate (row still written, freight absent)', async () => {
    const s = store();
    await s.putLink({ cjPid: 'p4', state: 'imported', shopifyProductId: 'gid://shopify/Product/13' });
    const cj = {
      detail: async () => detailOf('p4', { CN: 100 }),
      freightEstimate: async () => { throw new Error('CJ down'); }
    } as unknown as CjClient;
    const n = await backfillOriginSignatures(s, cj, CFG, noPause);
    expect(n).toBe(1);
    expect(JSON.parse((await s.getWarehouseProduct('p4'))!.detail).freightUsd).toBeUndefined();
    expect((await s.listSignatureMemberships()).get('CN')).toEqual(['gid://shopify/Product/13']);
  });

  it('respects the per-run batch limit', async () => {
    const s = store();
    for (let i = 0; i < 4; i++) await s.putLink({ cjPid: `b${i}`, state: 'imported', shopifyProductId: `gid://shopify/Product/2${i}` });
    const details = Object.fromEntries([0, 1, 2, 3].map((i) => [`b${i}`, detailOf(`b${i}`, { CN: 10 })]));
    const n = await backfillOriginSignatures(s, cjMock(details, 4), CFG, { ...noPause, limit: 2 });
    expect(n).toBe(2);
    expect((await s.importedCjPidsWithoutOrigins()).length).toBe(2); // the rest drain next run
  });
});
