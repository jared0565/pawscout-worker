import type { CategoryAgent, Grounding } from './types';

export const otherAgent: CategoryAgent = {
  category: 'other',
  displayName: 'General',
  description: 'General enquiries; safe generic handling',
  department: 'sales',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    return 'Handle this general enquiry. If it is a genuine question, answer ONLY what the customer actually asked, in the first sentence, grounded strictly in the store facts, and hedge anything you do not know rather than guessing. If it is a sales/marketing/SEO/optimisation/growth/traffic pitch, or a push to move to WhatsApp, do NOT engage the pitch: give a brief, WARM, gracious decline - thank them genuinely for the offer, say it is not something we are looking into right now, and wish them well. Example (pitch): "Thank you so much for the kind offer, we really appreciate you thinking of us. It is not something we are looking into right now, but we wish you all the best with it."';
  },
  deterministicAppendix(): string | null { return null; }
};
