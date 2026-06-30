import type { CategoryAgent, Grounding } from './types';

export const affiliateAgent: CategoryAgent = {
  category: 'affiliate',
  displayName: 'Affiliate / Partnership',
  description: 'Policy-based partnership stance; commits to no terms',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'This is a partnership enquiry from someone offering to promote Active Paw for a commission. TRIAGE first. If they look like a GENUINE creator/influencer with a real pet-owning audience, engage warmly and qualify them: ask the two or three most useful specifics - where they would promote us (a link to their channel or page), roughly how big and engaged their audience is and which country, and how they would feature our products - and add that partnerships are performance-based with exact terms agreed once it looks like a good fit. Do NOT commit to any commission rate, discount code, free product, or agreement; those are decided separately. If instead it reads like a generic traffic/sales/marketing service dressed up as a "partnership" or "collaboration" (no real audience, only promises of visitors or sales, or a push to move to WhatsApp), give a brief, warm, gracious decline and wish them well. Example (genuine): "We are open to exploring partnerships, thank you for thinking of us. Could you share where you would promote us (a link), a sense of your audience size and country, and how you would feature our products? Partnerships are performance-based and we agree exact terms once it looks like a fit."';
  },
  deterministicAppendix(): string | null { return null; }
};
