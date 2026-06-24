// src/inbox/agents/other.ts (full implementation lands in Task 12; stub form shown)
import type { CategoryAgent } from './types';

export const otherAgent: CategoryAgent = {
  category: 'other',
  displayName: 'General',
  description: 'General enquiries; safe generic handling',
  commercial: false,
  async ground() { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment() { return 'Answer only what the customer asked, grounded in the facts; hedge anything unknown.'; },
  deterministicAppendix() { return null; }
};
