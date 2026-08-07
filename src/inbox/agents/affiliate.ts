import type { CategoryAgent, Grounding } from './types';
import { AFFILIATE_APPLY_URL, PARTNERSHIP_STANCE } from '../partnership';

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
    // 2026-08-07: the old "never commit in email to any commission rate - the
    // application page carries the terms" instruction is GONE, by owner ruling.
    // It was the reason a direct "what percentage would you offer?" came back
    // unanswered. The rate now ships in the reply, from PARTNERSHIP_STANCE, so
    // it still cannot drift from the apply page.
    return 'This is an affiliate, influencer, or partnership enquiry. '
      + 'First answer whatever they actually asked in their message, briefly and honestly, then set out the programme. '
      + PARTNERSHIP_STANCE + ' '
      + 'Do NOT run the screening yourself: no qualifying questions and no requests for links or audience details over email, and never promise a discount code, free product, exclusivity or any term beyond the commission figures above - the application page carries the full terms. '
      + 'NEVER offer or agree to store access of any kind (collaborator accounts, admin access, staff accounts): partnerships run entirely on a personal discount code and the public site, so access is never needed and never granted. '
      + 'Keep it brief, warm, and direct.';
  },
  deterministicAppendix(): string | null { return null; }
};
