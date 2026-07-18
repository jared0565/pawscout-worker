import type { CategoryAgent, Grounding } from './types';
import { AFFILIATE_APPLY_URL } from '../partnership';

export const affiliateAgent: CategoryAgent = {
  category: 'affiliate',
  displayName: 'Affiliate / Partnership',
  description: 'Policy: partnerships run through the self-serve application page',
  department: 'partnership',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    // Owner policy 2026-07-18 (supersedes the 2026-07-03 decline-all): the
    // self-serve affiliate marketplace is live, so partnership interest is
    // routed to the application page instead of an email back-and-forth.
    return 'This is an affiliate, influencer, or partnership enquiry. Active Paw runs its affiliate programme through a self-serve application page. '
      + 'First answer whatever they actually asked in their message, briefly and honestly. Then, if they are interested in partnering or promoting us, point them to the application page: '
      + AFFILIATE_APPLY_URL
      + ' and say the application takes a few minutes (where they would promote us and a little about their audience), and that if it is a fit their personal discount code and terms are set up from there. '
      + 'Do NOT run the screening yourself: no qualifying questions, no requests for links or audience details over email, and never commit in email to any commission rate, discount code, free product, or terms - the application page carries the terms. '
      + 'NEVER offer or agree to store access of any kind (collaborator accounts, admin access, staff accounts): partnerships run entirely on a personal discount code and the public site, so access is never needed and never granted. '
      + 'Keep it brief, warm, and direct.';
  },
  deterministicAppendix(): string | null { return null; }
};
