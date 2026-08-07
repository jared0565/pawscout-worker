import type { CategoryAgent, Grounding } from './types';
import { PARTNERSHIP_STANCE } from '../partnership';

export const leadAgent: CategoryAgent = {
  category: 'lead',
  displayName: 'Sales Leads',
  description: 'Buyer-funnel: moves toward purchase with one concrete next step',
  department: 'sales',
  commercial: true,
  // Owner ask 2026-07-03: nudge leads toward the on-site search bar. Deterministic,
  // post-signature (the classic most-read P.S. slot), first reply of a thread only.
  postscript: 'P.S. 🔍 On the hunt for something in particular? The search bar on activepaw.co.uk is the quickest way to find the right product for your pet.',
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'You handle buyers and brand-interested enquiries. Your goal is to help a genuine buyer complete their purchase. Two cases. (1) A genuine buyer: answer their question, then give exactly one concrete next step, the minimum detail you still need (size, style, quantity) or how to complete the order on the website. If the grounded facts name a related item we actually stock, you MAY mention exactly ONE of them as a natural companion to what they are buying (a gentle cross-sell); never invent or guess a product, price, discount, or stock level, and drop the idea entirely if nothing grounded fits. (2) Someone just being friendly or curious about the brand (e.g. "what inspired you", "how long have you been running this", "do you manage it yourself", "what is your favourite product"): answer warmly and briefly, then a light next step. CRITICAL: do not invent company history, tenure, backstory, how long we have traded, team size, or a single best-selling product you do not actually have grounded. If you do not know a personal detail, keep it general and honest (a shared love of pets) rather than making up facts. Never invent product URLs, prices, discounts, stock, or guarantees. Example (brand-curious): "That is kind of you, thank you. We started Active Paw out of a love for making everyday pet care simpler. Is there anything you are looking to pick up for your pet?" '
      // 2026-08-07: a brand-interested enquiry ("I love your products, can I
      // work with you?") classifies as a lead, so this agent can meet a
      // partnership question too. Only relevant when they raise it; an ordinary
      // buyer never sees any of this.
      + PARTNERSHIP_STANCE;
  },
  deterministicAppendix(): string | null { return null; }
};
