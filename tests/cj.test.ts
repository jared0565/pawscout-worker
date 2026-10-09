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

import { CjClient, looksLikeCjSku, diagOrderId } from '../src/cj';

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

  it('detail falls back to variantKey when variantNameEn is an EMPTY string (live 2026-07-03: slip-on water bottle)', async () => {
    const { client } = clientWith(() => ({
      pid: 'P2', productNameEn: 'Bottle', productImage: 'https://i/2.jpg',
      variants: [
        { vid: 'v1', variantNameEn: '', variantKey: 'Green', variantSellPrice: 2, variantSku: 's1' },
        { vid: 'v2', variantNameEn: '', variantKey: 'Pink', variantSellPrice: 2, variantSku: 's2' },
        { vid: 'v3', variantSellPrice: 2, variantSku: 's3' } // nothing at all -> Default
      ]
    }));
    const d = await client.detail('P2');
    expect(d?.variants.map((v) => v.name)).toEqual(['Green', 'Pink', 'Default']);
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

  // Owner rule 2026-09-22: freight is always counter-checked against LIVE CJ
  // data before an order is booked. The pipeline used to quote one unit of the
  // first line to the default destination (GB) whatever the order was; the
  // counter-check needs the whole basket, every quantity, to the real country.
  it('freightForBasket POSTs every line with its quantity to the real destination and returns the cheapest option', async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      expect(String(input)).toContain('/logistic/freightCalculate');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ result: true, data: [
        { logisticName: 'CJPacket', logisticPrice: 11.5, logisticAging: '8-12' },
        { logisticName: 'Economy', logisticPrice: '9.80', logisticAging: '12-20' },
        { logisticName: 'Spurious', logisticPrice: 0, logisticAging: '' }
      ] }), { status: 200 });
    }) as typeof fetch;
    const client = new CjClient(async () => 'tok', fakeFetch);
    const f = await client.freightForBasket([{ vid: 'v1', quantity: 3 }, { vid: 'v2', quantity: 1 }], 'CN', 'US');
    expect(f).toEqual({ priceUsd: 9.8, days: '12-20', name: 'Economy' }); // cheapest real option; the $0 row is not a cross-border carrier
    const body = JSON.parse(bodies[0]) as { startCountryCode: string; endCountryCode: string; products: unknown[] };
    expect(body.startCountryCode).toBe('CN');
    expect(body.endCountryCode).toBe('US');
    expect(body.products).toEqual([{ quantity: 3, vid: 'v1' }, { quantity: 1, vid: 'v2' }]);
  });

  it('freightForBasket keeps the $0 domestic option and answers null when no channel serves the basket', async () => {
    let call = 0;
    const fakeFetch = (async () => {
      call++;
      return new Response(JSON.stringify({ result: true, data: call === 1
        ? [{ logisticName: 'Royal Mail GB to GB', logisticAging: '2-5', logisticPrice: 0 }]
        : [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const cj = new CjClient(async () => 'tok', fakeFetch);
    const domestic = await cj.freightForBasket([{ vid: 'V1', quantity: 2 }], 'GB', 'GB');
    expect(domestic).toEqual({ priceUsd: 0, days: '2-5', name: 'Royal Mail GB to GB' });
    expect(await cj.freightForBasket([{ vid: 'V1', quantity: 2 }], 'CN', 'BR')).toBeNull();
  });
});

// CJ's createOrderV2 payType: 2 pays from the wallet balance while creating the
// order, 3 creates the order only (CJ order API notice, read 2026-10-08). The
// first live create (order #1002, 2026-10-08) sent 2 and was refused "Balance
// is insufficient": with money in the wallet, "create-only" would have paid.
describe('CjClient.createOrder', () => {
  it('asks CJ to create the order only, never to pay it from the wallet balance', async () => {
    const calls: { url: string; body: string }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ result: true, data: { orderId: 'CJ-1', orderNum: '8505727222098' } }), { status: 200 });
    }) as typeof fetch;
    const cj = new CjClient(async () => 'tok', fakeFetch);
    const created = await cj.createOrder({
      orderNumber: '8505727222098',
      address: { name: 'A Buyer', phone: '+44 7700 900123', address1: '1 High St', city: 'London', province: 'England', zip: 'E6 2JA', countryCode: 'GB' },
      products: [{ vid: 'v1', quantity: 1 }],
      fromCountryCode: 'CN',
      logisticName: 'CJPacket Ordinary'
    });
    expect(created).toEqual({ orderId: 'CJ-1', orderNum: '8505727222098' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/shopping/order/createOrderV2');
    const body = JSON.parse(calls[0].body) as { payType: unknown; products: unknown };
    expect(body.payType).toBe(3);
    expect(body.products).toEqual([{ vid: 'v1', quantity: 1 }]);
  });
});

// A create call can fail after CJ has made the order (#1002, 2026-10-08: an
// error answer, and an UNPAID order under its number anyway; its retry was
// refused as a duplicate, CJ code 1603003). CJ's order detail call answers by
// the order number PawScout gave it (read live 2026-10-09). The detail names its
// ids differently from CJ's order list: the SD id, which the create answer gives
// and PawScout records, is `cjOrderCode`; `orderId` is the numeric id; and the
// detail's `cjOrderId` is null on a CREATED order and a CJ-prefixed id once CJ
// moves it on, so it is never used. The fixtures are the live answers' id
// fields for #1002 and #1003.
describe('CjClient.findOrderByNumber', () => {
  function detailFetch(data: unknown, calls: string[] = []): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ result: true, data }), { status: 200 });
    }) as typeof fetch;
  }

  it('reads the order detail by the order number PawScout gave CJ, and answers its SD id, number and status', async () => {
    const calls: string[] = [];
    const cj = new CjClient(async () => 'tok', detailFetch({ orderId: '2610081831170660600', orderNum: '8506621854034', cjOrderId: null, cjOrderCode: 'SD2610081831150667400', orderStatus: 'CREATED' }, calls));
    expect(await cj.findOrderByNumber('8506621854034')).toEqual({ cjOrderId: 'SD2610081831150667400', orderNum: '8506621854034', status: 'CREATED' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/shopping/order/getOrderDetail?orderId=8506621854034');
  });

  it("answers the SD id, not the detail's CJ-prefixed cjOrderId, once CJ has moved the order on", async () => {
    const cj = new CjClient(async () => 'tok', detailFetch({ orderId: '2610081301260650000', orderNum: '8505727222098', cjOrderId: 'CJ26100854844661980370', cjOrderCode: 'SD2610081301230654600', orderStatus: 'UNPAID' }));
    expect(await cj.findOrderByNumber('8505727222098')).toEqual({ cjOrderId: 'SD2610081301230654600', orderNum: '8505727222098', status: 'UNPAID' });
  });

  it('falls back to the numeric orderId when the answer has no SD id', async () => {
    const cj = new CjClient(async () => 'tok', detailFetch({ orderId: '2610081301260650000', orderNum: '8505727222098', cjOrderId: 'CJ26100854844661980370', orderStatus: 'UNPAID' }));
    expect(await cj.findOrderByNumber('8505727222098')).toEqual({ cjOrderId: '2610081301260650000', orderNum: '8505727222098', status: 'UNPAID' });
  });

  it("answers null when CJ holds no order under that number, or only the detail's own cjOrderId", async () => {
    expect(await new CjClient(async () => 'tok', detailFetch(null)).findOrderByNumber('1')).toBeNull();
    expect(await new CjClient(async () => 'tok', detailFetch({ orderNum: '1', orderStatus: 'CREATED' })).findOrderByNumber('1')).toBeNull();
    expect(await new CjClient(async () => 'tok', detailFetch({ orderNum: '1', cjOrderId: 'CJ1', orderStatus: 'UNPAID' })).findOrderByNumber('1')).toBeNull();
  });
});

describe('CjClient.getOrderDetailRaw', () => {
  it('answers CJ\'s order detail exactly as CJ sent it, for the read-only diagnostic', async () => {
    const calls: string[] = [];
    const raw = { orderId: '2610081831170660600', cjOrderId: 'SD2610081831150667400', orderNum: '8506621854034', shippingCustomerName: 'PawScout Test Order', orderStatus: 'CREATED' };
    const cj = new CjClient(async () => 'tok', (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ result: true, data: raw }), { status: 200 });
    }) as typeof fetch);
    expect(await cj.getOrderDetailRaw('SD2610081831150667400')).toEqual(raw);
    expect(calls[0]).toContain('/shopping/order/getOrderDetail?orderId=SD2610081831150667400');
  });
});

describe('diagOrderId', () => {
  it('no id asks for the order list; an id of letters and digits is read, trimmed; anything else is refused', () => {
    expect(diagOrderId({})).toEqual({ ok: true, orderId: null });
    expect(diagOrderId(null)).toEqual({ ok: true, orderId: null });
    expect(diagOrderId({ orderId: '' })).toEqual({ ok: true, orderId: null });
    expect(diagOrderId({ orderId: 'SD2610081831150667400' })).toEqual({ ok: true, orderId: 'SD2610081831150667400' });
    expect(diagOrderId({ orderId: ' 8506621854034 ' })).toEqual({ ok: true, orderId: '8506621854034' });
    for (const bad of ['a b', '../x', 'x'.repeat(65), 5, ['SD1']]) {
      expect(diagOrderId({ orderId: bad }).ok).toBe(false);
    }
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

describe('CjClient.detailBySku', () => {
  const PRODUCT = { pid: 'P77', productNameEn: 'Smart GPS Pet Tracker', productImage: 'https://i/t.jpg', variants: [{ vid: 'V1', variantNameEn: 'Black', variantSellPrice: 12.5, variantSku: 'CJPC262132401AZ-B' }] };

  it('queries /product/query by productSku with inventory and maps the product', async () => {
    const { client, urls } = clientWith(() => PRODUCT);
    const d = await client.detailBySku('CJPC262132401AZ');
    expect(d?.pid).toBe('P77');
    expect(urls[0]).toContain('/product/query?');
    expect(urls[0]).toContain('productSku=CJPC262132401AZ');
    expect(urls[0]).toContain('features=enable_inventory');
  });

  it('falls back to variantSku when the productSku lookup finds nothing', async () => {
    const { client, urls } = clientWith((url) => (url.includes('variantSku=') ? PRODUCT : null));
    const d = await client.detailBySku('CJPC262132401AZ-B');
    expect(d?.pid).toBe('P77');
    expect(urls.some((u) => u.includes('variantSku=CJPC262132401AZ-B'))).toBe(true);
  });

  it('returns null when neither lookup finds the product', async () => {
    const { client } = clientWith(() => null);
    expect(await client.detailBySku('CJXX000000000')).toBeNull();
  });
});

describe('looksLikeCjSku', () => {
  it('normalizes case and surrounding space', () => {
    expect(looksLikeCjSku('  cjpc262132401az ')).toBe('CJPC262132401AZ');
  });
  it('accepts a variant suffix', () => {
    expect(looksLikeCjSku('CJPC262132401AZ-Black')).toBe('CJPC262132401AZ-BLACK');
  });
  it('rejects ordinary words and short codes', () => {
    expect(looksLikeCjSku('gps dog collar')).toBeNull();
    expect(looksLikeCjSku('CJ123')).toBeNull();
  });
});
