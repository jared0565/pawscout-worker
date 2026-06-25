import type { CategoryAgent, Grounding } from './types';

export const otherAgent: CategoryAgent = {
  category: 'other',
  displayName: 'General',
  description: 'General enquiries; safe generic handling',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'Handle this general enquiry. Answer only what the customer actually asked, in the first sentence, grounded strictly in the store facts. Hedge anything you do not know rather than guessing. If it is a sales, marketing, SEO, or growth pitch, decline politely and briefly without engaging the pitch. Example (pitch): "Thanks for reaching out, but growing the store is not something we are looking into right now. Wishing you all the best."';
  },
  deterministicAppendix(): string | null { return null; }
};
