import { describe, it, expect, vi } from 'vitest';
import { deriveDestinationCountry } from '../../src/inbox/freight';
import { shippingAgent } from '../../src/inbox/agents/shipping';

describe('Texas fix', () => {
  it('resolves a US state name to US', () => {
    expect(deriveDestinationCountry('how long to Texas for your products', '', 'a@gmail.com')).toBe('US');
  });
  it('keeps the ambiguity guard (two destinations -> null)', () => {
    expect(deriveDestinationCountry('to Texas or France?', '', 'a@gmail.com')).toBeNull();
  });
});

/**
 * Full-fidelity fakeCtx for ground() tests.
 * resolveItemShipping is called INTERNALLY by ground() so we drive it through
 * real fakes of store.getLinkByHandle + store.getWarehouseProduct (URL/handle path)
 * plus store.getLogisticsRoute (matrix row or null).
 * cj is an optional fake { freightQuoteAging } object.
 */
function fakeCtx(opts: {
  msg: string;
  links?: Record<string, { cj_pid: string }>;
  warehouse?: Record<string, { detail: string }>;
  matrixRoute?: any;
  cj?: any;
}) {
  const links = opts.links ?? {};
  const warehouse = opts.warehouse ?? {};

  const store = {
    getLinkByHandle: vi.fn().mockImplementation((handle: string) =>
      Promise.resolve(links[handle] ?? null)
    ),
    getLinkByShopifyProductId: vi.fn().mockResolvedValue(null),
    getWarehouseProduct: vi.fn().mockImplementation((cjPid: string) =>
      Promise.resolve(warehouse[cjPid] ?? null)
    ),
    getLogisticsRoute: vi.fn().mockResolvedValue(opts.matrixRoute ?? null),
  };

  return {
    store,
    cfg: { fulfil: {} },
    admin: null,
    cj: opts.cj ?? null,
    thread: { subject: '', contact_email: 'a@gmail.com' },
    conversation: opts.msg,
    latestMessage: opts.msg,
    contactEmail: 'a@gmail.com',
    customerName: null,
  } as any;
}

describe('shippingAgent.ground', () => {
  // GB-verified item: handle in message, verifiedGbWarehouse=true, no matrix route -> live CJ quote
  it('GB-verified item + no matrix route -> live CJ quote + UK fulfilment line', async () => {
    const detail = JSON.stringify({
      origins: { GB: 40, CN: 500 },
      variants: [{ vid: 'V1', stock: 40 }],
    });
    const cj = { freightQuoteAging: async () => [{ priceUsd: 0, days: '2-4', name: 'Domestic' }] };
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/cat-fountain to the UK?',
      links: { 'cat-fountain': { cj_pid: 'P1' } },
      warehouse: { P1: { detail } },
      matrixRoute: null, // no GB->GB row - force CJ fallback
      cj,
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    const line = shippingAgent.deterministicAppendix(g)!;
    expect(line).toMatch(/UK fulfilment location/i);
    expect(line).toMatch(/\d+-\d+ days/);
    expect(line).not.toMatch(/from (China|the UK)|ships from/i);
  });

  // CN item to US: time-only appendix, no UK, no China, no origin named
  it('CN item -> time-only, no origin, no UK claim', async () => {
    const detail = JSON.stringify({
      origins: { CN: 500 },
      variants: [{ vid: 'V2', stock: 500 }],
    });
    const cj = { freightQuoteAging: async () => [{ priceUsd: 1, days: '5-11', name: 'CJPacket' }] };
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/dog-launcher to the US?',
      links: { 'dog-launcher': { cj_pid: 'P2' } },
      warehouse: { P2: { detail } },
      matrixRoute: null,
      cj,
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    const line = shippingAgent.deterministicAppendix(g)!;
    expect(line).toMatch(/Delivery to the United States: estimated \d+-\d+ days\./);
    expect(line).not.toMatch(/UK|fulfilment|warehouse|China/i);
  });

  // No item resolved -> askForItem branch with soft general band
  it('no item resolved -> asks for the item, keeps a soft general band', async () => {
    const matrixRoute = { from_country: 'CN', to_country: 'GB', channel: 'c', transit_min: 4, transit_max: 9, aging_raw: '4-9', synced_at: new Date().toISOString() };
    const ctx = fakeCtx({
      msg: 'how long does shipping take to the UK?',
      matrixRoute,
    });
    const g = await shippingAgent.ground(ctx);
    expect((g.data as any).askForItem).toBe(true);
    expect(g.facts).toMatch(/ask .*which (item|product)/i);
  });

  // CN item to US via matrix route (no CJ call needed): time-only appendix
  it('grounds a delivery band and emits a time-only appendix that never names origin', async () => {
    const detail = JSON.stringify({
      origins: { CN: 500 },
      variants: [{ vid: 'V3', stock: 500 }],
    });
    const matrixRoute = { from_country: 'CN', to_country: 'US', channel: 'c', transit_min: 5, transit_max: 11, aging_raw: '5-11', synced_at: new Date().toISOString() };
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/dog-ball to Texas?',
      links: { 'dog-ball': { cj_pid: 'P3' } },
      warehouse: { P3: { detail } },
      matrixRoute,
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    const line = shippingAgent.deterministicAppendix(g)!;
    expect(line).toMatch(/estimated \d+-\d+ days/);
    expect(line).not.toMatch(/China|CN|UK/);
  });

  // No route and no CJ client -> hedges
  it('hedges when no route (stale/missing -> null)', async () => {
    const ctx = fakeCtx({
      msg: 'how long does shipping take to the UK?',
      matrixRoute: null,
    });
    const g = await shippingAgent.ground(ctx);
    // No item resolved and no route -> not confident (ask-for-item or hedge)
    expect(g.confident).toBe(false);
    expect(shippingAgent.deterministicAppendix(g)).toBeNull();
  });

  it('is not shipping intent -> not confident', async () => {
    const ctx = fakeCtx({ msg: 'do you sell cat food?' });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(false);
  });

  it('ground tolerates cj:null (no throw, falls back to matrix)', async () => {
    const ctx = fakeCtx({ msg: 'how long to deliver to the UK?', cj: null });
    const g = await shippingAgent.ground(ctx);
    expect(g).toBeDefined(); // no throw; cj:null means matrix-only path
  });
});
