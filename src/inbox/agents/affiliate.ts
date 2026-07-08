import type { CategoryAgent, Grounding } from './types';

export const affiliateAgent: CategoryAgent = {
  category: 'affiliate',
  displayName: 'Affiliate / Partnership',
  description: 'Policy: not taking on partnerships; warm polite decline',
  department: 'partnership',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    // Owner policy 2026-07-03: decline ALL affiliate/partnership approaches politely.
    return 'This is an affiliate, influencer, or partnership enquiry. Active Paw is not taking on affiliate or promotional partnerships at the moment, so politely decline whatever is being offered: thank them genuinely for thinking of us, say we are not taking on partnerships right now, and wish them well. Do NOT ask qualifying questions, do not request links or audience details, do not suggest an application process or a follow-up, and never commit to any commission, discount code, free product, or terms. Keep it brief, warm, and final without being cold. Example: "Thank you so much for thinking of Active Paw, we really appreciate it. We are not taking on partnerships at the moment, but we wish you every success with your channel."';
  },
  deterministicAppendix(): string | null { return null; }
};
