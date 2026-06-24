import type { CategoryAgent, Grounding } from './types';

export const otherAgent: CategoryAgent = {
  category: 'other',
  displayName: 'General',
  description: 'General enquiries; safe generic handling',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'Handle this general enquiry. Answer only what the customer actually asked, grounded strictly in the store facts. Hedge anything you do not know rather than guessing. If it is a sales or marketing pitch, decline politely.';
  },
  deterministicAppendix(): string | null { return null; }
};
