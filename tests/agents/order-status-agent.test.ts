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
});
