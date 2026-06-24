import type { CategoryAgent, Grounding } from './types';

export const affiliateAgent: CategoryAgent = {
  category: 'affiliate',
  displayName: 'Affiliate / Partnership',
  description: 'Policy-based partnership stance; commits to no terms',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'This is an affiliate or partnership enquiry: someone offering to promote or sell Active Paw products for a commission. Reply warmly and with genuine interest: thank them, say we are open to exploring partnerships, and ask about their audience, platform, reach, and how they would promote us. Do NOT commit to any commission rate, discount code, free product, terms, or agreement; those are decided separately.';
  },
  deterministicAppendix(): string | null { return null; }
};
