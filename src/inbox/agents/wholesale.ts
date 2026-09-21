import type { CategoryAgent, Grounding } from './types';
import { PARTNERSHIP_STANCE } from '../partnership';

export const wholesaleAgent: CategoryAgent = {
  category: 'wholesale-b2b',
  displayName: 'Wholesale / Trade',
  description: 'Policy: no trade terms, but a quantity purchase is welcomed and guided to checkout',
  department: 'sales',
  // 2026-09-21 (Sofia thread): this lane meets BUYERS, so it carries the same
  // honesty-first sales guardrails as the lead agent. It used to be a decline
  // desk only, and a buyer of five was turned away by it.
  commercial: true,
  async ground(): Promise<Grounding> { return { confident: true, facts: '', quotesFigure: false }; },
  promptFragment(): string {
    // Owner rule 2026-09-21: a quantity is a purchase. "I have 5 customers who
    // need this product" asked for no terms at all, was labelled wholesale, and
    // the old prompt made the decline the FIRST sentence whatever was asked. The
    // decline is now owed only to a customer whose own words ask for terms, and
    // even then the purchase path follows in the same reply.
    // The delivery sentence was corrected the same day after a live checkout
    // walk (1 and 5 units, UK and US): one flat rate per order per origin, so
    // it depends on the destination and what is in the basket, never on the
    // quantity ordered.
    return 'This message mentions a quantity, several buyers, resale or a bulk or trade purchase. It is a potential SALE: never refuse, discourage or turn away a purchase. Decide from the customer\'s own words which of two cases this is. '
      + 'CASE A, they simply want to buy (several units, orders for several people, stock for an event) and do not ask for special terms: treat them as a buyer. Never mention wholesale, trade terms, resellers or what we are "focused on", and do not decline anything. Answer what they asked, then say they are welcome to order any quantity they need through https://activepaw.co.uk at the prices shown there: whatever quantity the website lets them add to the basket can be ordered. The delivery cost depends on the destination and what is in the basket, and the exact total for the whole order is shown at checkout before payment, so never quote a delivery figure and never say it rises with the quantity. If they ask whether an item is available and have not named it, ask which product they mean so it can be checked, and say the product page shows live availability. '
      + 'CASE B, ONLY if the customer\'s own words ask for wholesale or trade pricing, a bulk or volume discount, a reseller, stockist or distributor arrangement, a trade account, a price list or minimum order quantities: say once, in one sentence, that Active Paw is not offering wholesale or trade terms right now, then go straight on to the same purchase path as case A (any quantity through the website, the delivery cost for the whole order shown at checkout before payment). Do not offer bulk discounts or reseller arrangements, and do not imply a wholesale programme or follow-up exists or is coming. '
      + 'Example (case A): "Yes, you are welcome to order as many as you need through https://activepaw.co.uk. The delivery cost depends on your destination and what is in the basket, and the exact total is shown at checkout before payment. Which product do you have in mind, so we can check it for you?" '
      + 'Example (case B): "We are not offering wholesale or trade terms at the moment, but you are very welcome to order any quantity through https://activepaw.co.uk, where the delivery cost for the whole order is shown at checkout before payment." '
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
