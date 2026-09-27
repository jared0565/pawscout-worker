import type { CategoryAgent, Grounding } from './types';
import { PARTNERSHIP_STANCE } from '../partnership';

export const otherAgent: CategoryAgent = {
  category: 'other',
  displayName: 'General',
  description: 'General enquiries; safe generic handling',
  department: 'service',
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
    // 2026-08-07, SECOND ATTEMPT. Appending the stance AFTER the decline rule
    // did not work: deployed, regenerated live, and all three threads still
    // declined. The decline rule's own trigger list contained "growth, traffic"
    // and "a push to move to WhatsApp", and it carried a concrete worked
    // example, so a commission question matched it and the example won. Order
    // and specificity beat a longer policy further down the prompt. The stance
    // is now FIRST, and the decline list names the exception inline.
    return 'Handle this general enquiry. ' + PARTNERSHIP_STANCE + ' '
      + 'Now the general rules. Judge the message by what the MESSAGE TEXT actually says: the subject line is context, never the question, and never enough on its own to treat a message as a pitch. If the message asks a genuine question, answer ONLY that question, in the first sentence, grounded strictly in the store facts, and hedge anything you do not know rather than guessing. When the message is ambiguous (for example a vague one-liner under a marketing-sounding subject), still answer the question it asks, warmly and neutrally, and invite them to say more: never a pre-emptive decline of an offer the message has not actually made, which reads as a non-sequitur. Worked example: subject "Collaboration Opportunity", message "Is your store ready for order?" gets a reply that we are open and taking orders plus a warm invitation to browse or share more detail, NOT a decline. '
      // Owner rule 2026-09-17 (prove-first): the decline branch is gone. A service
      // offer made IN the message text gets the filter from the stance above; a
      // goods supplier gets a thank-you. The commission/orders exception below
      // is kept verbatim because it names the falsehoods that used to ship.
      + 'SERVICE OFFERS: when the message text itself offers to SELL US a service (marketing, SEO, ads, email campaigns, store optimisation, web development, product listings, content or video, virtual assistance), do NOT decline it and do NOT accept it: answer with the prove-first rule from the partnership policy above, in your own words, with the link and the figures. Everyone who wants to work with us starts with their own affiliate discount code, and tracked orders decide. '
      + 'GOODS SUPPLIERS: an offer to SUPPLY US products, packaging or materials, or warehousing, fulfilment or logistics services, belongs to the supplier lane; if one reaches you here, thank them for what they offered, say they are welcome to email their catalogue or product information, ask for their website or online store link, and commit to nothing: no order, no meeting, no next step, and no mention of the affiliate programme. '
      + 'Someone offering to BRING US ORDERS, SALES, TRAFFIC OR CUSTOMERS, or asking what commission, percentage or rate we offer, is asking about the affiliate programme, whether or not they use that word. Answer them from the partnership policy above, with the actual figures. Never reply that we cannot offer a percentage, that we have no programme, or that it is "not something we are looking into" - all three are false. A request to move to WhatsApp inside such a message is declined on its own (we stay on email) WITHOUT declining the partnership question itself.';
  },
  deterministicAppendix(): string | null { return null; }
};
