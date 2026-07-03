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

/** Full-envelope variant of clientWith: the responder returns the ENTIRE body,
 * for CJ's 2026-07-03 {success} envelope (no `result` field at all). */
function clientWithEnvelope(responder: (url: string) => unknown): CjClient {
  const fakeFetch = (async (input: RequestInfo | URL) =>
    new Response(JSON.stringify(responder(String(input))), { status: 200 })) as typeof fetch;
  return new CjClient(async () => 'tok', fakeFetch);
}

describe('CjClient 2026-07-03 success-envelope (result field dropped)', () => {
  // Fixture captured LIVE from getInventoryByPid on 2026-07-03 (elevated dog
  // bed, GB warehouse) - the envelope has success/code but NO result, and data
  // is an object, not rows.
  const LIVE_SHAPE = {
    success: true, code: 200, message: '',
    data: {
      inventories: [{ areaEn: 'Britain Warehouse', areaId: 17, countryCode: 'GB', totalInventoryNum: 35, cjInventoryNum: 35, factoryInventoryNum: 0 }],
      variantInventories: [{ vid: '1864515923999608832', inventory: [{ countryCode: 'GB', totalInventory: 35, cjInventory: 35, factoryInventory: 0 }] }]
    },
    requestId: 'r1'
  };

  it('stockByPid parses the new object shape (per-variant, summed across warehouses)', async () => {
    const client = clientWithEnvelope(() => LIVE_SHAPE);
    const m = await client.stockByPid('P1');
    expect(m.get('1864515923999608832')).toBe(35);
  });

  it('sums multi-warehouse variant inventory', async () => {
    const client = clientWithEnvelope(() => ({
      success: true, code: 200,
      data: { variantInventories: [{ vid: 'v1', inventory: [{ countryCode: 'GB', totalInventory: 35 }, { countryCode: 'CN', totalInventory: 10 }] }] }
    }));
    const m = await client.stockByPid('P1');
    expect(m.get('v1')).toBe(45);
  });

  it('falls back to a product-level * entry when only inventories rows exist', async () => {
    const client = clientWithEnvelope(() => ({
      success: true, code: 200,
      data: { inventories: [{ countryCode: 'GB', totalInventoryNum: 20 }, { countryCode: 'CN', totalInventoryNum: 5 }] }
    }));
    const m = await client.stockByPid('P1');
    expect(m.get('*')).toBe(25);
  });

  it('a success:false envelope still throws with the CJ code', async () => {
    const client = clientWithEnvelope(() => ({ success: false, code: 1600100, message: 'quota exceeded' }));
    await expect(client.stockByPid('P1')).rejects.toThrow(/quota exceeded.*1600100/);
  });

  it('the legacy result:true envelope keeps working (other endpoints unchanged)', async () => {
    const client = clientWithEnvelope(() => ({ result: true, data: [{ vid: 'v1', storageNum: 9 }] }));
    const m = await client.stockByPid('P1');
    expect(m.get('v1')).toBe(9);
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

  it('freightQuote sends the requested quantity (defaults to 1)', async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ result: true, data: [
        { logisticName: 'Economy', logisticPrice: '4.20', logisticAging: '12-20' }
      ] }), { status: 200 });
    }) as typeof fetch;
    const client = new CjClient(async () => 'tok', fakeFetch);
    await client.freightQuote('v9', 'CN', 'ES', 3);
    await client.freightQuote('v9', 'CN', 'ES');
    expect(bodies[0]).toContain('"quantity":3');
    expect(bodies[0]).toContain('"vid":"v9"');
    expect(bodies[1]).toContain('"quantity":1'); // default
  });

  it('freightEstimate returns the $0 domestic option (GB->GB) instead of null', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      result: true,
      data: [{ logisticName: 'Royal Mail GB to GB', logisticAging: '2-5', logisticPrice: 0 }]
    }), { status: 200 })) as unknown as typeof fetch;
    const cj = new CjClient(async () => 'tok', fakeFetch);

    const est = await cj.freightEstimate('V1', 'GB', 'GB');

    expect(est).not.toBeNull();
    expect(est!.priceUsd).toBe(0);
    expect(est!.days).toBe('2-5');
  });

  it('freightEstimate (CN->GB cross-border) drops the spurious $0 row and returns the cheapest non-zero option', async () => {
    // CJ sometimes returns a logisticPrice:0 row for a service that does not actually carry
    // the shipment on cross-border routes; keeping it would zero freightUsd and undercut the margin floor.
    const fakeFetch = (async () => new Response(JSON.stringify({
      result: true,
      data: [
        { logisticName: 'Spurious', logisticAging: '99', logisticPrice: 0 },
        { logisticName: 'Economy', logisticAging: '12-20', logisticPrice: '4.20' },
        { logisticName: 'CJPacket', logisticAging: '8-12', logisticPrice: 6.5 }
      ]
    }), { status: 200 })) as unknown as typeof fetch;
    const cj = new CjClient(async () => 'tok', fakeFetch);

    const est = await cj.freightEstimate('V', 'CN', 'GB');

    // $0 option must be dropped; cheapest non-zero option returned
    expect(est).not.toBeNull();
    expect(est!.priceUsd).toBe(4.2);
    expect(est!.name).toBe('Economy');
  });
});

describe('CjClient.searchByWarehouse', () => {
  it('searchByWarehouse queries /product/list with the warehouse countryCode', async () => {
    let calledUrl = '';
    const fakeFetch = (async (url: string) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({
        result: true,
        data: { total: 1, list: [{ pid: 'P1', productNameEn: 'Dog Nail Clipper', sellPrice: '5.99', listedNum: 42 }] }
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const cj = new CjClient(async () => 'tok', fakeFetch);

    const items = await cj.searchByWarehouse('nail clipper', 'GB', 50);

    expect(calledUrl).toContain('/product/list');
    expect(calledUrl).toContain('countryCode=GB');
    expect(calledUrl).toContain('productNameEn=nail+clipper');
    expect(items).toEqual([{ pid: 'P1', nameEn: 'Dog Nail Clipper', image: '', sellPriceUsd: 5.99, listedNum: 42, categoryName: '', topCategory: '' }]);
  });
});

describe('CjClient.search - listV2 first (real shape: id, nameEn, content[].productList)', () => {
  it('parses listV2 results and uses the `id` field as pid (the fallback bug)', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/product/listV2')) {
        return new Response(JSON.stringify({
          result: true,
          data: { content: [{ productList: [
            { id: '111', nameEn: 'Herding Ball for Dogs', bigImage: 'https://i/d.jpg', sellPrice: '9.00', listedNum: 3, threeCategoryName: 'Dog Toys', oneCategoryName: 'Pet Supplies' }
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
    expect(urls[0]).toContain('features=enable_category'); // populates oneCategoryName for the pet-category gate
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ pid: '111', nameEn: 'Herding Ball for Dogs', sellPriceUsd: 9, listedNum: 3, topCategory: 'Pet Supplies' });
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
