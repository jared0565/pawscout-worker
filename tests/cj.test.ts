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
