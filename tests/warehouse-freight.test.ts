/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { backfillWarehouseFreight } from '../src/jobs';
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

function detailOf(pid: string, opts: { origins?: Record<string, number>; freightUsd?: number; vid?: string } = {}): CjDetail {
  return {
    pid, nameEn: `Product ${pid}`, images: [], descriptionHtml: '',
    variants: [{ vid: opts.vid ?? `v-${pid}`, name: 'Default', sku: `sku-${pid}`, sellPriceUsd: 8, stock: 20 }],
    listedNum: 3, stock: 20,
    ...(opts.origins ? { origins: opts.origins } : {}),
    ...(opts.freightUsd !== undefined ? { freightUsd: opts.freightUsd } : {})
  } as unknown as CjDetail;
}

async function seed(s: TenantStore, pid: string, detail: CjDetail): Promise<void> {
  await s.putLink({ cjPid: pid, state: 'imported', shopifyProductId: `gid://shopify/Product/${pid}` });
  await s.putWarehouseProduct({ cjPid: pid, category: 'pet-toys', title: detail.nameEn, detailJson: JSON.stringify(detail), priceUsd: 8, listedNum: 3, stock: 20 });
}

function cjMock(opts: { origins?: Record<string, Record<string, number>>; freightUsd?: number | null } = {}, calls: string[] = []): CjClient {
  return {
    originsByPid: async (pid: string) => { calls.push(`origins:${pid}`); return opts.origins?.[pid] ?? {}; },
    freightEstimate: async (vid: string, origin: string) => {
      calls.push(`freight:${vid}:${origin}`);
      return opts.freightUsd === null ? null : { name: 'Line', priceUsd: opts.freightUsd ?? 5.02, days: '4-7' };
    }
  } as unknown as CjClient;
}

describe('importedRowsWithoutFreight', () => {
  it('lists only imported, linked products whose stored detail lacks freightUsd', async () => {
    const s = store();
    await seed(s, 'p-missing', detailOf('p-missing', { origins: { CN: 100 } }));       // no freight -> listed
    await seed(s, 'p-zero', detailOf('p-zero', { origins: { GB: 30 }, freightUsd: 0 })); // KNOWN zero -> not listed
    await seed(s, 'p-freighted', detailOf('p-freighted', { origins: { CN: 9 }, freightUsd: 5.5 })); // known -> not listed
    await s.putLink({ cjPid: 'p-ghost', state: 'ghost' });                              // not imported -> not listed
    await s.putWarehouseProduct({ cjPid: 'p-ghost', category: null, title: 'G', detailJson: JSON.stringify(detailOf('p-ghost')), priceUsd: 8, listedNum: 3, stock: 20 });
    await s.putLink({ cjPid: 'p-norow', state: 'imported', shopifyProductId: 'gid://shopify/Product/n' }); // no warehouse row -> not this list's business
    const rows = await s.importedRowsWithoutFreight();
    expect(rows.map((r) => r.cj_pid)).toEqual(['p-missing']);
  });
});

describe('backfillWarehouseFreight', () => {
  it('writes freightUsd + origin into the stored detail WITHOUT touching stock or status', async () => {
    const s = store();
    await seed(s, 'p1', detailOf('p1', { origins: { CN: 500 } }));
    await s.setWarehouseStock('p1', 2, 'low_stock'); // the row is currently low_stock - the backfill must not "revive" it
    const calls: string[] = [];
    const n = await backfillWarehouseFreight(s, cjMock({ freightUsd: 5.02 }, calls), CFG, noPause);
    expect(n).toBe(1);
    const wh = await s.getWarehouseProduct('p1');
    const d = JSON.parse(wh!.detail);
    expect(d.freightUsd).toBe(5.02);
    expect(d.origin).toBe('CN');
    expect(wh!.status).toBe('low_stock'); // detail-only update: no status reset
    expect(wh!.stock).toBe(2);            // ...and no stock overwrite
    expect(calls).toEqual(['freight:v-p1:CN']); // origins already stored - no origins call
    expect(await s.importedRowsWithoutFreight()).toEqual([]); // healed - off the work-list
  });

  it('fetches the origins map live when the stored detail lacks one, and persists it', async () => {
    const s = store();
    await seed(s, 'p2', detailOf('p2'));
    const calls: string[] = [];
    const n = await backfillWarehouseFreight(s, cjMock({ origins: { p2: { US: 80 } }, freightUsd: 3.4 }, calls), CFG, noPause);
    expect(n).toBe(1);
    const d = JSON.parse((await s.getWarehouseProduct('p2'))!.detail);
    expect(d.origins).toEqual({ US: 80 });
    expect(d.origin).toBe('US');
    expect(d.freightUsd).toBe(3.4);
    expect(calls).toEqual(['origins:p2', 'freight:v-p2:US']);
  });

  it('a failed quote leaves the row untouched and ON the work-list (self-healing)', async () => {
    const s = store();
    await seed(s, 'p3', detailOf('p3', { origins: { CN: 100 } }));
    const n = await backfillWarehouseFreight(s, cjMock({ freightUsd: null }), CFG, noPause);
    expect(n).toBe(0);
    expect(JSON.parse((await s.getWarehouseProduct('p3'))!.detail).freightUsd).toBeUndefined();
    expect((await s.importedRowsWithoutFreight()).map((r) => r.cj_pid)).toEqual(['p3']); // retried next night
  });

  it('a 0-freight quote is KNOWN zero: written, and the row leaves the work-list', async () => {
    const s = store();
    await seed(s, 'p4', detailOf('p4', { origins: { GB: 30 } }));
    const n = await backfillWarehouseFreight(s, cjMock({ freightUsd: 0 }), CFG, noPause);
    expect(n).toBe(1);
    expect(JSON.parse((await s.getWarehouseProduct('p4'))!.detail).freightUsd).toBe(0);
    expect(await s.importedRowsWithoutFreight()).toEqual([]);
  });

  it('skips a row with no real variant id (vid "default") without spending CJ calls', async () => {
    const s = store();
    await seed(s, 'p5', detailOf('p5', { origins: { CN: 50 }, vid: 'default' }));
    const calls: string[] = [];
    const n = await backfillWarehouseFreight(s, cjMock({ freightUsd: 5 }, calls), CFG, noPause);
    expect(n).toBe(0);
    expect(calls).toEqual([]);
  });

  it('respects the per-run batch limit; the rest drain next run', async () => {
    const s = store();
    for (let i = 0; i < 4; i++) await seed(s, `b${i}`, detailOf(`b${i}`, { origins: { CN: 50 } }));
    const n = await backfillWarehouseFreight(s, cjMock({ freightUsd: 4 }), CFG, { ...noPause, limit: 2 });
    expect(n).toBe(2);
    expect((await s.importedRowsWithoutFreight()).length).toBe(2);
  });
});
