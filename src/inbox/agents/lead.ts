// src/inbox/agents/lead.ts (full implementation lands in Task 9; hedging stub shown)
import type { CategoryAgent } from './types';

export const leadAgent: CategoryAgent = {
  category: 'lead',
  displayName: 'Sales Leads',
  description: 'Buyer-funnel: moves toward purchase with one concrete next step',
  commercial: true,
  async ground() { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment() { return 'This is a buyer enquiry; answer helpfully and end with at most one concrete, low-pressure next step toward a purchase.'; },
  deterministicAppendix() { return null; }
};
