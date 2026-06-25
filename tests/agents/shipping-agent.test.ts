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
  routes?: Record<string, any>; // route-aware: keyed by `${from}->${to}`
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
    getLogisticsRoute: vi.fn().mockImplementation((from: string, to: string) =>
      Promise.resolve(opts.routes ? (opts.routes[`${from}->${to}`] ?? null) : (opts.matrixRoute ?? null))
    ),
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

  // No item + the destination has a LOCAL warehouse -> default to the LOCAL fast band
  // (sale-positive), NOT the CN worst-case. Time-only, with the "depends on the product" caveat.
  it('no item, dest has a local warehouse -> defaults to the local fast band, not CN worst-case', async () => {
    const fresh = new Date().toISOString();
    const ctx = fakeCtx({
      msg: 'do you ship to the US and how long does it take?',
      routes: {
        'US->US': { from_country: 'US', to_country: 'US', channel: 'c', transit_min: 3, transit_max: 5, aging_raw: '3-5', synced_at: fresh },
        'CN->US': { from_country: 'CN', to_country: 'US', channel: 'c', transit_min: 5, transit_max: 11, aging_raw: '5-11', synced_at: fresh },
      },
    });
    const g = await shippingAgent.ground(ctx);
    expect((g.data as any).askForItem).toBe(true);
    // local US->US door-to-door = {2+3 .. 5+5+0+2} = 5-12; NOT the CN worst-case 7-23
    expect(g.facts).toMatch(/5-12 days/);
    expect(g.facts).not.toMatch(/7-23/);
    expect(g.facts).toMatch(/depends on the specific product/i);
  });

  // No local warehouse for the destination -> fall back to the CN route (still answers).
  it('no item, no local warehouse -> falls back to the CN route band', async () => {
    const fresh = new Date().toISOString();
    const ctx = fakeCtx({
      msg: 'how long does delivery take to France?',
      routes: { 'CN->FR': { from_country: 'CN', to_country: 'FR', channel: 'c', transit_min: 4, transit_max: 10, aging_raw: '4-10', synced_at: fresh } },
    });
    const g = await shippingAgent.ground(ctx);
    expect((g.data as any).askForItem).toBe(true);
    // CN->FR door-to-door = {2+4 .. 5+10+5+2} = 6-22
    expect(g.facts).toMatch(/6-22 days/);
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

  // Item resolves but NO band is obtainable anywhere (no matrix route, CJ returns no usable
  // option) -> notConfidentFacts hedge. This is the real degrade-don't-fabricate path.
  it('resolved item but no band (matrix null + empty CJ quote) -> hedges via notConfidentFacts', async () => {
    const detail = JSON.stringify({
      origins: { CN: 500 },
      variants: [{ vid: 'V6', stock: 500 }],
    });
    const cj = { freightQuoteAging: async () => [] }; // no usable option
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/cat-collar to the US?',
      links: { 'cat-collar': { cj_pid: 'P6' } },
      warehouse: { P6: { detail } },
      matrixRoute: null,
      cj,
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(false);
    expect((g.data as any)?.askForItem).toBeUndefined(); // item DID resolve - this is the hedge, not ask-for-item
    expect(g.facts).toMatch(/hedge on time/i);
    expect(shippingAgent.deterministicAppendix(g)).toBeNull();
  });

  it('is not shipping intent -> not confident', async () => {
    const ctx = fakeCtx({ msg: 'do you sell cat food?' });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(false);
  });

  // Resolved item + matrix route + cj:null -> band comes from the matrix, no CJ call, no throw.
  it('ground tolerates cj:null and grounds the band from the matrix route', async () => {
    const detail = JSON.stringify({
      origins: { CN: 500 },
      variants: [{ vid: 'V7', stock: 500 }],
    });
    const matrixRoute = { from_country: 'CN', to_country: 'US', channel: 'c', transit_min: 5, transit_max: 11, aging_raw: '5-11', synced_at: new Date().toISOString() };
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/cat-mat to the US?',
      links: { 'cat-mat': { cj_pid: 'P7' } },
      warehouse: { P7: { detail } },
      matrixRoute,
      cj: null,
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true); // no throw; matrix band used despite cj:null
    const line = shippingAgent.deterministicAppendix(g)!;
    expect(line).toMatch(/Delivery to the United States: estimated \d+-\d+ days/);
    expect(line).not.toMatch(/UK|China|CN/);
  });

  // CRITICAL: GB-warehoused item shipped to a non-GB dest must NOT emit the UK-fulfilment line.
  // This pins the dest==='GB' gate: verifiedGbWarehouse=true alone is not enough.
  it('GB-warehoused item to France -> time-only line, never UK-fulfilment', async () => {
    const detail = JSON.stringify({
      origins: { GB: 40, CN: 500 },
      variants: [{ vid: 'V5', stock: 40 }],
    });
    const cj = { freightQuoteAging: async () => [{ priceUsd: 2, days: '5-8', name: 'CJPacket' }] };
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/cat-bed to France?',
      links: { 'cat-bed': { cj_pid: 'P5' } },
      warehouse: { P5: { detail } },
      matrixRoute: null,
      cj,
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    const line = shippingAgent.deterministicAppendix(g)!;
    expect(line).toMatch(/Delivery to France/);
    expect(line).not.toMatch(/UK fulfilment|fulfilment location/i);
  });
});
