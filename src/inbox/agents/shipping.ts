// src/inbox/agents/shipping.ts (full implementation lands in Task 6; hedging stub shown)
import type { CategoryAgent } from './types';

export const shippingAgent: CategoryAgent = {
  category: 'shipping-returns',
  displayName: 'Shipping & Returns',
  description: 'Grounds delivery time in the CJ logistics matrix; returns/cost from store facts',
  commercial: true,
  async ground() { return { confident: false, facts: '', quotesFigure: false }; },
  promptFragment() { return 'Answer shipping, delivery, and returns questions from the store facts; hedge any delivery time you do not have grounded.'; },
  deterministicAppendix() { return null; }
};
