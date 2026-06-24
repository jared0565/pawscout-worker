// src/inbox/agents/order-status.ts (full implementation lands in Task 11; hedging stub shown)
import type { CategoryAgent } from './types';

export const orderStatusAgent: CategoryAgent = {
  category: 'order-status',
  displayName: 'Order Status',
  description: 'Looks up the customer\'s order + tracking from Shopify',
  commercial: true,
  async ground() { return { confident: false, facts: '', quotesFigure: false }; },
  promptFragment() { return 'Help with the order-status question; if you cannot look up the order, ask for the order number and say you will check.'; },
  deterministicAppendix() { return null; }
};
