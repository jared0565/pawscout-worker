import { describe, it, expect } from 'vitest';
import { recentOrdersForEmail } from '../src/shopify-orders';

describe('recentOrdersForEmail', () => {
  it('returns [] when no customer matches', async () => {
    const admin = async (q: string) => q.includes('customers') ? { customers: { edges: [] } } : {};
    expect(await recentOrdersForEmail(admin as any, 'no@one.com')).toEqual([]);
  });
  it('maps order name, status, and tracking', async () => {
    const admin = async (q: string) => q.includes('customers')
      ? { customers: { edges: [{ node: { id: 'gid://shopify/Customer/1' } }] } }
      : { customer: { orders: { edges: [{ node: {
          name: '#1001', displayFulfillmentStatus: 'IN_TRANSIT', displayFinancialStatus: 'PAID', createdAt: '2026-06-20T00:00:00Z',
          fulfillments: [{ trackingInfo: [{ number: 'TRK1', company: 'Royal Mail', url: 'http://t/TRK1' }] }]
        } }] } } };
    const out = await recentOrdersForEmail(admin as any, 'a@b.com');
    expect(out[0]).toMatchObject({ name: '#1001', displayFulfillmentStatus: 'IN_TRANSIT', tracking: { number: 'TRK1', company: 'Royal Mail' } });
  });
});
