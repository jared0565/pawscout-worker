import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { laneRouteFor, overseasClickPlan } from '../src/sourcing/lane-route';
import type { CjClient, CjDetail } from '../src/cj';
import { allowedOriginsFor, inquiryWarehouses } from '../src/local-markets';
import { resolveLogistics, doorToDoorBand, formatBand } from '../src/logistics';
import { DEFAULT_FULFIL, DEFAULT_FLOORS, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG = { fulfil: DEFAULT_FULFIL, floors: DEFAULT_FLOORS } as unknown as TenantConfig;

async function seededStore() {
  const store = new TenantStore(env.DB, 'a.myshopify.com');
  await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v1', freightCostUsd: 4 });
  await store.upsertLogisticsRoute({ from: 'GB', to: 'GB', channel: 'UK Local', transitMin: 1, transitMax: 3, agingRaw: '1-3', repVid: 'v1', freightCostUsd: 3 });
  return store;
}

describe('allowedOriginsFor', () => {
  it('admits the lane plus CN while the lane is transitional, normalising UK to GB', () => {
    expect(allowedOriginsFor({ UK: 5, CN: 10, US: 50 }, 'GB').sort()).toEqual(['CN', 'GB']);
  });
  it('drops CN once the lane is local-only', () => {
    expect(allowedOriginsFor({ CN: 10 }, 'GB', ['GB'])).toEqual([]);
  });
  it('is empty for a country with no lane', () => {
    expect(allowedOriginsFor({ CN: 10 }, 'NG')).toEqual([]);
  });
});

describe('inquiryWarehouses', () => {
  it('is the lane plus CN while transitional', () => {
    expect(inquiryWarehouses('GB')).toEqual(['GB', 'CN']);
  });
  it('is the lane alone once local-only', () => {
    expect(inquiryWarehouses('GB', ['GB'])).toEqual(['GB']);
  });
  it('is empty for a country with no lane', () => {
    expect(inquiryWarehouses('NG')).toEqual([]);
  });
});

describe('laneRouteFor', () => {
  it('routes a China-only item overseas with the product-page band', async () => {
    const store = await seededStore();
    const r = await laneRouteFor(store, CFG, { CN: 5429 }, 'GB');
    const l = resolveLogistics(DEFAULT_FULFIL);
    const route = await store.getLogisticsRoute('CN', 'GB', l.stalenessHours);
    expect(r).toEqual({ origin: 'CN', overseas: true, days: formatBand(doorToDoorBand(route, l)) });
    expect(r?.days).toMatch(/^\d+-\d+$/);
  });
  it('prefers local stock when the item is stocked both locally and in China', async () => {
    const store = await seededStore();
    const r = await laneRouteFor(store, CFG, { GB: 40, CN: 900 }, 'GB');
    expect(r?.origin).toBe('GB');
    expect(r?.overseas).toBe(false);
  });
  it('routes overseas when local stock is below the stock floor and only China can fill it', async () => {
    const store = await seededStore();
    const r = await laneRouteFor(store, CFG, { GB: 2, CN: 900 }, 'GB');
    expect(r?.origin).toBe('CN');
    expect(r?.overseas).toBe(true);
  });
  it('is null when no warehouse meets the stock floor', async () => {
    const store = await seededStore();
    expect(await laneRouteFor(store, CFG, { GB: 2, CN: 3 }, 'GB')).toBeNull();
  });
  it('is null when no route exists to the destination', async () => {
    const store = await seededStore();
    expect(await laneRouteFor(store, CFG, { CN: 5429 }, 'AU')).toBeNull();
  });
  it('is null for a country with no lane', async () => {
    const store = await seededStore();
    expect(await laneRouteFor(store, CFG, { CN: 5429 }, 'NG')).toBeNull();
  });
});

describe('overseasClickPlan (storefront overseas click)', () => {
  const DETAIL = { pid: 'T1', nameEn: 'Pet GPS Tracker', images: [], descriptionHtml: '', variants: [], listedNum: 1, categoryName: 'Pet', origins: { CN: 5000 } } as unknown as CjDetail;
  function cjWith(live: Record<string, number> | 'error', calls: string[] = []): CjClient {
    return { originsByPid: async (pid: string) => { calls.push(pid); if (live === 'error') throw new Error('CJ 500'); return live; } } as unknown as CjClient;
  }

  it('leaves an ordinary click alone, with no CJ call', async () => {
    const store = await seededStore();
    const calls: string[] = [];
    const plan = await overseasClickPlan(store, cjWith({ CN: 900 }, calls), CFG, DETAIL, 'GB', undefined);
    expect(plan).toEqual({ localWarehouses: undefined, detail: DETAIL, delivery: undefined });
    expect(calls).toEqual([]);
  });

  it('widens to lane plus CN only after live stock and a fresh China route, and imports on the live origins', async () => {
    const store = await seededStore();
    const plan = await overseasClickPlan(store, cjWith({ CN: 900 }), CFG, DETAIL, 'gb', '1');
    expect(plan.localWarehouses).toEqual(['GB', 'CN']);
    expect(plan.detail.origins).toEqual({ CN: 900 });
    expect(plan.delivery?.overseas).toBe(true);
    expect(plan.delivery?.days).toMatch(/^\d+-\d+$/);
  });

  it('keeps the home lane when China no longer has the stock, whatever the cache says', async () => {
    const store = await seededStore();
    const plan = await overseasClickPlan(store, cjWith({ CN: 0 }), CFG, DETAIL, 'GB', '1');
    expect(plan.localWarehouses).toBeUndefined();
    expect(plan.delivery).toBeNull();
    expect(plan.detail.origins).toEqual({ CN: 0 });
  });

  it('keeps the home lane when no China route reaches the buyer', async () => {
    const store = await seededStore();
    const plan = await overseasClickPlan(store, cjWith({ CN: 900 }), CFG, DETAIL, 'AU', '1');
    expect(plan.localWarehouses).toBeUndefined();
    expect(plan.delivery).toBeNull();
  });

  it('keeps the home lane when live stock cannot be read', async () => {
    const store = await seededStore();
    const plan = await overseasClickPlan(store, cjWith('error'), CFG, DETAIL, 'GB', '1');
    expect(plan.localWarehouses).toBeUndefined();
    expect(plan.delivery).toBeNull();
    expect(plan.detail).toBe(DETAIL);
  });

  it('prices the overseas preview with the card freight, and leaves the import to quote freight live', async () => {
    const store = await seededStore();
    const plan = await overseasClickPlan(store, cjWith({ CN: 900 }), CFG, DETAIL, 'GB', '1');
    expect(plan.previewFreightUsd).toBe(4);
    // The import detail carries no freight, so confirmAndImport still asks CJ.
    expect(plan.detail.freightUsd).toBeUndefined();
  });

  it('adds no preview freight to a click served from local stock', async () => {
    const store = await seededStore();
    const plan = await overseasClickPlan(store, cjWith({ GB: 40 }), CFG, DETAIL, 'GB', '1');
    expect(plan.delivery?.overseas).toBe(false);
    expect(plan.previewFreightUsd).toBeUndefined();
  });

  it('ignores a malformed country or one with no lane', async () => {
    const store = await seededStore();
    expect((await overseasClickPlan(store, cjWith({ CN: 900 }), CFG, DETAIL, 'not a country', '1')).localWarehouses).toBeUndefined();
    expect((await overseasClickPlan(store, cjWith({ CN: 900 }), CFG, DETAIL, 'NG', '1')).localWarehouses).toBeUndefined();
  });
});
