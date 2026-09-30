import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { laneRouteFor } from '../src/sourcing/lane-route';
import { allowedOriginsFor, inquiryWarehouses } from '../src/local-markets';
import { resolveLogistics, doorToDoorBand, formatBand } from '../src/logistics';
import { DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG = { fulfil: DEFAULT_FULFIL } as unknown as TenantConfig;

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
  it('is null when no route exists to the destination', async () => {
    const store = await seededStore();
    expect(await laneRouteFor(store, CFG, { CN: 5429 }, 'AU')).toBeNull();
  });
  it('is null for a country with no lane', async () => {
    const store = await seededStore();
    expect(await laneRouteFor(store, CFG, { CN: 5429 }, 'NG')).toBeNull();
  });
});
