import { describe, it, expect } from 'vitest';
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
