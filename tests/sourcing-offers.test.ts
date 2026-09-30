import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { supplierOffers } from '../src/sourcing/offers';
import { retailPriceGbp } from '../src/pricing';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail, CjSearchItem } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG = { pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, fulfil: DEFAULT_FULFIL } as unknown as TenantConfig;
const noPause = async () => {};

function det(pid: string, nameEn: string, origins: Record<string, number>, usd = 12): CjDetail {
  return { pid, nameEn, images: [`https://i/${pid}.jpg`], descriptionHtml: '<p>GPS unit clips to the collar.</p>', variants: [{ vid: `${pid}-v`, name: 'Black', sellPriceUsd: usd, sku: `${pid}-SKU` }], listedNum: 10, categoryName: 'Pet', origins };
}
const item = (d: CjDetail): CjSearchItem => ({ pid: d.pid, nameEn: d.nameEn, image: d.images[0], sellPriceUsd: d.variants[0].sellPriceUsd, listedNum: d.listedNum, categoryName: 'Pet' });

const TRACKER = det('T1', 'Smart GPS Wireless Pet Tracker', { CN: 5429 });
const LOCAL_COLLAR = det('C1', 'Dog Collar GPS Tracker Holder', { GB: 40, CN: 900 });
const THIN = det('T2', 'Pet GPS Tracker Mini', { CN: 3 });
const NECKLACE = det('N1', 'Love Pendant Necklace', { CN: 999 });
const BRANDED = { ...det('B1', 'PawHut Pet GPS Tracker', { CN: 800 }), descriptionHtml: '<p>PawHut quality tracker.</p>' };

/** `live` overrides the stock by warehouse CJ reports NOW (the detail's own
 *  origins may be up to 30 days old in the cache). */
function fakeCj(details: CjDetail[], calls: string[] = [], live: Record<string, Record<string, number>> = {}): CjClient {
  const byPid = new Map(details.map((d) => [d.pid, d]));
  return {
    search: async (kw: string) => { calls.push(`search:${kw}`); return details.map(item); },
    detail: async (pid: string) => { calls.push(`detail:${pid}`); return byPid.get(pid) ?? null; },
    detailBySku: async (sku: string) => { calls.push(`sku:${sku}`); return sku === 'CJPC262132401AZ' ? TRACKER : null; },
    originsByPid: async (pid: string) => { calls.push(`origins:${pid}`); return live[pid] ?? byPid.get(pid)?.origins ?? {}; },
    freightEstimate: async () => ({ priceUsd: 4, days: '5-9', name: 'CJPacket' }),
  } as unknown as CjClient;
}

async function seededStore() {
  const store = new TenantStore(env.DB, 'a.myshopify.com');
  await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v', freightCostUsd: 4 });
  await store.upsertLogisticsRoute({ from: 'GB', to: 'GB', channel: 'UK Local', transitMin: 1, transitMax: 3, agingRaw: '1-3', repVid: 'v', freightCostUsd: 3 });
  return store;
}

describe('supplierOffers', () => {
  it('offers a China-only item overseas with the import price and a delivery band', async () => {
    const store = await seededStore();
    const offers = await supplierOffers(store, fakeCj([TRACKER]), CFG, 'gps tracker dog collar', 'GB', { limit: 3, pause: noPause });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ pid: 'T1', overseas: true, origin: 'CN', handle: null });
    expect(offers[0].priceGbp).toBe(retailPriceGbp(12, DEFAULT_PRICING, 4));
    expect(offers[0].days).toMatch(/^\d+-\d+$/);
    expect(offers[0].descriptionText).toContain('GPS unit');
  });

  it('offers an item stocked locally as local', async () => {
    const store = await seededStore();
    const offers = await supplierOffers(store, fakeCj([LOCAL_COLLAR]), CFG, 'gps dog collar', 'GB', { limit: 3, pause: noPause });
    expect(offers[0]).toMatchObject({ pid: 'C1', overseas: false, origin: 'GB' });
  });

  it('skips China stock below the stock floor', async () => {
    const store = await seededStore();
    expect(await supplierOffers(store, fakeCj([THIN]), CFG, 'gps tracker', 'GB', { limit: 3, pause: noPause })).toEqual([]);
  });

  it('drops a result that is not a pet product', async () => {
    const store = await seededStore();
    expect(await supplierOffers(store, fakeCj([NECKLACE]), CFG, 'love pendant', 'GB', { limit: 3, pause: noPause })).toEqual([]);
  });

  it('looks a pasted SKU up directly instead of searching', async () => {
    const store = await seededStore();
    const calls: string[] = [];
    const offers = await supplierOffers(store, fakeCj([TRACKER], calls), CFG, ' cjpc262132401az ', 'GB', { limit: 3, pause: noPause });
    expect(offers[0]?.pid).toBe('T1');
    expect(calls).toContain('sku:CJPC262132401AZ');
    expect(calls.some((c) => c.startsWith('search:'))).toBe(false);
  });

  it('offers nothing where no China route reaches the buyer', async () => {
    const store = await seededStore();
    expect(await supplierOffers(store, fakeCj([TRACKER]), CFG, 'gps tracker', 'AU', { limit: 3, pause: noPause })).toEqual([]);
  });

  it('offers nothing to a country with no lane', async () => {
    const store = await seededStore();
    expect(await supplierOffers(store, fakeCj([TRACKER]), CFG, 'gps tracker', 'NG', { limit: 3, pause: noPause })).toEqual([]);
  });

  it('links an item that is already imported', async () => {
    const store = await seededStore();
    await store.putLink({ cjPid: 'T1', state: 'imported', handle: 'smart-gps-pet-tracker' });
    const offers = await supplierOffers(store, fakeCj([TRACKER]), CFG, 'gps tracker', 'GB', { limit: 3, pause: noPause });
    expect(offers[0]?.handle).toBe('smart-gps-pet-tracker');
  });

  it('judges stock on CJ live origins, not the cached detail', async () => {
    const store = await seededStore();
    const calls: string[] = [];
    const offers = await supplierOffers(store, fakeCj([TRACKER], calls, { T1: { CN: 0 } }), CFG, 'gps tracker', 'GB', { limit: 3, pause: noPause });
    expect(offers).toEqual([]);
    expect(calls).toContain('origins:T1');
  });

  it('skips an item whose live stock cannot be read', async () => {
    const store = await seededStore();
    const cj = fakeCj([TRACKER]);
    (cj as unknown as { originsByPid: () => Promise<never> }).originsByPid = async () => { throw new Error('CJ 500'); };
    expect(await supplierOffers(store, cj, CFG, 'gps tracker', 'GB', { limit: 3, pause: noPause })).toEqual([]);
  });

  it('strips maker brands from the title and the supplier notes', async () => {
    const store = await seededStore();
    const offers = await supplierOffers(store, fakeCj([BRANDED]), CFG, 'gps tracker', 'GB', { limit: 3, pause: noPause });
    expect(offers[0]?.title).not.toContain('PawHut');
    expect(offers[0]?.descriptionText).not.toContain('PawHut');
  });

  it('keeps CJ relevance order when two items answer the query equally well', async () => {
    // Aloha: the tracker and a far more popular plain collar each carry one of
    // the query words; CJ ranks the tracker first, and popularity must not flip it.
    const store = await seededStore();
    const plain = { ...det('P1', 'Adjustable Nylon Dog Collar', { CN: 700 }), listedNum: 5000 };
    const offers = await supplierOffers(store, fakeCj([TRACKER, plain]), CFG, 'trackable dog collar', 'GB', { limit: 1, pause: noPause });
    expect(offers.map((o) => o.pid)).toEqual(['T1']);
  });
});
