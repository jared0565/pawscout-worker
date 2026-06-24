// src/inbox/agents/order-status.ts
import type { CategoryAgent, AgentContext, Grounding } from './types';
import { recentOrdersForEmail, type CustomerOrder } from '../../shopify-orders';

const ORDER_NO_RE = /#?\b(\d{3,})\b/; // a 3+ digit token, optionally #-prefixed

function pick(list: CustomerOrder[], message: string): CustomerOrder | null {
  const m = message.match(ORDER_NO_RE);
  if (m) {
    const hit = list.find((o) => o.name.replace(/\D/g, '') === m[1]);
    if (hit) return hit;
  }
  return list.length === 1 ? list[0] : null;
}

const FRIENDLY: Record<string, string> = {
  IN_TRANSIT: 'on its way',
  OUT_FOR_DELIVERY: 'out for delivery',
  DELIVERED: 'delivered',
  FULFILLED: 'dispatched',
  UNFULFILLED: 'being prepared',
  PARTIALLY_FULFILLED: 'partly dispatched'
};

export const orderStatusAgent: CategoryAgent = {
  category: 'order-status',
  displayName: 'Order Status',
  description: 'Looks up the customer\'s order + tracking from Shopify',
  commercial: true,

  async ground(ctx: AgentContext): Promise<Grounding> {
    try {
      if (!ctx.admin) return hedge('Order lookup is not connected right now; ask the customer for their order number and say you will check.');
      const list = await recentOrdersForEmail(ctx.admin, ctx.contactEmail);
      if (list.length === 0) return hedge('No order found for this email; ask for the order number or the email used at checkout.');
      const order = pick(list, ctx.latestMessage);
      if (!order) return hedge('Multiple orders found; ask which order number they mean.');
      const status = FRIENDLY[order.displayFulfillmentStatus] ?? 'being processed';
      return {
        confident: true,
        quotesFigure: true,
        facts: `Order ${order.name} is ${status}. A precise status/tracking line is appended after your reply, so confirm the status warmly but do NOT restate the tracking number or invent any detail.`,
        data: order
      };
    } catch (e) {
      console.warn(`orderStatusAgent.ground failed: ${(e as Error).message}`);
      return hedge('Could not look up the order; ask for the order number and offer to check.');
    }
  },

  promptFragment(g: Grounding): string {
    void g;
    return 'You are the order-status specialist. Report only the grounded order status. Never invent an order number, status, date, or tracking number. If no order is grounded, politely ask for the order number or the email used at checkout. After confirming status, a soft relationship touch is welcome but no pressure.';
  },

  deterministicAppendix(g: Grounding): string | null {
    if (!g.confident) return null;
    const o = g.data as CustomerOrder | undefined;
    if (!o) return null;
    if (!o.tracking) return `Order ${o.name}: ${(FRIENDLY[o.displayFulfillmentStatus] ?? 'being processed')}.`;
    const carrier = o.tracking.company ? ` (${o.tracking.company})` : '';
    const url = o.tracking.url ? `: ${o.tracking.url}` : '';
    return `Order ${o.name}: ${(FRIENDLY[o.displayFulfillmentStatus] ?? 'dispatched')}, tracking ${o.tracking.number}${carrier}${url}`;
  }
};

function hedge(facts: string): Grounding { return { confident: false, quotesFigure: false, facts }; }
