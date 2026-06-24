// src/inbox/agents/affiliate.ts (full implementation lands in Task 8; hedging stub shown)
import type { CategoryAgent } from './types';

export const affiliateAgent: CategoryAgent = {
  category: 'affiliate',
  displayName: 'Affiliate / Partnership',
  description: 'Policy-based partnership stance; commits to no terms',
  commercial: false,
  async ground() { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment() { return 'This is an affiliate or partnership enquiry; reply warmly, say we are open to exploring partnerships, and ask for their audience and reach. Do NOT commit to any commission rate or terms.'; },
  deterministicAppendix() { return null; }
};
