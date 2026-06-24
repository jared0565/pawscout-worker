// src/inbox/agents/shipping.ts
import type { CategoryAgent, AgentContext, Grounding } from './types';
import { isShippingIntent, deriveDestinationCountry, countryLabel, buildShippingLine } from '../freight';
import { resolveLogistics, doorToDoorBand, type DayRange } from '../../logistics';
import { resolveLineRequest } from '../../shopify-catalog';
import type { CjDetail } from '../../cj';

const SHIP_DEFAULT_ORIGIN = 'CN'; // Conservative default; overridden when real warehouse data exists

/**
 * Resolve the real dispatch origin for the product named in the customer message.
 * Fully guarded: returns null on any miss (no admin, product not resolved, no D1 row,
 * no origins data). When it returns non-null, the caller may use it as the `from`
 * country for the logistics route lookup. Never throws.
 *
 * Origin selection priority:
 *   1. Destination country (in-market, no customs leg) if it has stock > 0
 *   2. Best-stocked origin among all warehouses
 *   3. null (fall back to CN default)
 */
export async function resolveProductOrigin(ctx: AgentContext, dest: string): Promise<string | null> {
  try {
    if (!ctx.admin) return null;
    const resolved = await resolveLineRequest(ctx.admin, ctx.latestMessage.slice(0, 80));
    if (resolved.status !== 'resolved' || !resolved.variant) return null;
    const productId = resolved.variant.productId;
    if (!productId) return null;
    const link = await ctx.store.getLinkByShopifyProductId(productId);
    if (!link?.cj_pid) return null;
    const row = await ctx.store.getWarehouseProduct(link.cj_pid);
    if (!row?.detail) return null;
    let detail: CjDetail;
    try {
      detail = JSON.parse(row.detail) as CjDetail;
    } catch {
      return null;
    }
    const origins = detail.origins;
    if (!origins || Object.keys(origins).length === 0) return null;
    // Prefer in-market (same country as dest) to avoid customs
    if ((origins[dest] ?? 0) > 0) return dest;
    // Otherwise pick the best-stocked origin
    let best: string | null = null;
    let bestQty = 0;
    for (const [cc, qty] of Object.entries(origins)) {
      if (qty > bestQty) { best = cc; bestQty = qty; }
    }
    return best;
  } catch {
    return null;
  }
}

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
      // Phase 2: prefer the product's real warehouse origin when D1 has it
      const origin = await resolveProductOrigin(ctx, dest);
      let route = (origin && origin !== SHIP_DEFAULT_ORIGIN)
        ? await ctx.store.getLogisticsRoute(origin, dest, l.stalenessHours)
        : null;
      if (!route) route = await ctx.store.getLogisticsRoute(SHIP_DEFAULT_ORIGIN, dest, l.stalenessHours);
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
