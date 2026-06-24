// src/inbox/agents/shipping.ts
import type { CategoryAgent, AgentContext, Grounding } from './types';
import { isShippingIntent, deriveDestinationCountry, countryLabel, buildShippingLine } from '../freight';
import { resolveLogistics, doorToDoorBand, type DayRange } from '../../logistics';

const SHIP_DEFAULT_ORIGIN = 'CN'; // Phase 1 conservative default; Phase 2 resolves per product

export const shippingAgent: CategoryAgent = {
  category: 'shipping-returns',
  displayName: 'Shipping & Returns',
  description: 'Grounds delivery time in the CJ logistics matrix; returns/cost from store facts',
  commercial: true,
  async ground(ctx: AgentContext): Promise<Grounding> {
    try {
      const subject = ctx.thread.subject ?? '';
      const relevant = isShippingIntent(null, '', ctx.latestMessage)
        || deriveDestinationCountry(ctx.latestMessage, '', ctx.contactEmail) !== null;
      if (!relevant) return notConfident();
      const dest = deriveDestinationCountry(ctx.conversation, subject, ctx.contactEmail);
      if (!dest) return notConfident();
      const l = resolveLogistics(ctx.cfg.fulfil);
      const route = await ctx.store.getLogisticsRoute(SHIP_DEFAULT_ORIGIN, dest, l.stalenessHours);
      const band = doorToDoorBand(route, l);
      if (!band) return notConfidentFacts(dest); // known dest, no figure -> hedge time, keep cost
      return {
        confident: true,
        quotesFigure: true,
        facts: `Destination ${countryLabel(dest)}. A grounded delivery estimate line is appended after your reply, so do NOT state a delivery time yourself. You MAY state the flat shipping cost and the returns policy from the store facts. Do not add a sign-off; the appended line follows your text.`,
        data: { label: countryLabel(dest), band }
      };
    } catch (e) {
      console.warn(`shippingAgent.ground failed: ${(e as Error).message}`);
      return notConfident();
    }
  },
  promptFragment(): string {
    return 'You are the shipping and returns specialist. Answer delivery, returns, and shipping-cost questions. If a grounded delivery line is appended, do not state a time yourself. State the honest delivery figure plainly first; any reassurance (tracking link on dispatch, returns cover) comes after, never softening the figure. Never name the dispatch country.';
  },
  deterministicAppendix(g: Grounding): string | null {
    const d = g.data as { label: string; band: DayRange } | undefined;
    if (!g.confident || !d) return null;
    return buildShippingLine(d.label, d.band); // "Delivery to X: estimated A-B days."
  }
};

function notConfident(): Grounding { return { confident: false, facts: '', quotesFigure: false }; }
function notConfidentFacts(_dest: string): Grounding {
  return { confident: false, quotesFigure: false, facts: `Destination mentioned but no grounded delivery estimate is available; hedge on time (say we confirm the timeframe when dispatched) but you MAY still state the flat shipping cost and returns policy from the store facts.` };
}
