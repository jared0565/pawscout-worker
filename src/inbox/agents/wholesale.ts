// src/inbox/agents/wholesale.ts (full implementation lands in Task 10; hedging stub shown)
import type { CategoryAgent } from './types';

export const wholesaleAgent: CategoryAgent = {
  category: 'wholesale-b2b',
  displayName: 'Wholesale / Trade',
  description: 'Policy: not offering trade terms; capture + owner-alert only',
  commercial: false,
  async ground() { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment() { return 'This is a wholesale or trade enquiry; thank them, explain we are not offering trade terms right now, and say we have noted their interest. Do NOT quote trade pricing or commit to terms.'; },
  deterministicAppendix() { return null; }
};
