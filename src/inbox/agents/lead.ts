import type { CategoryAgent, Grounding } from './types';

export const leadAgent: CategoryAgent = {
  category: 'lead',
  displayName: 'Sales Leads',
  description: 'Buyer-funnel: moves toward purchase with one concrete next step',
  commercial: true,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'You handle buyers and brand-interested enquiries. Two cases. (1) A genuine buyer: answer their question, then give exactly one concrete next step, the minimum detail you still need (size, style, quantity) or how to complete the order on the website. (2) Someone just being friendly or curious about the brand (e.g. "what inspired you", "how long have you been running this", "do you manage it yourself", "what is your favourite product"): answer warmly and briefly, then a light next step. CRITICAL: do not invent company history, tenure, backstory, how long we have traded, team size, or a single best-selling product you do not actually have grounded. If you do not know a personal detail, keep it general and honest (a shared love of pets) rather than making up facts. Never invent product URLs, prices, discounts, stock, or guarantees. Example (brand-curious): "That is kind of you, thank you. We started Active Paw out of a love for making everyday pet care simpler. Is there anything you are looking to pick up for your pet?"';
  },
  deterministicAppendix(): string | null { return null; }
};
