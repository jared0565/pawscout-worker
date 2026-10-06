import type { AgentContext, Grounding } from './types';
import { deriveDestinationCountry, countryLabel } from '../freight';
import { localWarehousesFor } from '../../local-markets';
import { supplierOffers, type SupplierOffer } from '../../sourcing/offers';

/** A catalog miss with no supplier match either. Never sends them to the website search. */
export const NO_MATCH_FACTS = 'We do not stock a matching item right now. Say so plainly and that the team will look into sourcing it; do not ask them to search for it themselves.';

/** The overseas wording every product answer shares (owner rule 2026-09-30), so
 *  a sourced offer and the same item answered from the catalog say the same. */
export const OVERSEAS_FACTS = 'It is not held in a local warehouse: it ships from overseas. Say that plainly.';
export const COUNTRY_UNKNOWN_FACTS = 'Their country is not known: do not state a delivery time; ask which country it would be delivered to.';
export const NEVER_NAME_ORIGIN = 'Never name the country it ships from, the supplier, or any product code, and never suggest it is sent from the UK.';

/** Grounded facts for a sourced item. Local-for-local wording: overseas stock is
 *  said plainly; the origin country, the supplier and any SKU are never named. */
export function offerFacts(o: SupplierOffer, dest: string | null): string {
  const where = o.overseas
    ? OVERSEAS_FACTS
    : (dest ? 'It is stocked in a warehouse that serves their country.' : '');
  const delivery = dest && o.days
    ? `Estimated delivery to ${countryLabel(dest)}: ${o.days} days from order. You MAY state this.`
    : COUNTRY_UNKNOWN_FACTS;
  return `Not in our catalog yet, but the team can source this item for them at GBP ${o.priceGbp.toFixed(2)} (our price): ${o.title}. You MAY state that price. ${where} ${delivery} `
    + `Describe the item in your own plain words (for example "a GPS tracker that clips to your dog's collar"), only from what these supplier notes support; never copy the listing title, a model code or a brand name: ${o.descriptionText || 'none'}. `
    + `${NEVER_NAME_ORIGIN} Ask whether they would like one; the team will send the link.`;
}

/**
 * Owner rule 2026-09-30: when our catalog has no match, look the item up at the
 * supplier and tell the customer the real situation. The draft is held
 * (`sourcing_offer`) so the owner imports the item before it is sent.
 */
export async function sourcingGrounding(ctx: AgentContext, query: string): Promise<Grounding> {
  const none: Grounding = { confident: false, quotesFigure: false, facts: NO_MATCH_FACTS };
  if (!ctx.cj || !query.trim()) return none;
  const dest = deriveDestinationCountry(ctx.conversation, ctx.thread.subject ?? '', ctx.contactEmail);
  if (dest && !localWarehousesFor(dest).length) {
    return { confident: true, quotesFigure: false, facts: `We do not stock that item, and the sender appears to be in ${countryLabel(dest)}, which we do not currently deliver to. Say so plainly and apologise briefly.` };
  }
  let offers: SupplierOffer[] = [];
  try {
    offers = await supplierOffers(ctx.store, ctx.cj, ctx.cfg, query, dest ?? 'GB', { limit: 1 });
  } catch (e) {
    console.warn(`sourcing lookup failed: ${(e as Error).message}`);
  }
  const o = offers[0];
  if (!o) return none;
  // An item the owner has already imported: the caller re-grounds on its real
  // product page (Shopify price after the import's profit gate, availability,
  // link) instead of this pre-import offer.
  return { confident: true, quotesFigure: true, holdReason: 'sourcing_offer', facts: offerFacts(o, dest), data: { sourcingPid: o.pid, sourcingHandle: o.handle } };
}
