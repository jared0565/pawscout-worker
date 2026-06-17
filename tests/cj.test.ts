import { describe, it, expect } from 'vitest';
import { validateCjKey } from '../src/cj';

describe('validateCjKey', () => {
  it('returns ok when CJ auth succeeds', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ result: true, data: { accessToken: 'tok' } }), { status: 200 });
    expect(await validateCjKey('CJemail@api@token', fakeFetch as typeof fetch)).toEqual({ ok: true });
  });

  it('returns an error when CJ rejects the key', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ result: false, message: 'bad key' }), { status: 200 });
    const r = await validateCjKey('bad', fakeFetch as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('bad key');
  });

  it('returns an error on a non-200', async () => {
    const fakeFetch = async () => new Response('nope', { status: 500 });
    expect((await validateCjKey('x', fakeFetch as typeof fetch)).ok).toBe(false);
  });
});

import { CjClient } from '../src/cj';

function clientWith(responder: (url: string) => unknown): { client: CjClient; urls: string[] } {
  const urls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return new Response(JSON.stringify({ result: true, data: responder(url) }), { status: 200 });
  }) as typeof fetch;
  return { client: new CjClient(async () => 'tok', fakeFetch), urls };
}

describe('CjClient stock endpoints (post-rename)', () => {
  it('detail requests enable_inventory and reads per-variant inventories (max single origin)', async () => {
    const { client, urls } = clientWith(() => ({
      pid: 'P1',
      productNameEn: 'Toy',
      productImage: 'https://i/1.jpg',
      variants: [{
        vid: 'v1', variantNameEn: 'Default', variantSellPrice: 5, variantSku: 'sku1',
        inventories: [
          { countryCode: 'CN', totalInventory: 120, cjInventory: 0, factoryInventory: 120 },
          { countryCode: 'US', totalInventory: 30, cjInventory: 30, factoryInventory: 0 }
        ]
      }]
    }));
    const d = await client.detail('P1');
    expect(urls[0]).toContain('/product/query?');
    expect(urls[0]).toContain('features=enable_inventory');
    expect(d?.variants[0].stock).toBe(120); // max across origins, never the sum
    expect(d?.stock).toBe(120);
  });

  it('stockByPid calls getInventoryByPid (queryByPid is dead) and folds vid-less warehouse rows', async () => {
    const { client, urls } = clientWith(() => ([
      { areaEn: 'CN warehouse', countryCode: 'CN', totalInventoryNum: 80 },
      { areaEn: 'US warehouse', countryCode: 'US', totalInventoryNum: 25 }
    ]));
    const m = await client.stockByPid('P1');
    expect(urls[0]).toContain('/product/stock/getInventoryByPid?');
    expect(Math.max(...m.values())).toBe(80); // product-level: max single warehouse
  });

  it('stockByPid still understands the legacy per-vid rows', async () => {
    const { client } = clientWith(() => ([
      { vid: 'v1', storageNum: 10 },
      { vid: 'v1', storageNum: 5 },
      { vid: 'v2', storageNum: 7 }
    ]));
    const m = await client.stockByPid('P1');
    expect(m.get('v1')).toBe(15);
    expect(m.get('v2')).toBe(7);
  });
});

import { chooseOrigin } from '../src/cj';
import type { CjDetail } from '../src/cj';

describe('origins + freight', () => {
  const base: CjDetail = {
    pid: 'P', nameEn: 'T', images: [], descriptionHtml: '', listedNum: 1,
    categoryName: 'c', variants: [{ vid: 'v1', name: 'D', sellPriceUsd: 5, sku: 's1' }]
  };

  it('chooseOrigin prefers a UK warehouse that can genuinely fulfil', () => {
    expect(chooseOrigin({ ...base, origins: { CN: 5000, GB: 40 } }, 10)).toBe('GB');
    expect(chooseOrigin({ ...base, origins: { CN: 5000, GB: 3 } }, 10)).toBe('CN'); // GB under floor
    expect(chooseOrigin({ ...base, origins: { US: 900, CN: 100 } }, 10)).toBe('US'); // best stocked
    expect(chooseOrigin(base, 10)).toBe('CN'); // no data → CN default
  });

  it('detail aggregates per-country origins across variants', async () => {
    const { client } = clientWith(() => ({
      pid: 'P1', productNameEn: 'Toy', productImage: 'https://i/1.jpg',
      variants: [
        { vid: 'v1', variantSellPrice: 5, variantSku: 's1', inventories: [{ countryCode: 'CN', totalInventory: 100 }, { countryCode: 'GB', totalInventory: 12 }] },
        { vid: 'v2', variantSellPrice: 6, variantSku: 's2', inventories: [{ countryCode: 'CN', totalInventory: 300 }] }
      ]
    }));
    const d = await client.detail('P1');
    expect(d?.origins).toEqual({ CN: 300, GB: 12 });
  });

  it('freightEstimate POSTs to freightCalculate and returns the cheapest option', async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      expect(String(input)).toContain('/logistic/freightCalculate');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ result: true, data: [
        { logisticName: 'CJPacket', logisticPrice: 6.5, logisticAging: '8-12' },
        { logisticName: 'Economy', logisticPrice: '4.20', logisticAging: '12-20' }
      ] }), { status: 200 });
    }) as typeof fetch;
    const client = new CjClient(async () => 'tok', fakeFetch);
    const f = await client.freightEstimate('v1', 'CN');
    expect(f).toEqual({ priceUsd: 4.2, days: '12-20', name: 'Economy' });
    expect(bodies[0]).toContain('"startCountryCode":"CN"');
    expect(bodies[0]).toContain('"endCountryCode":"GB"'); // defaults to the home market
  });

  it('freightQuote returns every line cheapest-first for an arbitrary destination', async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      expect(String(input)).toContain('/logistic/freightCalculate');
      return new Response(JSON.stringify({ result: true, data: [
        { logisticName: 'CJPacket', logisticPrice: 6.5, logisticAging: '8-12' },
        { logisticName: 'Economy', logisticPrice: '4.20', logisticAging: '12-20' },
        { logisticName: 'Broken', logisticPrice: 0, logisticAging: '' }
      ] }), { status: 200 });
    }) as typeof fetch;
    const client = new CjClient(async () => 'tok', fakeFetch);
    const opts = await client.freightQuote('v1', 'CN', 'ES');
    expect(opts.map((o) => o.name)).toEqual(['Economy', 'CJPacket']); // cheapest first, zero-priced dropped
    expect(opts[0]).toEqual({ priceUsd: 4.2, days: '12-20', name: 'Economy' });
    expect(bodies[0]).toContain('"startCountryCode":"CN"');
    expect(bodies[0]).toContain('"endCountryCode":"ES"'); // the real destination, not GB
  });
});

describe('CjClient.search — listV2 first (real shape: id, nameEn, content[].productList)', () => {
  it('parses listV2 results and uses the `id` field as pid (the fallback bug)', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/product/listV2')) {
        return new Response(JSON.stringify({
          result: true,
          data: { content: [{ productList: [
            { id: '111', nameEn: 'Herding Ball for Dogs', bigImage: 'https://i/d.jpg', sellPrice: '9.00', listedNum: 3, threeCategoryName: 'Dog Toys' }
          ] }] }
        }), { status: 200 });
      }
      // legacy fallback should NOT be reached
      return new Response(JSON.stringify({ result: true, data: { list: [{ pid: 'JUNK', productNameEn: 'Advent Calendar Toys' }] } }), { status: 200 });
    }) as typeof fetch;
    const cj = new CjClient(async () => 'tok', fakeFetch);
    const items = await cj.search('dog toy');
    expect(urls[0]).toContain('/product/listV2');
    expect(urls[0]).toContain('orderBy=0');
    expect(urls[0]).toContain('page=1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ pid: '111', nameEn: 'Herding Ball for Dogs', sellPriceUsd: 9, listedNum: 3 });
    expect(urls.some((u) => u.includes('/product/list?'))).toBe(false); // never fell back
  });

  it('falls back to /product/list only when listV2 is empty', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/product/listV2')) {
        return new Response(JSON.stringify({ result: true, data: { content: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: true, data: { list: [{ pid: 'L1', productNameEn: 'Dog Rope', sellPrice: '7' }] } }), { status: 200 });
    }) as typeof fetch;
    const cj = new CjClient(async () => 'tok', fakeFetch);
    const items = await cj.search('dog toy');
    expect(items.map((i) => i.pid)).toEqual(['L1']);
    expect(urls.some((u) => u.includes('/product/list?'))).toBe(true);
  });
});
