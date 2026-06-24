/**
 * Task 17: Per-product origin in the shipping agent
 *
 * Tests:
 * 1. Band-math assertion: EU origin -> EU dest (same country) has shorter max than CN -> same dest.
 * 2. resolveProductOrigin returns in-market origin when detail.origins includes dest with stock.
 * 3. resolveProductOrigin returns best-stocked origin when dest not in origins.
 * 4. resolveProductOrigin returns null when admin is null.
 * 5. resolveProductOrigin returns null when product unresolved.
 * 6. resolveProductOrigin returns null when no warehouse row.
 */
import { describe, it, expect, vi } from 'vitest';
import { doorToDoorBand } from '../../src/logistics';
import { DEFAULT_LOGISTICS } from '../../src/types';
import { resolveProductOrigin } from '../../src/inbox/agents/shipping';

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

// ---- 2-6. resolveProductOrigin unit tests ----

/** Minimal mock of AgentContext. */
function makeCtx(opts: {
  admin?: unknown;
  latestMessage?: string;
  resolvedVariant?: { variantId: string; productId: string } | null;
  productLink?: { cj_pid: string } | null;
  warehouseRow?: { detail: string } | null;
}) {
  const admin = opts.admin !== undefined ? opts.admin : (opts.resolvedVariant !== undefined ? {} : null);

  // Build mock store
  const store = {
    getLinkByShopifyProductId: vi.fn().mockResolvedValue(opts.productLink ?? null),
    getWarehouseProduct: vi.fn().mockResolvedValue(opts.warehouseRow ?? null),
  };

  // Mock searchShopifyProducts -> resolveLineRequest uses it
  // We inject a fake admin callable that is used by resolveLineRequest
  const adminFn = admin === null ? null : vi.fn().mockImplementation(() => {
    // resolveLineRequest calls searchShopifyProducts which calls admin(SEARCH, {...})
    // Return shape: { products: { edges: [...] } }
    if (!opts.resolvedVariant) {
      return Promise.resolve({ products: { edges: [] } });
    }
    // Return one product with one variant matching the resolved variant
    return Promise.resolve({
      products: {
        edges: [{
          node: {
            id: opts.resolvedVariant.productId,
            title: 'Test Product',
            variants: {
              edges: [{
                node: {
                  id: opts.resolvedVariant.variantId,
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
  });

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

describe('resolveProductOrigin', () => {
  it('returns in-market origin when detail.origins includes dest with stock', async () => {
    const ctx = makeCtx({
      resolvedVariant: { variantId: 'gid://shopify/ProductVariant/1', productId: 'gid://shopify/Product/100' },
      productLink: { cj_pid: 'CJ-PID-001' },
      warehouseRow: { detail: JSON.stringify({ pid: 'CJ-PID-001', nameEn: 'Test', images: [], descriptionHtml: '', variants: [], listedNum: 100, origins: { GB: 40, CN: 1000 } }) },
    });
    const origin = await resolveProductOrigin(ctx, 'GB');
    expect(origin).toBe('GB');
  });

  it('returns best-stocked origin when dest not in origins', async () => {
    const ctx = makeCtx({
      resolvedVariant: { variantId: 'gid://shopify/ProductVariant/2', productId: 'gid://shopify/Product/200' },
      productLink: { cj_pid: 'CJ-PID-002' },
      warehouseRow: { detail: JSON.stringify({ pid: 'CJ-PID-002', nameEn: 'Test', images: [], descriptionHtml: '', variants: [], listedNum: 100, origins: { CN: 1000, US: 50 } }) },
    });
    // dest = 'GB', not in origins -> pick best stocked (CN=1000)
    const origin = await resolveProductOrigin(ctx, 'GB');
    expect(origin).toBe('CN');
  });

  it('returns null when admin is null', async () => {
    const ctx = makeCtx({ admin: null });
    const origin = await resolveProductOrigin(ctx, 'GB');
    expect(origin).toBeNull();
  });

  it('returns null when product not found (resolveLineRequest returns none)', async () => {
    const ctx = makeCtx({
      resolvedVariant: null, // no product found -> admin returns empty edges
    });
    const origin = await resolveProductOrigin(ctx, 'GB');
    expect(origin).toBeNull();
  });

  it('returns null when no product_links row', async () => {
    const ctx = makeCtx({
      resolvedVariant: { variantId: 'gid://shopify/ProductVariant/3', productId: 'gid://shopify/Product/300' },
      productLink: null,
      warehouseRow: null,
    });
    const origin = await resolveProductOrigin(ctx, 'GB');
    expect(origin).toBeNull();
  });

  it('returns null when no warehouse row', async () => {
    const ctx = makeCtx({
      resolvedVariant: { variantId: 'gid://shopify/ProductVariant/4', productId: 'gid://shopify/Product/400' },
      productLink: { cj_pid: 'CJ-PID-004' },
      warehouseRow: null,
    });
    const origin = await resolveProductOrigin(ctx, 'GB');
    expect(origin).toBeNull();
  });

  it('returns null when origins is empty/missing in detail', async () => {
    const ctx = makeCtx({
      resolvedVariant: { variantId: 'gid://shopify/ProductVariant/5', productId: 'gid://shopify/Product/500' },
      productLink: { cj_pid: 'CJ-PID-005' },
      warehouseRow: { detail: JSON.stringify({ pid: 'CJ-PID-005', nameEn: 'Test', images: [], descriptionHtml: '', variants: [], listedNum: 100 }) },
    });
    const origin = await resolveProductOrigin(ctx, 'GB');
    expect(origin).toBeNull();
  });
});
