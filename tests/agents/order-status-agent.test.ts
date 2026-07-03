// tests/agents/order-status-agent.test.ts
import { describe, it, expect, vi } from 'vitest';
import { orderStatusAgent } from '../../src/inbox/agents/order-status';
import * as orders from '../../src/shopify-orders';

const ctx = (admin: any, latest: string) => ({
  store: {} as any, cfg: {} as any, admin, thread: { subject: '' }, conversation: latest,
  latestMessage: latest, contactEmail: 'a@b.com', customerName: null
}) as any;

describe('orderStatusAgent.ground', () => {
  it('hedges when admin is null', async () => {
    const g = await orderStatusAgent.ground(ctx(null, 'where is my order?'));
    expect(g.confident).toBe(false);
  });
  it('resolves a single recent order and emits a tracking appendix', async () => {
    vi.spyOn(orders, 'recentOrdersForEmail').mockResolvedValue([
      { name: '#1001', displayFulfillmentStatus: 'IN_TRANSIT', financialStatus: 'PAID', createdAt: '2026-06-20', tracking: { number: 'TRK1', company: 'Royal Mail', url: 'http://t/TRK1' } }
    ]);
    const g = await orderStatusAgent.ground(ctx(async () => ({}), 'where is my order?'));
    expect(g.confident).toBe(true);
    expect(orderStatusAgent.deterministicAppendix(g)).toContain('#1001');
    expect(orderStatusAgent.deterministicAppendix(g)).toContain('TRK1');
  });
  it('asks for an order number when multiple match and none is named', async () => {
    vi.spyOn(orders, 'recentOrdersForEmail').mockResolvedValue([
      { name: '#1001', displayFulfillmentStatus: 'IN_TRANSIT', financialStatus: 'PAID', createdAt: '2026-06-20', tracking: null },
      { name: '#1002', displayFulfillmentStatus: 'UNFULFILLED', financialStatus: 'PAID', createdAt: '2026-06-22', tracking: null }
    ]);
    const g = await orderStatusAgent.ground(ctx(async () => ({}), 'where is my order?'));
    expect(g.confident).toBe(false);
    expect(g.facts.toLowerCase()).toContain('order number');
  });
  it('picks order #1002 when explicitly named with hash', async () => {
    vi.spyOn(orders, 'recentOrdersForEmail').mockResolvedValue([
      { name: '#1001', displayFulfillmentStatus: 'IN_TRANSIT', financialStatus: 'PAID', createdAt: '2026-06-20', tracking: { number: 'TRK1', company: 'Royal Mail', url: 'http://t/TRK1' } },
      { name: '#1002', displayFulfillmentStatus: 'DELIVERED', financialStatus: 'PAID', createdAt: '2026-06-22', tracking: { number: 'TRK2', company: 'DPD', url: 'http://t/TRK2' } }
    ]);
    const g = await orderStatusAgent.ground(ctx(async () => ({}), 'where is order #1002?'));
    expect(g.confident).toBe(true);
    expect(orderStatusAgent.deterministicAppendix(g)).toContain('#1002');
  });
  it('prioritises #-prefixed match over ambient numbers', async () => {
    vi.spyOn(orders, 'recentOrdersForEmail').mockResolvedValue([
      { name: '#1001', displayFulfillmentStatus: 'IN_TRANSIT', financialStatus: 'PAID', createdAt: '2026-06-20', tracking: { number: 'TRK1', company: 'Royal Mail', url: 'http://t/TRK1' } },
      { name: '#1002', displayFulfillmentStatus: 'DELIVERED', financialStatus: 'PAID', createdAt: '2026-06-22', tracking: { number: 'TRK2', company: 'DPD', url: 'http://t/TRK2' } }
    ]);
    const g = await orderStatusAgent.ground(ctx(async () => ({}), 'my zip is 94107, where is order #1001?'));
    expect(g.confident).toBe(true);
    expect(orderStatusAgent.deterministicAppendix(g)).toContain('#1001');
  });
});

describe('orderStatusAgent stockout overlay (never "being prepared" for a parked order)', () => {
  const stockoutStore = (row: unknown) => ({ getOrderByName: async () => row });
  const withStore = (store: unknown, latest: string) => ({ ...ctx(async () => ({}), latest), store }) as any;
  const UNFULFILLED = { name: '#1001', displayFulfillmentStatus: 'UNFULFILLED', financialStatus: 'PAID', createdAt: '2026-07-01', tracking: null };

  it('overlays the D1 stockout hold: honest HELD facts + appendix, no dispatch wording', async () => {
    vi.spyOn(orders, 'recentOrdersForEmail').mockResolvedValue([UNFULFILLED]);
    const store = stockoutStore({ status: 'error', hold_reasons: JSON.stringify(['stockout: source stock 0 is below the ordered 1 for S1']) });
    const g = await orderStatusAgent.ground(withStore(store, 'where is my order?'));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('temporarily HELD');
    expect(g.facts).toContain('out of stock');
    expect(g.facts).toContain('Do NOT say the order is being prepared');
    const appendix = orderStatusAgent.deterministicAppendix(g)!;
    expect(appendix).toContain('temporarily held');
    expect(appendix).not.toContain('being prepared');
    expect(appendix).not.toMatch(/estimated|\d+-\d+ days/);
  });

  it('a NON-stockout error keeps the plain Shopify status (generic failures are not customer-facing)', async () => {
    vi.spyOn(orders, 'recentOrdersForEmail').mockResolvedValue([UNFULFILLED]);
    const store = stockoutStore({ status: 'error', hold_reasons: JSON.stringify(['fulfil: CJ system error 500']) });
    const g = await orderStatusAgent.ground(withStore(store, 'where is my order?'));
    expect(g.facts).toContain('being prepared');
    expect(orderStatusAgent.deterministicAppendix(g)).toContain('being prepared');
  });

  it('a D1 lookup failure degrades to the plain Shopify status', async () => {
    vi.spyOn(orders, 'recentOrdersForEmail').mockResolvedValue([UNFULFILLED]);
    const store = { getOrderByName: async () => { throw new Error('D1 down'); } };
    const g = await orderStatusAgent.ground(withStore(store, 'where is my order?'));
    expect(g.confident).toBe(true);
    expect(g.facts).toContain('being prepared');
  });
});
