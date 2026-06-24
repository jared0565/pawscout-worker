import { describe, it, expect } from 'vitest';
import { productAgent } from '../../src/inbox/agents/product';

const mkCtx = (admin: any, latest = 'is the blue harness good for puppies?') => ({
  store: {} as any, cfg: {} as any, admin, thread: { subject: '' }, conversation: latest,
  latestMessage: latest, contactEmail: 'a@b.com', customerName: null
}) as any;

const singleProductAdmin = async () => ({
  products: { edges: [{ node: { id: 'p1', title: 'Blue Harness', variants: { edges: [{ node: { id: 'v1', title: 'M', sku: 'BH-M', price: '12.00', availableForSale: true, inventoryQuantity: 5 } }] } } }] }
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
