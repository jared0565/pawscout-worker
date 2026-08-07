import type { CategoryAgent, Grounding } from './types';
import { PARTNERSHIP_STANCE } from '../partnership';

export const wholesaleAgent: CategoryAgent = {
  category: 'wholesale-b2b',
  displayName: 'Wholesale / Trade',
  description: 'Policy: not offering trade terms; capture + owner-alert only',
  department: 'sales',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'This is a wholesale, trade, reseller, or bulk-order enquiry. Active Paw is focused on individual retail buyers and is not offering wholesale or trade terms right now. Politely say so in the first sentence, do not offer bulk discounts or reseller arrangements, and do not imply a wholesale programme or follow-up exists or is coming. You may say they are welcome to order individual items through the website. Example: "Thanks for your interest. We are focused on individual retail orders at the moment and are not offering wholesale terms, though you are very welcome to order any items through the website." '
      // 2026-08-07: wholesale-b2b is deliberately excluded from
      // PARTNERSHIP_CATEGORIES (a trade buyer is not an affiliate), so a trade
      // enquiry that ALSO asks about commission never reaches the funnel and
      // lands here. Without the stance this agent would decline the commission
      // question outright. Only volunteer the programme if they raise promoting
      // us - a pure bulk-order enquiry still just gets the retail answer.
      + PARTNERSHIP_STANCE;
  },
  deterministicAppendix(): string | null { return null; }
};
