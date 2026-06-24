// src/inbox/agents/complaint.ts (full implementation lands in Task 12; hedging stub shown)
import type { CategoryAgent } from './types';

export const complaintAgent: CategoryAgent = {
  category: 'complaint',
  displayName: 'Complaints',
  description: 'Empathetic resolution; no commercial objective',
  commercial: false,
  async ground() { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment() { return 'This is a complaint; respond with empathy, acknowledge the issue, and set out the next step to resolve it from the store facts. Do NOT make commercial offers.'; },
  deterministicAppendix() { return null; }
};
