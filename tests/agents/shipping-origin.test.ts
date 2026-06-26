/**
 * resolveItemShipping - item + nearest-warehouse route + verified-GB + representative vid
 *
 * Tests:
 * 1. Band-math assertion: EU origin -> EU dest (same country) has shorter max than CN -> same dest.
 * 2. resolveItemShipping: URL/handle signal -> verified GB warehouse + in-market origin (resolved).
 * 3. resolveItemShipping: free-text confident match -> resolved when a route exists, unfulfillable
 *    when no route exists for the destination.
 * 4. resolveItemShipping: returns null on ambiguous/no item or missing warehouse data.
 */
import { describe, it, expect, vi } from 'vitest';
import { doorToDoorBand } from '../../src/logistics';
import { DEFAULT_LOGISTICS } from '../../src/types';
import { resolveItemShipping } from '../../src/inbox/agents/shipping';

// ---- 1. Pure band-math: EU origin no-customs vs CN origin with-customs ----
describe('per-product origin band (doorToDoorBand)', () => {
  it('EU->EU route (same country, no customs) has shorter max than CN->EU route (customs leg)', () => {
    const l = DEFAULT_LOGISTICS;
    // GB -> GB: 2-5 day transit, no customs (from === to)
    const eu = doorToDoorBand(
      { from_country: 'GB', to_country: 'GB', transit_min: 2, transit_max: 5, channel: '', aging_raw: '2-5', synced_at: '' },
      l
    )!;
    // CN -> GB: 8-15 day transit, customs applies
    const cn = doorToDoorBand(
      { from_country: 'CN', to_country: 'GB', transit_min: 8, transit_max: 15, channel: '', aging_raw: '8-15', synced_at: '' },
      l
    )!;
    expect(eu).not.toBeNull();
    expect(cn).not.toBeNull();
    expect(eu.max).toBeLessThan(cn.max);
  });

  it('DE->FR route (cross-border within EU) still adds customs leg', () => {
    const l = DEFAULT_LOGISTICS;
    const eu = doorToDoorBand(
      { from_country: 'DE', to_country: 'FR', transit_min: 2, transit_max: 5, channel: '', aging_raw: '2-5', synced_at: '' },
      l
    )!;
    const cn = doorToDoorBand(
      { from_country: 'CN', to_country: 'FR', transit_min: 8, transit_max: 15, channel: '', aging_raw: '8-15', synced_at: '' },
      l
    )!;
    expect(eu.max).toBeLessThan(cn.max);
  });
});

// ---- 2-4. resolveItemShipping unit tests ----

/**
 * Minimal mock of AgentContext for resolveItemShipping.
 *
 * opts.latestMessage       - customer message text (may include a product URL/handle)
 * opts.links               - map of handle -> { cj_pid } for getLinkByHandle
 * opts.resolveLine         - return value for resolveLineRequest (via fake admin)
 *                            defaults to { status: 'none' } when not supplied
 * opts.linksByPid          - map of shopifyProductId -> { cj_pid } for getLinkByShopifyProductId
 * opts.warehouse           - map of cj_pid -> { detail: string } for getWarehouseProduct
 */
function fakeCtx(opts: {
  latestMessage?: string;
  links?: Record<string, { cj_pid: string }>;
  resolveLine?: { status: string; variant?: { productId: string } };
  linksByPid?: Record<string, { cj_pid: string }>;
  warehouse?: Record<string, { detail: string }>;
  routes?: Record<string, any>;
}) {
  const links = opts.links ?? {};
  const linksByPid = opts.linksByPid ?? {};
  const warehouse = opts.warehouse ?? {};
  const routes = opts.routes ?? {};

  // Build a fake product edge with a single available variant.
  const productEdge = (productId: string, variantId: string) => ({
    node: {
      id: productId,
      title: 'Test Product',
      variants: {
        edges: [{
          node: {
            id: variantId,
            title: 'Default',
            sku: 'SKU-1',
            price: '9.99',
            availableForSale: true,
            inventoryQuantity: 10
          }
        }]
      }
    }
  });

  // When there is a URL/handle signal, admin is not needed. Only wire admin when
  // the test provides resolveLine (free-text path).
  // resolveLineRequest derives its status from the number of AVAILABLE variants:
  //   0 -> 'none', 1 -> 'resolved', 2+ -> 'ambiguous'. So we shape the edges to
  //   genuinely produce the requested status (not by faking the status string).
  const hasAdminPath = opts.resolveLine !== undefined;
  const adminFn = hasAdminPath
    ? vi.fn().mockImplementation(() => {
        const rl = opts.resolveLine!;
        if (rl.status === 'resolved' && rl.variant) {
          // One available variant -> resolveLineRequest returns 'resolved'.
          return Promise.resolve({
            products: { edges: [productEdge(rl.variant.productId, 'gid://shopify/ProductVariant/1')] }
          });
        }
        if (rl.status === 'ambiguous') {
          // Two available variants -> resolveLineRequest returns 'ambiguous'.
          return Promise.resolve({
            products: {
              edges: [
                productEdge('gid://shopify/Product/A', 'gid://shopify/ProductVariant/A'),
                productEdge('gid://shopify/Product/B', 'gid://shopify/ProductVariant/B'),
              ]
            }
          });
        }
        // 'none' (or anything else): zero edges -> resolveLineRequest returns 'none'.
        return Promise.resolve({ products: { edges: [] } });
      })
    : null; // URL path does not need admin

  const store = {
    getLinkByHandle: vi.fn().mockImplementation((handle: string) =>
      Promise.resolve(links[handle] ?? null)
    ),
    getLinkByShopifyProductId: vi.fn().mockImplementation((pid: string) =>
      Promise.resolve(linksByPid[pid] ?? null)
    ),
    getWarehouseProduct: vi.fn().mockImplementation((cjPid: string) =>
      Promise.resolve(warehouse[cjPid] ?? null)
    ),
    getLogisticsRoute: vi.fn().mockImplementation((from: string, to: string) =>
      Promise.resolve(routes[`${from}->${to}`] ?? null)
    ),
  };

  return {
    admin: adminFn,
    store,
    cj: null,
    cfg: { fulfil: {} },
    thread: { subject: '', contact_email: 'test@example.com' },
    conversation: opts.latestMessage ?? 'How long to GB?',
    latestMessage: opts.latestMessage ?? 'How long to GB?',
    contactEmail: 'test@example.com',
    customerName: null,
  } as any;
}

describe('resolveItemShipping', () => {
  it('URL/handle signal -> verified GB warehouse + in-market origin (resolved)', async () => {
    const detail = JSON.stringify({ origins: { GB: 40, CN: 500 }, variants: [{ vid: 'V1', stock: 40 }] });
    const ctx = fakeCtx({
      latestMessage: 'how long to deliver activepaw.co.uk/products/cat-fountain to me?',
      links: { 'cat-fountain': { cj_pid: 'P1' } },
      warehouse: { P1: { detail } },
      // Provide both routes; GB->GB is nearest (smaller transit) so it wins.
      routes: {
        'GB->GB': { from_country: 'GB', to_country: 'GB', transit_min: 2, transit_max: 5, channel: 'Domestic', aging_raw: '2-5', synced_at: '' },
        'CN->GB': { from_country: 'CN', to_country: 'GB', transit_min: 8, transit_max: 15, channel: 'CJPacket', aging_raw: '8-15', synced_at: '' },
      },
    });
    const r = await resolveItemShipping(ctx, 'GB');
    expect(r).toMatchObject({ kind: 'resolved', chosenOrigin: 'GB', cjPid: 'P1', repVid: 'V1', verifiedGbWarehouse: true });
  });

  it('free-text confident match -> resolved via nearest route when route exists, unfulfillable when no route', async () => {
    const detail = JSON.stringify({ origins: { CN: 500 }, variants: [{ vid: 'V2', stock: 500 }] });

    // (a) CN->US route exists: result is resolved with CN as origin.
    const ctxWithRoute = fakeCtx({
      latestMessage: 'shipping time for the dog ball launcher?',
      resolveLine: { status: 'resolved', variant: { productId: 'gid://shopify/Product/2' } },
      linksByPid: { 'gid://shopify/Product/2': { cj_pid: 'P2' } },
      warehouse: { P2: { detail } },
      routes: {
        'CN->US': { from_country: 'CN', to_country: 'US', transit_min: 5, transit_max: 11, channel: 'LuWei', aging_raw: '5-11', synced_at: '' },
      },
    });
    const rResolved = await resolveItemShipping(ctxWithRoute, 'US');
    expect(rResolved).toMatchObject({ kind: 'resolved', chosenOrigin: 'CN', verifiedGbWarehouse: false });

    // (b) No route to US in matrix and cj:null: result is unfulfillable, not a fabricated band.
    const ctxNoRoute = fakeCtx({
      latestMessage: 'shipping time for the dog ball launcher?',
      resolveLine: { status: 'resolved', variant: { productId: 'gid://shopify/Product/2' } },
      linksByPid: { 'gid://shopify/Product/2': { cj_pid: 'P2' } },
      warehouse: { P2: { detail } },
      routes: {}, // no CN->US matrix row; cj is null so no live fallback
    });
    const rUnfulfillable = await resolveItemShipping(ctxNoRoute, 'US');
    expect(rUnfulfillable).toMatchObject({ kind: 'unfulfillable', dest: 'US' });
  });

  it('returns null when the free-text match is ambiguous (2+ products)', async () => {
    // The admin mock returns two available variants, so resolveLineRequest genuinely
    // returns status:'ambiguous' (not 'none') and resolveItemShipping must bail.
    const ctx = fakeCtx({
      latestMessage: 'how long for a dog toy?',
      resolveLine: { status: 'ambiguous' },
    });
    expect(await resolveItemShipping(ctx, 'GB')).toBeNull();
  });

  it('returns null when the free-text match resolves nothing (status none)', async () => {
    const ctx = fakeCtx({
      latestMessage: 'how long for a widget that does not exist?',
      resolveLine: { status: 'none' },
    });
    expect(await resolveItemShipping(ctx, 'GB')).toBeNull();
  });

  it('returns null when a URL handle is present but not in the catalog', async () => {
    // Critical path: a handle is present but getLinkByHandle misses. We must NOT
    // fall through to the free-text path and guess a DIFFERENT product. To prove
    // the early-return (not just an absent admin) is what stops the fall-through,
    // we wire a free-text path that WOULD resolve a real, fully-stocked product:
    // without the early-return, resolveItemShipping would wrongly return that.
    const detail = JSON.stringify({ origins: { CN: 500 }, variants: [{ vid: 'VX', stock: 500 }] });
    const ctx = fakeCtx({
      latestMessage: 'how long for activepaw.co.uk/products/unknown-thing ?',
      links: {}, // handle miss
      resolveLine: { status: 'resolved', variant: { productId: 'gid://shopify/Product/9' } },
      linksByPid: { 'gid://shopify/Product/9': { cj_pid: 'P9' } },
      warehouse: { P9: { detail } },
    });
    expect(await resolveItemShipping(ctx, 'GB')).toBeNull();
  });

  it('returns null when no admin and no URL handle in message', async () => {
    // No URL, no admin (resolveLine not provided -> admin is null) -> null
    const ctx = fakeCtx({ latestMessage: 'how long to deliver?' });
    const r = await resolveItemShipping(ctx, 'GB');
    expect(r).toBeNull();
  });

  it('returns null when warehouse row is missing', async () => {
    const ctx = fakeCtx({
      latestMessage: 'activepaw.co.uk/products/dog-toy',
      links: { 'dog-toy': { cj_pid: 'P3' } },
      warehouse: {}, // no row
    });
    const r = await resolveItemShipping(ctx, 'GB');
    expect(r).toBeNull();
  });

  it('D1-empty + non-null ctx.cj -> unfulfillable; freightQuoteAging NOT called (quote==checkout guard)', async () => {
    // C1 regression guard: the live-CJ fallback was deleted. Even with a non-null ctx.cj
    // that would return a valid route, the result must be unfulfillable when D1 has no row.
    const detail = JSON.stringify({ origins: { CN: 500 }, variants: [{ vid: 'V99', stock: 500 }] });
    const ctx = fakeCtx({
      latestMessage: 'activepaw.co.uk/products/rope-toy',
      links: { 'rope-toy': { cj_pid: 'P99' } },
      warehouse: { P99: { detail } },
      routes: {}, // no CN->US row in D1
    });
    // Inject a spy that WOULD return a valid route if the fallback were still live.
    const spy = vi.fn().mockResolvedValue([{ days: '5-11', priceUsd: 10 }]);
    (ctx as any).cj = { freightQuoteAging: spy };
    const r = await resolveItemShipping(ctx, 'US');
    expect(r).toMatchObject({ kind: 'unfulfillable', dest: 'US' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('repVid is null when detail has no variants', async () => {
    const detail = JSON.stringify({ origins: { GB: 40 } }); // no variants key
    const ctx = fakeCtx({
      latestMessage: 'activepaw.co.uk/products/cat-bed',
      links: { 'cat-bed': { cj_pid: 'P4' } },
      warehouse: { P4: { detail } },
      routes: {
        'GB->GB': { from_country: 'GB', to_country: 'GB', transit_min: 2, transit_max: 5, channel: 'Domestic', aging_raw: '2-5', synced_at: '' },
      },
    });
    const r = await resolveItemShipping(ctx, 'GB');
    expect(r).toMatchObject({ kind: 'resolved', chosenOrigin: 'GB', cjPid: 'P4', repVid: null, verifiedGbWarehouse: true });
  });
});
