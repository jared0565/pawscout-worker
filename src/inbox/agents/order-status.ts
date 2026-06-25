// src/inbox/agents/order-status.ts
import type { CategoryAgent, AgentContext, Grounding } from './types';
import { recentOrdersForEmail, type CustomerOrder } from '../../shopify-orders';

function pick(list: CustomerOrder[], message: string): CustomerOrder | null {
  // Try to match #-prefixed order number first (e.g., "#1001").
  // Known limitation: if customer names two different order numbers, only the first #-match is tried.
  const hashMatch = message.match(/#(\d{3,})/);
  if (hashMatch) {
    const hit = list.find((o) => o.name.replace(/\D/g, '') === hashMatch[1]);
    if (hit) return hit;
  }

  // Fall back to bare 3+ digit token (e.g., "1001").
  const bareMatch = message.match(/\b(\d{3,})\b/);
  if (bareMatch) {
    const hit = list.find((o) => o.name.replace(/\D/g, '') === bareMatch[1]);
    if (hit) return hit;
  }

  // Fallback: single order or none.
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
        facts: `Order ${order.name} is ${status}.`,
        data: order
      };
    } catch (e) {
      console.warn(`orderStatusAgent.ground failed: ${(e as Error).message}`);
      return hedge('Could not look up the order; ask for the order number and offer to check.');
    }
  },

  promptFragment(g: Grounding): string {
    void g;
    return 'You are the order-status specialist. Report only the grounded order status. Never invent an order number, status, date, or tracking number. A precise status/tracking line is appended after your reply, so do NOT restate the tracking number from that appendix. If no order is grounded, ask in the first sentence for the order number or the email used at checkout. After confirming status, a brief relationship touch is welcome but no pressure. Example (no order grounded): "Happy to check that for you. Could you share your order number or the email you used at checkout?"';
  },

  deterministicAppendix(g: Grounding): string | null {
    if (!g.confident) return null;
    const o = g.data as CustomerOrder | undefined;
    if (!o) return null;
    if (!o.tracking) return `Order ${o.name}: ${(FRIENDLY[o.displayFulfillmentStatus] ?? 'being processed')}.`;
    const carrier = o.tracking.company ? ` (${o.tracking.company})` : '';
    const url = o.tracking.url ? `: ${o.tracking.url}` : '';
    return `Order ${o.name}: ${(FRIENDLY[o.displayFulfillmentStatus] ?? 'being processed')}, tracking ${o.tracking.number}${carrier}${url}`;
  }
};

function hedge(facts: string): Grounding { return { confident: false, quotesFigure: false, facts }; }
