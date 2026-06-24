import type { CategoryAgent, Grounding } from './types';

export const leadAgent: CategoryAgent = {
  category: 'lead',
  displayName: 'Sales Leads',
  description: 'Buyer-funnel: moves toward purchase with one concrete next step',
  commercial: true,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'This is a buyer who wants to purchase or is close to it. Be helpful and move the conversation toward purchase without pressure. Answer their question, then give exactly one concrete next step: the minimum detail you still need (size, style, quantity), or how to complete the order on the website. Never invent product URLs, prices, discounts, stock, or guarantees.';
  },
  deterministicAppendix(): string | null { return null; }
};
