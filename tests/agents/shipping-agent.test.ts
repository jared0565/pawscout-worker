import { describe, it, expect, vi } from 'vitest';
import { deriveDestinationCountry } from '../../src/inbox/freight';
import { shippingAgent, resolveItemShipping } from '../../src/inbox/agents/shipping';

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
  fulfil?: any; // override cfg.fulfil (e.g. { gbFreeUkLive: true })
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
    cfg: { fulfil: opts.fulfil ?? {} },
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
  // GB-verified item: handle in message, verifiedGbWarehouse=true, D1 has a GB->GB row -> UK fulfilment line.
  // (The live-CJ fallback was removed in C1; candidates come from D1 only.)
  it('GB-verified item + GB->GB matrix row -> UK fulfilment line', async () => {
    const detail = JSON.stringify({
      origins: { GB: 40, CN: 500 },
      variants: [{ vid: 'V1', stock: 40 }],
    });
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/cat-fountain to the UK?',
      links: { 'cat-fountain': { cj_pid: 'P1' } },
      warehouse: { P1: { detail } },
      routes: { 'GB->GB': { from_country: 'GB', to_country: 'GB', channel: 'Domestic', transit_min: 2, transit_max: 4, aging_raw: '2-4', synced_at: new Date().toISOString() } },
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    const line = shippingAgent.deterministicAppendix(g)!;
    expect(line).toMatch(/UK fulfilment location/i);
    expect(line).toMatch(/\d+-\d+ days/);
    expect(line).not.toMatch(/from (China|the UK)|ships from/i);
  });

  // CN item to US: time-only appendix, no UK, no China, no origin named (D1 has a CN->US row)
  it('CN item -> time-only, no origin, no UK claim', async () => {
    const detail = JSON.stringify({
      origins: { CN: 500 },
      variants: [{ vid: 'V2', stock: 500 }],
    });
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/dog-launcher to the US?',
      links: { 'dog-launcher': { cj_pid: 'P2' } },
      warehouse: { P2: { detail } },
      routes: { 'CN->US': { from_country: 'CN', to_country: 'US', channel: 'CJPacket', transit_min: 5, transit_max: 11, aging_raw: '5-11', synced_at: new Date().toISOString() } },
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

  // Item resolves but NO route exists to the destination in D1 (no matrix row).
  // -> unfulfillable: honest "not able to ship to X", never fabricate a delivery time.
  // This pins the behavior: item identified + no D1 route => unfulfillable, NOT a hedge.
  it('resolved item but no D1 route -> unfulfillable: honest cannot-ship, no day band', async () => {
    const detail = JSON.stringify({
      origins: { CN: 500 },
      variants: [{ vid: 'V6', stock: 500 }],
    });
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/cat-collar to the US?',
      links: { 'cat-collar': { cj_pid: 'P6' } },
      warehouse: { P6: { detail } },
      matrixRoute: null,
    });
    const g = await shippingAgent.ground(ctx);
    // Unfulfillable: confident=true (we ARE certain we cannot ship), no day band
    expect(g.confident).toBe(true);
    expect((g.data as any)?.unfulfillable).toBe(true);
    expect((g.data as any)?.askForItem).toBeUndefined();
    expect(g.facts).toMatch(/not able to ship|cannot ship/i);
    // appendix must be honest no-ship, never a "\d+-\d+ days" band
    const appendix = shippingAgent.deterministicAppendix(g);
    expect(appendix).toBeTruthy();
    expect(appendix).not.toMatch(/\d+-\d+ days/);
  });

  // notConfidentFacts is still reachable: item resolves with a route, but the matrix row
  // has null transit_min/max (doorToDoorBand returns null) and no CJ quote available.
  it('resolved item, matrix route has null transit -> notConfidentFacts hedge (no band, no unfulfillable)', async () => {
    const detail = JSON.stringify({
      origins: { CN: 500 },
      variants: [{ vid: 'V9', stock: 500 }],
    });
    const nullTransitRoute = { from_country: 'CN', to_country: 'US', channel: 'c', transit_min: null, transit_max: null, aging_raw: '', synced_at: new Date().toISOString() };
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/cat-brush to the US?',
      links: { 'cat-brush': { cj_pid: 'P9' } },
      warehouse: { P9: { detail } },
      routes: { 'CN->US': nullTransitRoute },
      cj: null,
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(false);
    expect((g.data as any)?.askForItem).toBeUndefined();
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
  // D1 has a CN->FR row (nearest origin to FR); GB->FR has no row (resolveNearestRoute picks CN).
  it('GB-warehoused item to France -> time-only line from nearest origin, never UK-fulfilment', async () => {
    const detail = JSON.stringify({
      origins: { GB: 40, CN: 500 },
      variants: [{ vid: 'V5', stock: 40 }],
    });
    const ctx = fakeCtx({
      msg: 'how long to deliver activepaw.co.uk/products/cat-bed to France?',
      links: { 'cat-bed': { cj_pid: 'P5' } },
      warehouse: { P5: { detail } },
      routes: { 'CN->FR': { from_country: 'CN', to_country: 'FR', channel: 'CJPacket', transit_min: 5, transit_max: 8, aging_raw: '5-8', synced_at: new Date().toISOString() } },
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    const line = shippingAgent.deterministicAppendix(g)!;
    expect(line).toMatch(/Delivery to France/);
    expect(line).not.toMatch(/UK fulfilment|fulfilment location/i);
  });
});

describe('resolveItemShipping - nearest-warehouse resolver', () => {
  // Task 4+5: GB-only product to FR with only a GB->GB matrix row and no CJ fallback
  // -> unfulfillable (must NOT borrow a GB->GB row for a non-GB destination).
  it('GB-only product + GB->GB matrix row only + cj:null + dest=FR -> unfulfillable', async () => {
    const detail = JSON.stringify({
      origins: { GB: 40 },
      variants: [{ vid: 'VA', stock: 40 }],
    });
    const ctx = fakeCtx({
      msg: 'how long to activepaw.co.uk/products/gb-toy to France?',
      links: { 'gb-toy': { cj_pid: 'PGB' } },
      warehouse: { PGB: { detail } },
      routes: { 'GB->GB': { from_country: 'GB', to_country: 'GB', channel: 'c', transit_min: 1, transit_max: 2, aging_raw: '1-2', synced_at: new Date().toISOString() } },
      cj: null,
    });
    const result = await resolveItemShipping(ctx, 'FR');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('unfulfillable');
    expect((result as any).dest).toBe('FR');
  });

  // Task 4+5: CN-only product to DE with a CN->DE matrix row -> resolved, chosenOrigin=CN.
  it('CN-only product + CN->DE matrix row + dest=DE -> resolved, chosenOrigin=CN', async () => {
    const detail = JSON.stringify({
      origins: { CN: 500 },
      variants: [{ vid: 'VB', stock: 500 }],
    });
    const ctx = fakeCtx({
      msg: 'how long to activepaw.co.uk/products/cn-toy to Germany?',
      links: { 'cn-toy': { cj_pid: 'PCN' } },
      warehouse: { PCN: { detail } },
      routes: { 'CN->DE': { from_country: 'CN', to_country: 'DE', channel: 'c', transit_min: 6, transit_max: 12, aging_raw: '6-12', synced_at: new Date().toISOString() } },
      cj: null,
    });
    const result = await resolveItemShipping(ctx, 'DE');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('resolved');
    expect((result as any).chosenOrigin).toBe('CN');
  });

  // Task 4+5: unfulfillable -> ground() returns confident=true + honest no-ship + no day band in appendix.
  it('ground() unfulfillable case: confident=true, facts says not able to ship, appendix has no day band', async () => {
    const detail = JSON.stringify({
      origins: { GB: 40 },
      variants: [{ vid: 'VC', stock: 40 }],
    });
    const ctx = fakeCtx({
      msg: 'how long to activepaw.co.uk/products/gb-collar to France?',
      links: { 'gb-collar': { cj_pid: 'PGC' } },
      warehouse: { PGC: { detail } },
      routes: {},
      cj: null,
    });
    const g = await shippingAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect((g.data as any)?.unfulfillable).toBe(true);
    expect(g.facts).toMatch(/not able to ship|cannot ship/i);
    const appendix = shippingAgent.deterministicAppendix(g)!;
    expect(appendix).toBeTruthy();
    expect(appendix).not.toMatch(/\d+-\d+ days/);
  });
});

describe('free UK delivery flag (Task 6 - gbFreeUkLive verify-then-flip gate)', () => {
  const GB_DETAIL = JSON.stringify({ origins: { GB: 40, CN: 500 }, variants: [{ vid: 'V1', stock: 40 }] });
  // Routes used across tests (candidates come from D1 only - no live-CJ fallback).
  const gbRoute = { from_country: 'GB', to_country: 'GB', channel: 'Domestic', transit_min: 2, transit_max: 4, aging_raw: '2-4', synced_at: new Date().toISOString() };
  const usRoute = { from_country: 'CN', to_country: 'US', channel: 'CJPacket', transit_min: 5, transit_max: 11, aging_raw: '5-11', synced_at: new Date().toISOString() };

  it('flag ON: GB item to GB -> appendix adds the free UK delivery clause', async () => {
    const ctx = fakeCtx({ msg: 'how long to activepaw.co.uk/products/cat-fountain to the UK?', links: { 'cat-fountain': { cj_pid: 'P1' } }, warehouse: { P1: { detail: GB_DETAIL } }, routes: { 'GB->GB': gbRoute }, fulfil: { gbFreeUkLive: true } });
    const line = shippingAgent.deterministicAppendix(await shippingAgent.ground(ctx))!;
    expect(line).toMatch(/free UK delivery/i);
    expect(line).toMatch(/UK fulfilment location/i);
  });

  it('flag OFF (absent): SAME GB item to GB -> location line but NO free UK delivery claim', async () => {
    const ctx = fakeCtx({ msg: 'how long to activepaw.co.uk/products/cat-fountain to the UK?', links: { 'cat-fountain': { cj_pid: 'P1' } }, warehouse: { P1: { detail: GB_DETAIL } }, routes: { 'GB->GB': gbRoute } });
    const line = shippingAgent.deterministicAppendix(await shippingAgent.ground(ctx))!;
    expect(line).not.toMatch(/free UK delivery/i);
    expect(line).toMatch(/UK fulfilment location/i);
  });

  it('flag ON but CN-only item -> never claims free UK or UK fulfilment (verifiedGb false)', async () => {
    const detail = JSON.stringify({ origins: { CN: 500 }, variants: [{ vid: 'V2', stock: 500 }] });
    const cnUkRoute = { from_country: 'CN', to_country: 'GB', channel: 'CJPacket', transit_min: 5, transit_max: 11, aging_raw: '5-11', synced_at: new Date().toISOString() };
    const ctx = fakeCtx({ msg: 'how long to activepaw.co.uk/products/dog-launcher to the UK?', links: { 'dog-launcher': { cj_pid: 'P2' } }, warehouse: { P2: { detail } }, routes: { 'CN->GB': cnUkRoute }, fulfil: { gbFreeUkLive: true } });
    const line = shippingAgent.deterministicAppendix(await shippingAgent.ground(ctx))!;
    expect(line).not.toMatch(/free UK delivery|UK fulfilment/i);
  });

  it('flag ON but GB item to a NON-GB dest (US) -> never claims free UK or UK fulfilment', async () => {
    const ctx = fakeCtx({ msg: 'how long to activepaw.co.uk/products/cat-fountain to the US?', links: { 'cat-fountain': { cj_pid: 'P1' } }, warehouse: { P1: { detail: GB_DETAIL } }, routes: { 'CN->US': usRoute }, fulfil: { gbFreeUkLive: true } });
    const line = shippingAgent.deterministicAppendix(await shippingAgent.ground(ctx))!;
    expect(line).not.toMatch(/free UK delivery|UK fulfilment/i);
  });
});
