// src/inbox/agents/shipping.ts
import type { CategoryAgent, AgentContext, Grounding } from './types';
import { isShippingIntent, deriveDestinationCountry, countryLabel, buildShippingLine } from '../freight';
import { resolveLogistics, doorToDoorBand, bandFromQuote, formatBand, type DayRange } from '../../logistics';
import { resolveLineRequest } from '../../shopify-catalog';
import type { CjDetail } from '../../cj';

const SHIP_DEFAULT_ORIGIN = 'CN'; // Conservative default; overridden when real warehouse data exists

export interface ItemShipping {
  chosenOrigin: string;
  cjPid: string;
  repVid: string | null;
  verifiedGbWarehouse: boolean;
}

const HANDLE_RE = /(?:activepaw\.co\.uk)?\/products\/([a-z0-9][a-z0-9-]{2,})/i;

/**
 * Resolve the inquiry's product (high-confidence only) plus its nearest in-stock
 * warehouse for `dest` and a representative variant id for a live CJ quote.
 * Fully guarded: any miss returns null and the caller keeps the generic/hedge path.
 *
 * Signal priority:
 *   1. Product URL/handle in the message (strongest - does not require admin)
 *   2. Confident single free-text catalog match via resolveLineRequest
 *
 * Origin priority: in-market (dest country) if stocked -> best-stocked origin.
 */
export async function resolveItemShipping(ctx: AgentContext, dest: string): Promise<ItemShipping | null> {
  try {
    // Signal 1: a product URL/handle in the message (strongest, most specific).
    let cjPid: string | null = null;
    const m = HANDLE_RE.exec(ctx.latestMessage);
    if (m) {
      cjPid = (await ctx.store.getLinkByHandle(m[1]))?.cj_pid ?? null;
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

    const verifiedGbWarehouse = (origins.GB ?? 0) > 0;
    // Nearest in-stock warehouse: in-market (no customs) if stocked, else best-stocked.
    let chosenOrigin: string;
    if ((origins[dest] ?? 0) > 0) {
      chosenOrigin = dest;
    } else {
      let best = ''; let bestQty = 0;
      for (const [cc, qty] of Object.entries(origins)) if (qty > bestQty) { best = cc; bestQty = qty; }
      if (!best) return null;
      chosenOrigin = best;
    }
    // Representative vid: prefer an in-stock variant; else the first listed.
    const variants = detail.variants ?? [];
    const repVid = (variants.find((v) => (v.stock ?? 0) > 0) ?? variants[0])?.vid ?? null;

    return { chosenOrigin, cjPid, repVid, verifiedGbWarehouse };
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
      const item = await resolveItemShipping(ctx, dest);

      // No confident item -> ask which item, but offer the generic dest band as a soft anchor.
      if (!item) {
        const generic = doorToDoorBand(await ctx.store.getLogisticsRoute(SHIP_DEFAULT_ORIGIN, dest, l.stalenessHours), l);
        return {
          confident: false, quotesFigure: false,
          facts: `The customer asked about delivery time but did not name a specific product. ASK which item (or a product link) so you can give a precise estimate. You MAY offer, as a soft general guide only, that most ${countryLabel(dest)} orders arrive in about ${formatBand(generic)} and that the exact time depends on the item. You MAY also state the flat shipping cost and returns policy from the store facts.`,
          data: { askForItem: true }
        };
      }

      // Resolve the band for the item's nearest warehouse: D1 matrix first, live CJ fallback.
      let band = doorToDoorBand(await ctx.store.getLogisticsRoute(item.chosenOrigin, dest, l.stalenessHours), l);
      if (!band && ctx.cj && item.repVid) {
        try {
          const opts = await ctx.cj.freightQuoteAging(item.repVid, item.chosenOrigin, dest);
          const cheapest = opts.filter((o: { days: string }) => o.days).sort((a: { priceUsd: number }, b: { priceUsd: number }) => a.priceUsd - b.priceUsd)[0];
          if (cheapest) band = bandFromQuote(cheapest.days, item.chosenOrigin, dest, l);
        } catch (e) { console.warn(`ship cj fallback failed: ${(e as Error).message}`); }
      }
      if (!band) band = doorToDoorBand(await ctx.store.getLogisticsRoute(SHIP_DEFAULT_ORIGIN, dest, l.stalenessHours), l);
      if (!band) return notConfidentFacts(dest);

      const verifiedGb = item.verifiedGbWarehouse && dest === 'GB';
      return {
        confident: true, quotesFigure: true,
        facts: `Destination ${countryLabel(dest)}. A grounded delivery estimate line is appended after your reply, so do NOT state a delivery time yourself. You MAY state the flat shipping cost and returns policy. Do not add a sign-off; the appended line follows your text.`,
        data: { label: countryLabel(dest), band, verifiedGb }
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
    const d = g.data as { label: string; band: DayRange; verifiedGb?: boolean } | undefined;
    if (!g.confident || !d) return null;
    const line = buildShippingLine(d.label, d.band); // "Delivery to X: estimated A-B days."
    if (!line) return null;
    // Per-SKU, source-verified UK fulfilment wording (never blanket, never for non-GB stock).
    return d.verifiedGb
      ? `This item is held in a UK fulfilment location. ${line}`
      : line;
  }
};

function notConfident(): Grounding { return { confident: false, facts: '', quotesFigure: false }; }
function notConfidentFacts(_dest: string): Grounding {
  return { confident: false, quotesFigure: false, facts: `Destination mentioned but no grounded delivery estimate is available; hedge on time (say we confirm the timeframe when dispatched) but you MAY still state the flat shipping cost and returns policy from the store facts.` };
}
