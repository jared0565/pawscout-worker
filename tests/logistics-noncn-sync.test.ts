/**
 * Tests for non-CN origin logistics sync (Task 20).
 *
 * Covers:
 *  - catalogNonCnOrigins: distinct non-CN ISO-2 codes with stock > 0
 *  - sampleWarehouseDetailsForOrigin: filters to rows with that origin stocked
 *  - freightQuoteAging: keeps price-0 options that freightQuote drops
 *  - syncCjLogisticsRoutes with allowInMarket:true -> upserts in-market row
 *  - syncCjLogisticsRoutes with default opts -> still skips in-market dest
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { syncCjLogisticsRoutes } from '../src/jobs';
import { CjClient } from '../src/cj';
import type { CjDetail } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const noPause = async () => {};
type Opt = { priceUsd: number; days: string; name: string };

// --- helpers ----------------------------------------------------------------

function makeDetail(origins: Record<string, number>, vids: string[] = ['v1']): string {
  const detail: Partial<CjDetail> & { origins: Record<string, number> } = {
    pid: `pid-${Math.random().toString(36).slice(2)}`,
    title: 'Test Product',
    origins,
    variants: vids.map((vid) => ({ vid, variantNameEn: vid, name: vid, price: 9.99, stock: 5, sellPrice: 9.99, sellPriceUsd: 9.99, variantSellPrice: 9.99, sku: `sku-${vid}`, countryCode: Object.keys(origins)[0] ?? 'CN' })) as CjDetail['variants'],
    images: [],
    stock: 5,
  } as unknown as Partial<CjDetail> & { origins: Record<string, number> };
  return JSON.stringify(detail);
}

async function seedWarehouseRow(store: TenantStore, detailJson: string, listedNum = 100): Promise<void> {
  const d = JSON.parse(detailJson);
  const now = new Date().toISOString();
  await (env.DB as D1Database).prepare(
    `INSERT INTO warehouse_products (shop, cj_pid, category, title, detail, price_usd, listed_num, stock, search_text, status, fetched_at, stock_checked_at, created_at)
     VALUES (?1, ?2, 'pets', ?3, ?4, 9.99, ?5, 5, ?3, 'available', ?6, ?6, ?6)`
  ).bind((store as unknown as { shop: string }).shop, d.pid, d.title, detailJson, listedNum, now).run();
}

// --- catalogNonCnOrigins ---------------------------------------------------

describe('catalogNonCnOrigins', () => {
  it('returns distinct non-CN origins with stock > 0', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await seedWarehouseRow(store, makeDetail({ CN: 1000, US: 50 }));
    await seedWarehouseRow(store, makeDetail({ CN: 500 }));
    const result = await store.catalogNonCnOrigins();
    expect(result).toEqual(['US']);
  });

  it('ignores origins with stock 0', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await seedWarehouseRow(store, makeDetail({ CN: 0, US: 0 }));
    const result = await store.catalogNonCnOrigins();
    expect(result).toEqual([]);
  });

  it('returns empty array when no warehouse rows', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const result = await store.catalogNonCnOrigins();
    expect(result).toEqual([]);
  });

  it('scopes to the shop (does not bleed across tenants)', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    const b = new TenantStore(env.DB, 'b.myshopify.com');
    await seedWarehouseRow(a, makeDetail({ US: 30 }));
    expect(await b.catalogNonCnOrigins()).toEqual([]);
  });
});

// --- sampleWarehouseDetailsForOrigin ---------------------------------------

describe('sampleWarehouseDetailsForOrigin', () => {
  it('returns details for rows with the given origin stocked', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const usDetail = makeDetail({ US: 50, CN: 1000 });
    const cnOnlyDetail = makeDetail({ CN: 500 });
    await seedWarehouseRow(store, usDetail, 200);
    await seedWarehouseRow(store, cnOnlyDetail, 100);
    const results = await store.sampleWarehouseDetailsForOrigin('US', 10);
    expect(results.length).toBe(1);
    const parsed = JSON.parse(results[0]);
    expect(parsed.origins.US).toBeGreaterThan(0);
  });

  it('excludes rows where origin stock is 0', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await seedWarehouseRow(store, makeDetail({ US: 0, CN: 100 }));
    const results = await store.sampleWarehouseDetailsForOrigin('US', 10);
    expect(results.length).toBe(0);
  });

  it('respects the limit parameter', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    for (let i = 0; i < 5; i++) {
      await seedWarehouseRow(store, makeDetail({ US: 10 + i }), 100 - i);
    }
    const results = await store.sampleWarehouseDetailsForOrigin('US', 3);
    expect(results.length).toBe(3);
  });
});

// --- freightQuoteAging (on CjClient) --------------------------------------

describe('freightQuoteAging vs freightQuote', () => {
  function clientWith(rows: unknown[]): CjClient {
    const fakeFetch = (async (_input: RequestInfo | URL) => {
      return new Response(JSON.stringify({ result: true, data: rows }), { status: 200 });
    }) as typeof fetch;
    return new CjClient(async () => 'tok', fakeFetch);
  }

  it('freightQuoteAging keeps price-0 options that freightQuote drops', async () => {
    const zeroRow = { logisticPrice: '0', logisticAging: '3-5', logisticName: 'USPS' };
    const client = clientWith([zeroRow]);

    const agingResults = await client.freightQuoteAging('vid1', 'US', 'US', 1);
    expect(agingResults.length).toBe(1);
    expect(agingResults[0].priceUsd).toBe(0);
    expect(agingResults[0].days).toBe('3-5');
    expect(agingResults[0].name).toBe('USPS');
  });

  it('freightQuote drops the price-0 option (confirming the contrast)', async () => {
    const zeroRow = { logisticPrice: '0', logisticAging: '3-5', logisticName: 'USPS' };
    const client = clientWith([zeroRow]);

    const quoteResults = await client.freightQuote('vid1', 'US', 'US', 1);
    expect(quoteResults.length).toBe(0);
  });

  it('freightQuoteAging still sorts by priceUsd ascending (paid options first)', async () => {
    const rows = [
      { logisticPrice: '5.00', logisticAging: '5-7', logisticName: 'FedEx' },
      { logisticPrice: '0', logisticAging: '3-5', logisticName: 'USPS' },
      { logisticPrice: '2.50', logisticAging: '4-6', logisticName: 'UPS' },
    ];
    const client = clientWith(rows);
    const results = await client.freightQuoteAging('vid1', 'US', 'US', 1);
    expect(results.length).toBe(3);
    // sorted by priceUsd asc: 0, 2.50, 5.00
    expect(results[0].priceUsd).toBe(0);
    expect(results[1].priceUsd).toBe(2.50);
    expect(results[2].priceUsd).toBe(5);
  });
});

// --- syncCjLogisticsRoutes with allowInMarket --------------------------------

describe('syncCjLogisticsRoutes allowInMarket', () => {
  function fakeQuoteWith(handler: (from: string, to: string) => Opt[] | Error): (vid: string, from: string, to: string, qty: number) => Promise<Opt[]> {
    return async (_vid: string, from: string, to: string) => {
      const r = handler(from, to);
      if (r instanceof Error) throw r;
      return r;
    };
  }

  it('upserts an in-market row when allowInMarket:true', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const mockQuote = fakeQuoteWith((_from, _to) => [{ priceUsd: 0, days: '3-5', name: 'USPS' }]);

    // Pass from='US', dest list includes 'US' (in-market) + 'GB' (cross-border)
    const res = await syncCjLogisticsRoutes(
      [store], store,
      { freightQuote: async () => [] } as unknown as CjClient, // not used (quote override provided)
      'vRep',
      ['US', 'GB'],
      { from: 'US', allowInMarket: true, quote: mockQuote, pause: noPause }
    );

    expect(res.refreshed).toBe(2); // US->US + US->GB both synced
    const usUs = await store.getLogisticsRoute('US', 'US', 72);
    expect(usUs).not.toBeNull();
    expect(usUs!.transit_min).toBe(3);
    expect(usUs!.transit_max).toBe(5);
    expect(usUs!.channel).toBe('USPS');

    const usGb = await store.getLogisticsRoute('US', 'GB', 72);
    expect(usGb).not.toBeNull();
  });

  it('still skips in-market dest when allowInMarket is false (default)', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const mockQuote = fakeQuoteWith((_from, _to) => [{ priceUsd: 0, days: '3-5', name: 'USPS' }]);

    // Default allowInMarket (false) -- from='CN', dest list includes 'CN'
    const cj: Pick<CjClient, 'freightQuote'> = { freightQuote: async () => [{ priceUsd: 3, days: '4-9', name: 'CJPacket' }] };
    const res = await syncCjLogisticsRoutes(
      [store], store, cj, 'vRep', ['CN', 'GB'],
      { from: 'CN', quote: mockQuote, pause: noPause }
    );

    // CN->CN is skipped; CN->GB is synced
    expect(res.refreshed).toBe(1);
    expect(await store.getLogisticsRoute('CN', 'CN', 72)).toBeNull();
    expect(await store.getLogisticsRoute('CN', 'GB', 72)).not.toBeNull();
  });
});
