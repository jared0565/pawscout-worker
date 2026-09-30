// src/inbox/agents/shipping.ts
import type { CategoryAgent, AgentContext, Grounding } from './types';
import { isShippingIntent, deriveDestinationCountry, countryLabel, buildShippingLine } from '../freight';
import { resolveLogistics, doorToDoorBand, formatBand, type DayRange, type LogisticsRoute } from '../../logistics';
import { resolveLineRequest, extractProductHandle } from '../../shopify-catalog';
import { resolveNearestRoute } from '../../shipping/nearest-route';
import { localWarehousesFor, laneVisibilityModeFor, allowedOriginsFor } from '../../local-markets';
import type { CjDetail } from '../../cj';

const SHIP_DEFAULT_ORIGIN = 'CN'; // Used for the ask-for-item fallback band only (transitional lanes); per-item routing uses resolveNearestRoute

export type ItemShippingResult =
  | { kind: 'resolved'; chosenOrigin: string; route: LogisticsRoute; cjPid: string; repVid: string | null; verifiedGbWarehouse: boolean }
  | { kind: 'unfulfillable'; dest: string; cjPid: string; verifiedGbWarehouse: boolean };


/**
 * Resolve the inquiry's product (high-confidence only) plus its nearest in-stock
 * warehouse route for `dest` via the nearest-warehouse resolver, restricted to
 * the destination's local-for-local lane (+ CN scaffolding while transitional).
 * Returns null when no confident product is identified (ask-for-item path unchanged).
 * Returns unfulfillable when a product IS identified but the buyer's market does
 * not sell it (cross-lane stock) or no real route to dest exists.
 * Returns resolved with the chosen origin and route when a real route is found.
 *
 * Signal priority:
 *   1. Product URL/handle in the message (strongest - does not require admin)
 *   2. Confident single free-text catalog match via resolveLineRequest
 *
 * Route resolution: D1 matrix ONLY (the same rows the checkout profile sync reads),
 * so the agent never declares a destination shippable that checkout would block.
 * NEVER borrows a route for a different destination (quote == checkout).
 */
export async function resolveItemShipping(ctx: AgentContext, dest: string): Promise<ItemShippingResult | null> {
  try {
    // Signal 1: a product URL/handle in the message (strongest, most specific).
    let cjPid: string | null = null;
    const handle = extractProductHandle(ctx.latestMessage); // shared with the product agent (shopify-catalog)
    if (handle) {
      cjPid = (await ctx.store.getLinkByHandle(handle))?.cj_pid ?? null;
      if (!cjPid) return null; // handle present but not in catalog -> do NOT fall through to free-text
    }
    // Signal 2: a confident single free-text catalog match (only when NO handle was present).
    if (!cjPid) {
      if (!ctx.admin) return null;
      const resolved = await resolveLineRequest(ctx.admin, ctx.latestMessage.slice(0, 80));
      if (resolved.status !== 'resolved' || !resolved.variant?.productId) return null;
      cjPid = (await ctx.store.getLinkByShopifyProductId(resolved.variant.productId))?.cj_pid ?? null;
    }
    if (!cjPid) return null;

    const row = await ctx.store.getWarehouseProduct(cjPid);
    if (!row?.detail) return null;
    let detail: CjDetail;
    try { detail = JSON.parse(row.detail) as CjDetail; } catch { return null; }
    const origins = detail.origins;
    if (!origins || Object.keys(origins).length === 0) return null;

    const verifiedGbWarehouse = (origins.GB ?? origins.UK ?? 0) > 0; // CJ aliases GB as UK
    const variants = detail.variants ?? [];
    const repVid = (variants.find((v) => (v.stock ?? 0) > 0) ?? variants[0])?.vid ?? null;
    const l = resolveLogistics(ctx.cfg.fulfil);

    // Local-for-local: the ONLY origins that may answer for this buyer are the
    // destination's own lane warehouses plus, while the lane is transitional,
    // the CN scaffolding - the SAME rule that builds the market catalogs. A
    // cross-lane warehouse (e.g. US stock for a UK buyer) is never a candidate
    // even when the route matrix has a row for it: the storefront will not
    // sell that item to this buyer, so the draft must not promise delivery.
    // Normalized (UK -> GB) so alias-keyed origins hit the matrix rows.
    const allowedOrigins = allowedOriginsFor(origins, dest);
    if (!allowedOrigins.length) return { kind: 'unfulfillable', dest, cjPid, verifiedGbWarehouse };

    // Candidate routes: the matrix row for each ALLOWED warehouse to dest.
    // Candidates come ONLY from D1 (ctx.store.getLogisticsRoute). No live-CJ fallback:
    // the live freight API can return routes the static delivery-profile sync never emits
    // (sync reads D1 only), so a live fallback breaks the quote==checkout invariant.
    const candidates: LogisticsRoute[] = [];
    for (const oc of allowedOrigins) {
      const r = await ctx.store.getLogisticsRoute(oc, dest, l.stalenessHours);
      if (r) candidates.push(r);
    }

    const resolved = resolveNearestRoute(candidates);
    if (!resolved.fulfillable) return { kind: 'unfulfillable', dest, cjPid, verifiedGbWarehouse };
    return { kind: 'resolved', chosenOrigin: resolved.nearest.origin, route: resolved.nearest.route, cjPid, repVid, verifiedGbWarehouse };
  } catch {
    return null;
  }
}

export const shippingAgent: CategoryAgent = {
  category: 'shipping-returns',
  displayName: 'Shipping & Returns',
  description: 'Grounds delivery time in the CJ logistics matrix; returns/cost from store facts',
  department: 'service',
  commercial: true,
  async ground(ctx: AgentContext): Promise<Grounding> {
    try {
      const subject = ctx.thread.subject ?? '';
      const relevant = isShippingIntent(null, '', ctx.latestMessage)
        || deriveDestinationCountry(ctx.latestMessage, '', ctx.contactEmail) !== null;
      if (!relevant) return notConfident();
      const dest = deriveDestinationCountry(ctx.conversation, subject, ctx.contactEmail);
      if (!dest) return notConfident();

      // Local-for-local: a destination with NO lane is a destination the store
      // has no market for - checkout cannot take that address, so the draft
      // must say so plainly instead of quoting a courier route that exists at
      // CJ but not for our buyers (a Japan inquiry used to get a delivery band).
      const lane = localWarehousesFor(dest);
      if (!lane.length) {
        const label = countryLabel(dest);
        return {
          confident: true, quotesFigure: false,
          facts: `We do not currently deliver to ${label}. Say so plainly and apologise briefly. Do NOT state a delivery time or suggest checkout will accept the order.`,
          data: { unserved: true, label }
        };
      }
      const l = resolveLogistics(ctx.cfg.fulfil);
      const item = await resolveItemShipping(ctx, dest);

      // No confident item -> ask which item, but DEFAULT the soft anchor to the NEAREST
      // LANE warehouse for this destination, not the slowest CN route. A no-item
      // question is often a buying signal; leading with the worst case works against
      // the sale. The lane is what the buyer's market actually sells from (a Canadian
      // buyer anchors on US->CA, a French buyer on the EU warehouses), and CN is the
      // fallback only while the lane is still transitional. The exact time still
      // depends on the specific product's warehouse, which is exactly why we ask for
      // the item. Time only, never an origin.
      if (!item) {
        const laneRoutes: LogisticsRoute[] = [];
        for (const w of lane) {
          const r = await ctx.store.getLogisticsRoute(w, dest, l.stalenessHours);
          if (r) laneRoutes.push(r);
        }
        const nearestLane = resolveNearestRoute(laneRoutes);
        const fallbackRoute = laneVisibilityModeFor(dest) === 'transitional'
          ? await ctx.store.getLogisticsRoute(SHIP_DEFAULT_ORIGIN, dest, l.stalenessHours)
          : null;
        const generic = doorToDoorBand(nearestLane.fulfillable ? nearestLane.nearest.route : fallbackRoute, l);
        const genericBand = formatBand(generic);
        // Only include the soft-anchor clause when we actually have a band; an empty band
        // would otherwise produce a dangling fragment.
        const softAnchor = genericBand
          ? ` Lead with a helpful estimate: the fastest options reach ${countryLabel(dest)} in around ${genericBand} days, and the exact delivery time depends on the specific product and which warehouse stocks it.`
          : '';
        return {
          confident: false, quotesFigure: false,
          facts: `The customer asked about delivery time but did not name a specific product.${softAnchor} Then ASK which item (or a product link) so you can confirm the exact time. You MAY tell the customer the exact shipping cost for their destination is shown at checkout; do NOT state a specific shipping figure. You MAY state the returns policy from the store facts.`,
          data: { askForItem: true }
        };
      }

      // Product identified but no real route to this destination exists.
      if (item.kind === 'unfulfillable') {
        const label = countryLabel(dest);
        return {
          confident: true, quotesFigure: false,
          facts: `We are not able to ship this item to ${label} at the moment. Apologise briefly and offer to help the customer find an alternative product that we can ship to them. Do NOT state a delivery time.`,
          data: { unfulfillable: true, label }
        };
      }

      // item.kind === 'resolved': compute the band from the nearest-warehouse route.
      const band = doorToDoorBand(item.route, l);
      if (!band) return notConfidentFacts(dest);

      const verifiedGb = item.verifiedGbWarehouse && dest === 'GB';
      // Free-UK-delivery clause (widened 2026-07-03, free-UK cutover): once the owner
      // flips gbFreeUkLive - only after a live GBP-0 checkout is verified - UK delivery
      // is free STOREWIDE (checkout charges 0 on every shipping profile; the item's
      // freight is baked into the sticker by the pricing rule). The claim therefore
      // applies to ANY resolved item with a GB destination, not just GB-warehoused
      // stock; the verify-then-flip flag remains the sole gate.
      const gbFreeUk = dest === 'GB' && ctx.cfg.fulfil?.gbFreeUkLive === true;
      return {
        confident: true, quotesFigure: true,
        facts: `Destination ${countryLabel(dest)}. A grounded delivery estimate line is appended after your reply, so do NOT state a delivery time yourself. You MAY tell the customer the exact shipping cost for their destination is calculated and shown at checkout before payment - do NOT state a specific shipping figure. You MAY state the returns policy. Do not add a sign-off; the appended line follows your text.`,
        data: { label: countryLabel(dest), band, verifiedGb, gbFreeUk }
      };
    } catch (e) {
      console.warn(`shippingAgent.ground failed: ${(e as Error).message}`);
      return notConfident();
    }
  },
  promptFragment(): string {
    return 'You are the shipping and returns specialist. If they ask whether we deliver to a place, the FIRST word is Yes (or No) followed by the place. If a grounded delivery line is appended, do not state a time yourself, just confirm delivery and that a tracking link follows on dispatch. If they ask about cost, tell the customer the exact shipping cost for their destination is calculated and shown at checkout before payment - do NOT state a specific shipping figure yourself. Keep returns answers to the relevant policy only. Any reassurance comes after the answer, never softening it. Never name the dispatch country. Example: "Yes, we deliver to the US, including NYC. You will get a tracking link the moment it is on its way."';
  },
  deterministicAppendix(g: Grounding): string | null {
    const d = g.data as { label: string; band?: DayRange; verifiedGb?: boolean; gbFreeUk?: boolean; unfulfillable?: boolean; unserved?: boolean } | undefined;
    if (!g.confident || !d) return null;
    // Unserved destination (no market/lane): honest no-delivery sentence.
    if (d.unserved) {
      return `We do not currently deliver to ${d.label}.`;
    }
    // Unfulfillable: honest no-ship sentence, never a day band.
    if (d.unfulfillable) {
      return `We are not able to ship this item to ${d.label} at the moment.`;
    }
    if (!d.band) return null;
    const line = buildShippingLine(d.label, d.band); // "Delivery to X: estimated A-B days."
    if (!line) return null;
    // Per-SKU, source-verified UK fulfilment wording (never blanket, never for non-GB stock).
    // The "free UK delivery" clause is appended ONLY when the verify-then-flip flag is live;
    // since the 2026-07-03 cutover it covers any GB-destination item (free storewide).
    if (d.verifiedGb) {
      const loc = d.gbFreeUk
        ? 'This item is held in a UK fulfilment location with free UK delivery.'
        : 'This item is held in a UK fulfilment location.';
      return `${loc} ${line}`;
    }
    if (d.gbFreeUk) return `UK delivery is free. ${line}`;
    return line;
  }
};

function notConfident(): Grounding { return { confident: false, facts: '', quotesFigure: false }; }
function notConfidentFacts(_dest: string): Grounding {
  return { confident: false, quotesFigure: false, facts: `Destination mentioned but no grounded delivery estimate is available; hedge on time (say we confirm the timeframe when dispatched). You MAY tell the customer the exact shipping cost for their destination is shown at checkout; do NOT state a specific shipping figure. You MAY state the returns policy from the store facts.` };
}
