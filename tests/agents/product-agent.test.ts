import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../../src/tenant-store';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_FULFIL } from '../../src/types';
import type { CjClient, CjDetail } from '../../src/cj';
import { productAgent } from '../../src/inbox/agents/product';

const mkCtx = (admin: any, latest = 'is the blue harness good for puppies?') => ({
  store: {} as any, cfg: {} as any, admin, thread: { subject: '' }, conversation: latest,
  latestMessage: latest, contactEmail: 'a@b.com', customerName: null
}) as any;

const singleProductAdmin = async () => ({
  products: { edges: [{ node: { id: 'p1', title: 'Blue Harness', variants: { edges: [{ node: { id: 'v1', title: 'M', sku: 'BH-M', price: '12.00', availableForSale: true, inventoryQuantity: 5 } }] } } }] }
});

describe('productAgent department', () => {
  // Product/spec questions ("does this come in large?", "is the material pet-safe?")
  // are the shop's "technical questions" bucket, so they sign as the Technical Team.
  it('signs as the Technical Team desk', () => {
    expect(productAgent.department).toBe('tech');
  });
});

describe('productAgent.ground', () => {
  it('hedges when admin is null (not authed)', async () => {
    const g = await productAgent.ground(mkCtx(null));
    expect(g.confident).toBe(false);
  });
  it('grounds a single resolved product', async () => {
    const g = await productAgent.ground(mkCtx(singleProductAdmin));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Blue Harness');
  });
  it('asks which item on ambiguous (no figure)', async () => {
    const admin = async () => ({ products: { edges: [
      { node: { id: 'p1', title: 'Blue Harness S', variants: { edges: [{ node: { id: 'v1', title: 'S', price: '12', availableForSale: true, inventoryQuantity: 3 } }] } } },
      { node: { id: 'p2', title: 'Blue Harness L', variants: { edges: [{ node: { id: 'v2', title: 'L', price: '14', availableForSale: true, inventoryQuantity: 3 } }] } } }
    ] } });
    const g = await productAgent.ground(mkCtx(admin));
    expect(g.confident).toBe(false);
    expect(g.facts.toLowerCase()).toContain('which');
  });

  it('ambiguous variants of ONE product -> confident, facts contain title + both variant options', async () => {
    // Both variants belong to the same product (same id 'p1')
    const admin = async () => ({ products: { edges: [
      { node: { id: 'p1', title: 'Blue Harness', variants: { edges: [
        { node: { id: 'v1', title: 'S', price: '12.00', availableForSale: true, inventoryQuantity: 3 } },
        { node: { id: 'v2', title: 'L', price: '14.00', availableForSale: true, inventoryQuantity: 2 } }
      ] } } }
    ] } });
    const g = await productAgent.ground(mkCtx(admin));
    expect(g.confident).toBe(true);
    expect(g.quotesFigure).toBe(true);
    expect(g.facts).toContain('Blue Harness');
    expect(g.facts).toContain('S');
    expect(g.facts).toContain('L');
  });

  it('ambiguous candidates spanning two different productIds -> hedge (not confident)', async () => {
    // Each variant belongs to a different product
    const admin = async () => ({ products: { edges: [
      { node: { id: 'p1', title: 'Blue Harness', variants: { edges: [{ node: { id: 'v1', title: 'S', price: '12.00', availableForSale: true, inventoryQuantity: 3 } }] } } },
      { node: { id: 'p2', title: 'Red Harness', variants: { edges: [{ node: { id: 'v2', title: 'S', price: '13.00', availableForSale: true, inventoryQuantity: 3 } }] } } }
    ] } });
    const g = await productAgent.ground(mkCtx(admin));
    expect(g.confident).toBe(false);
    expect(g.facts.toLowerCase()).toContain('which');
  });

  // Task 19: warehouse supplement tests
  it('appends warehouse stock info when D1 row is available', async () => {
    const store = {
      getLinkByShopifyProductId: async (_id: string) => ({ cj_pid: 'cj-p1' }),
      getWarehouseProduct: async (_pid: string) => ({
        stock: 40,
        status: 'available',
        detail: JSON.stringify({ material: 'nylon' })
      })
    };
    const ctx = {
      store, cfg: {} as any, admin: singleProductAdmin,
      thread: { subject: '' }, conversation: 'blue harness',
      latestMessage: 'blue harness', contactEmail: 'a@b.com', customerName: null
    } as any;
    const g = await productAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Blue Harness');
    expect(g.facts.toLowerCase()).toContain('stock');
    expect(g.facts).toContain('40');
  });

  it('includes categoryName and petClass spec fields when warehouse detail has them', async () => {
    const store = {
      getLinkByShopifyProductId: async (_id: string) => ({ cj_pid: 'p1' }),
      getWarehouseProduct: async (_pid: string) => ({
        stock: 12,
        status: 'available',
        detail: JSON.stringify({ categoryName: 'Harnesses', petClass: 'dog' })
      })
    };
    const ctx = {
      store, cfg: {} as any, admin: singleProductAdmin,
      thread: { subject: '' }, conversation: 'blue harness',
      latestMessage: 'blue harness', contactEmail: 'a@b.com', customerName: null
    } as any;
    const g = await productAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Category: Harnesses');
    expect(g.facts).toContain('For: dog');
  });

  it('stays confident and keeps price/title when no warehouse row exists', async () => {
    const store = {
      getLinkByShopifyProductId: async (_id: string) => null,
    };
    const ctx = {
      store, cfg: {} as any, admin: singleProductAdmin,
      thread: { subject: '' }, conversation: 'blue harness',
      latestMessage: 'blue harness', contactEmail: 'a@b.com', customerName: null
    } as any;
    const g = await productAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Blue Harness');
    expect(g.facts).toContain('12.00');
  });
});

describe('productAgent local-for-local availability (inquiry side of the market catalogs)', () => {
  const ctxWith = (latest: string, origins: Record<string, number> | null) => ({
    store: {
      getLinkByShopifyProductId: async (_id: string) => ({ cj_pid: 'cj-p1' }),
      getWarehouseProduct: async (_pid: string) => origins === null ? null : ({
        stock: 40, status: 'available',
        detail: JSON.stringify({ origins })
      })
    },
    cfg: {} as any, admin: singleProductAdmin,
    thread: { subject: '' }, conversation: latest,
    latestMessage: latest, contactEmail: 'a@b.com', customerName: null
  }) as any;

  it('cross-lane item + confident destination -> honest not-available, no price, no purchase push', async () => {
    // A UK sender asking about a US-warehoused item: the UK market does not sell it.
    const g = await productAgent.ground(ctxWith('does the blue harness ship to the UK?', { US: 60 }));
    expect(g.confident).toBe(true);
    expect(g.quotesFigure).toBe(false);
    expect(g.facts).toMatch(/not available for delivery to the UK/);
    expect(g.facts).not.toContain('12.00');
    expect(g.facts).not.toMatch(/in stock/i);
  });

  it('destination we have no market for -> plain no-delivery instruction', async () => {
    const g = await productAgent.ground(ctxWith('can I get the blue harness in Japan?', { CN: 900 }));
    expect(g.confident).toBe(true);
    expect(g.facts).toMatch(/appears to be in Japan/);
    expect(g.facts).toMatch(/do not currently deliver/);
    expect(g.facts).not.toContain('12.00');
  });

  it('CN scaffolding item + EU destination stays a normal answer (transitional lane)', async () => {
    const g = await productAgent.ground(ctxWith('does the blue harness ship to Germany?', { CN: 900 }));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Blue Harness');
    expect(g.facts).toContain('12.00');
  });

  it('lane-local item + its own destination stays a normal answer', async () => {
    const g = await productAgent.ground(ctxWith('is the blue harness available in the UK?', { GB: 12 }));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('12.00');
    expect(g.facts).not.toMatch(/not available/);
  });

  it('no destination signal -> unchanged behavior even for cross-lane stock', async () => {
    const g = await productAgent.ground(ctxWith('is the blue harness machine washable?', { US: 60 }));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('12.00');
  });

  it('unverified origins -> cannot determine, keeps the normal grounded answer', async () => {
    const g = await productAgent.ground(ctxWith('does the blue harness ship to the UK?', null));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('12.00');
  });
});

// Rose thread (2026-09-05): the product agent searched titles with the first
// 80 characters of a message that BEGAN with the product URL, matched nothing,
// and told a sender who had named the exact product that we "cannot verify the
// specific product details". A pasted link grounds the reply in that listing.
describe('productAgent.ground with a pasted product link', () => {
  const ROSE_1 = 'https://activepaw.co.uk/products/portable-dog-water-bowl-bottle-attachment\n\nI came across your store and I am considering recommending it to a few people who are looking for products in this category. Before I do, I wanted to ask do the products normally arrive exactly as shown and described on the website?';
  const ROSE_2 = 'just checking back in. I think our conversation got a little buried. I am still open to recommending your store, but I wanted to make sure I can reach you directly if anyone has questions before ordering.';
  const byHandleAdmin = async (query: string, vars?: Record<string, unknown>) => {
    if (query.includes('productByHandle')) {
      if (vars?.handle !== 'portable-dog-water-bowl-bottle-attachment') return { productByHandle: null };
      return { productByHandle: { id: 'gid://shopify/Product/7', title: 'Portable Dog Water Bowl', handle: 'portable-dog-water-bowl-bottle-attachment', variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/70', title: 'Default Title', sku: 'PDWB', price: '11.99', availableForSale: true, inventoryQuantity: 12 } }] } } };
    }
    return { products: { edges: [] } };
  };
  it('resolves the linked product from the latest message', async () => {
    const g = await productAgent.ground(mkCtx(byHandleAdmin, ROSE_1));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Portable Dog Water Bowl');
  });
  it('resolves a link from an EARLIER message in the thread when the latest has none', async () => {
    const ctx = { ...mkCtx(byHandleAdmin, ROSE_2), conversation: ROSE_1 + '\n\n' + ROSE_2 };
    const g = await productAgent.ground(ctx);
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('Portable Dog Water Bowl');
  });
});

describe('productAgent on a catalog miss (inquiry sourcing)', () => {
  beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
  const emptyAdmin = async () => ({ products: { edges: [] } });
  const TRACKER: CjDetail = { pid: 'T1', nameEn: 'Smart GPS Wireless Pet Tracker', images: ['https://i/t.jpg'], descriptionHtml: '<p>Clips to the collar. Needs a SIM card.</p>', variants: [{ vid: 'v', name: 'Black', sellPriceUsd: 12, sku: 's' }], listedNum: 10, categoryName: 'Pet', origins: { CN: 5429 } };
  const cj = {
    search: async () => [{ pid: 'T1', nameEn: TRACKER.nameEn, image: '', sellPriceUsd: 12, listedNum: 10, categoryName: 'Pet' }],
    detail: async () => TRACKER, detailBySku: async () => null, originsByPid: async () => TRACKER.origins,
    freightEstimate: async () => ({ priceUsd: 4, days: '5-9', name: 'CJPacket' }),
  } as unknown as CjClient;
  const cfg = { pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, fulfil: DEFAULT_FULFIL } as any;

  async function ctx(message: string, withCj = true) {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v', freightCostUsd: 4 });
    return { store, cfg, admin: emptyAdmin, cj: withCj ? cj : null, thread: { subject: 'Collar' }, conversation: message, latestMessage: message, contactEmail: 'aloha@example.com', customerName: 'Aloha', productQuery: 'gps tracker dog collar' } as any;
  }

  it('offers the supplier item with price, overseas note and delivery band, held for the owner', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar? I live in England.'));
    expect(g.confident).toBe(true);
    expect(g.holdReason).toBe('sourcing_offer');
    expect(g.facts).toContain('Smart GPS Wireless Pet Tracker');
    expect(g.facts).toMatch(/GBP \d+\.\d{2}/);
    expect(g.facts).toContain('ships from overseas');
    expect(g.facts).toMatch(/\d+-\d+ days/);
    expect(g.facts).not.toMatch(/\bChina\b|\bCJ\b/);
  });

  it('states no delivery time and asks for the country when it is unknown', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar?'));
    expect(g.holdReason).toBe('sourcing_offer');
    expect(g.facts).toContain('do not state a delivery time');
    expect(g.facts).not.toMatch(/\d+-\d+ days/);
  });

  it('never sends the customer to the website search when nothing matches', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar?', false));
    expect(g.confident).toBe(false);
    expect(g.facts.toLowerCase()).not.toContain('website');
    expect(g.facts).toContain('team will look into');
  });

  it('says we do not deliver to a country with no lane', async () => {
    const g = await productAgent.ground(await ctx('Do you sell a trackable dog collar? I live in Japan.'));
    expect(g.facts).toContain('do not currently deliver');
    expect(g.holdReason).toBeUndefined();
  });

  it('answers from the real listing, unheld, once the owner has imported the item', async () => {
    const c = await ctx('Do you sell a trackable dog collar? I live in England.');
    await c.store.putLink({ cjPid: 'T1', state: 'imported', handle: 'smart-gps-pet-tracker' });
    c.admin = async (query: string, vars?: Record<string, unknown>) => {
      if (query.includes('productByHandle') && vars?.handle === 'smart-gps-pet-tracker') {
        return { productByHandle: { id: 'gid://shopify/Product/9', title: 'GPS Pet Tracker for Dog Collars', handle: 'smart-gps-pet-tracker', variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/90', title: 'Default Title', sku: 'T1', price: '27.49', availableForSale: true, inventoryQuantity: 50 } }] } } };
      }
      return query.includes('productByHandle') ? { productByHandle: null } : { products: { edges: [] } };
    };
    const g = await productAgent.ground(c);
    expect(g.confident).toBe(true);
    expect(g.holdReason).toBeUndefined();
    expect(g.facts).toContain('GPS Pet Tracker for Dog Collars');
    expect(g.facts).toContain('27.49');
  });
});
