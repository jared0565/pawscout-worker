import type { AdminGraphql } from './shopify-admin';
import { findCustomerByEmail } from './shopify-catalog';

export type CustomerOrder = {
  name: string;
  displayFulfillmentStatus: string;
  financialStatus: string;
  tracking: { number: string; company: string | null; url: string | null } | null;
  createdAt: string;
};

const ORDERS_BY_CUSTOMER = `query pawscoutCustomerOrders($id: ID!, $first: Int!) {
  customer(id: $id) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges { node {
        name displayFulfillmentStatus displayFinancialStatus createdAt
        fulfillments(first: 1) { trackingInfo(first: 1) { number company url } }
      } }
    }
  }
}`;

export async function recentOrdersForEmail(admin: AdminGraphql, email: string, first = 5): Promise<CustomerOrder[]> {
  const cust = await findCustomerByEmail(admin, email);
  if (!cust) return [];
  const data = await admin(ORDERS_BY_CUSTOMER, { id: cust.customerId, first });
  const edges = ((data.customer as { orders?: { edges?: { node: Record<string, unknown> }[] } })?.orders?.edges) ?? [];
  return edges.map((e) => {
    const n = e.node;
    const f = ((n.fulfillments as { trackingInfo?: { number?: string; company?: string; url?: string }[] }[]) ?? [])[0];
    const t = f?.trackingInfo?.[0];
    return {
      name: String(n.name ?? ''),
      displayFulfillmentStatus: String(n.displayFulfillmentStatus ?? 'UNKNOWN'),
      financialStatus: String(n.displayFinancialStatus ?? 'UNKNOWN'),
      createdAt: String(n.createdAt ?? ''),
      tracking: t && t.number ? { number: String(t.number), company: t.company ? String(t.company) : null, url: t.url ? String(t.url) : null } : null
    };
  });
}
