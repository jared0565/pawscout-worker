/**
 * Task 3: resolveItemShipping - item + nearest origin + verified-GB + representative vid
 *
 * Tests:
 * 1. Band-math assertion: EU origin -> EU dest (same country) has shorter max than CN -> same dest.
 * 2. resolveItemShipping: URL/handle signal -> verified GB warehouse + in-market origin.
 * 3. resolveItemShipping: free-text confident match -> best-stocked origin when dest not stocked.
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
}) {
  const links = opts.links ?? {};
  const linksByPid = opts.linksByPid ?? {};
  const warehouse = opts.warehouse ?? {};

  // When there is a URL/handle signal, admin is not needed. Only wire admin when
  // the test provides resolveLine (free-text path).
  const hasAdminPath = opts.resolveLine !== undefined;
  const adminFn = hasAdminPath
    ? vi.fn().mockImplementation(() => {
        const rl = opts.resolveLine!;
        if (rl.status !== 'resolved' || !rl.variant) {
          // Return empty edges so resolveLineRequest returns status:'none'/'ambiguous'
          return Promise.resolve({ products: { edges: [] } });
        }
        // Return one product with one variant so resolveLineRequest returns 'resolved'
        return Promise.resolve({
          products: {
            edges: [{
              node: {
                id: rl.variant.productId,
                title: 'Test Product',
                variants: {
                  edges: [{
                    node: {
                      id: 'gid://shopify/ProductVariant/1',
                      title: 'Default',
                      sku: 'SKU-1',
                      price: '9.99',
                      availableForSale: true,
                      inventoryQuantity: 10
                    }
                  }]
                }
              }
            }]
          }
        });
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
  };

  return {
    admin: adminFn,
    store,
    cfg: { fulfil: {} },
    thread: { subject: '', contact_email: 'test@example.com' },
    conversation: opts.latestMessage ?? 'How long to GB?',
    latestMessage: opts.latestMessage ?? 'How long to GB?',
    contactEmail: 'test@example.com',
    customerName: null,
  } as any;
}

describe('resolveItemShipping', () => {
  it('URL/handle signal -> verified GB warehouse + in-market origin', async () => {
    const detail = JSON.stringify({ origins: { GB: 40, CN: 500 }, variants: [{ vid: 'V1', stock: 40 }] });
    const ctx = fakeCtx({
      latestMessage: 'how long to deliver activepaw.co.uk/products/cat-fountain to me?',
      links: { 'cat-fountain': { cj_pid: 'P1' } },
      warehouse: { P1: { detail } },
    });
    const r = await resolveItemShipping(ctx, 'GB');
    expect(r).toEqual({ chosenOrigin: 'GB', cjPid: 'P1', repVid: 'V1', verifiedGbWarehouse: true });
  });

  it('free-text confident match -> best-stocked origin when dest not stocked', async () => {
    const detail = JSON.stringify({ origins: { CN: 500 }, variants: [{ vid: 'V2', stock: 500 }] });
    const ctx = fakeCtx({
      latestMessage: 'shipping time for the dog ball launcher?',
      resolveLine: { status: 'resolved', variant: { productId: 'gid://shopify/Product/2' } },
      linksByPid: { 'gid://shopify/Product/2': { cj_pid: 'P2' } },
      warehouse: { P2: { detail } },
    });
    const r = await resolveItemShipping(ctx, 'US');
    expect(r?.chosenOrigin).toBe('CN');
    expect(r?.verifiedGbWarehouse).toBe(false);
  });

  it('returns null on ambiguous/no item or missing warehouse data', async () => {
    expect(
      await resolveItemShipping(fakeCtx({ resolveLine: { status: 'ambiguous' } }), 'GB')
    ).toBeNull();
    expect(
      await resolveItemShipping(fakeCtx({ resolveLine: { status: 'none' } }), 'GB')
    ).toBeNull();
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
});
