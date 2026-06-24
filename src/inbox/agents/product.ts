// src/inbox/agents/product.ts (full implementation lands in Task 7; hedging stub shown)
import type { CategoryAgent } from './types';

export const productAgent: CategoryAgent = {
  category: 'product-question',
  displayName: 'Product Questions',
  description: 'Resolves the asked-about product from the live catalog (availability, price, variants)',
  commercial: true,
  async ground() { return { confident: false, facts: '', quotesFigure: false }; },
  promptFragment() { return 'Answer the product question from the grounded facts; if you do not have the product detail, hedge and offer to confirm.'; },
  deterministicAppendix() { return null; }
};
