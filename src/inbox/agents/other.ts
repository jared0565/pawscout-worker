import type { CategoryAgent, Grounding } from './types';

export const otherAgent: CategoryAgent = {
  category: 'other',
  displayName: 'General',
  description: 'General enquiries; safe generic handling',
  department: 'sales',
  commercial: false,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    // 2026-07-04 owner directive (the azanwatch3 "Collaboration Opportunity" /
    // "Is your store ready for order?" case): judge pitch-vs-question by the
    // MESSAGE TEXT alone - the subject line tripped the old decline branch and
    // produced a non-sequitur ("not something we are looking into") to a message
    // that asked a plain question. Ambiguous messages get their question
    // answered (the owner's 50/50 rule); a neutral answer costs nothing even if
    // the sender turns out to be a pitcher - the follow-up re-classification
    // routes the real pitch to the affiliate decline lane when it arrives.
    return 'Handle this general enquiry. Judge it by what the MESSAGE TEXT actually says: the subject line is context, never the question, and never enough on its own to treat a message as a pitch. If the message asks a genuine question, answer ONLY that question, in the first sentence, grounded strictly in the store facts, and hedge anything you do not know rather than guessing. When the message is ambiguous (for example a vague one-liner under a marketing-sounding subject), still answer the question it asks, warmly and neutrally, and invite them to say more: never a pre-emptive decline of an offer the message has not actually made, which reads as a non-sequitur. Worked example: subject "Collaboration Opportunity", message "Is your store ready for order?" gets a reply that we are open and taking orders plus a warm invitation to browse or share more detail, NOT a decline. Only when the message text ITSELF pitches a service (marketing, SEO, ads, store optimisation, growth, traffic, or a push to move to WhatsApp) do you decline the pitch: brief, WARM, gracious - thank them genuinely for the offer, say it is not something we are looking into right now, and wish them well. Example (pitch in the message text): "Thank you so much for the kind offer, we really appreciate you thinking of us. It is not something we are looking into right now, but we wish you all the best with it."';
  },
  deterministicAppendix(): string | null { return null; }
};
