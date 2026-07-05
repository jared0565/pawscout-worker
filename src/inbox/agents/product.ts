import type { CategoryAgent, AgentContext, Grounding } from './types';
import { resolveLineRequest } from '../../shopify-catalog';
import { deriveDestinationCountry, countryLabel } from '../freight';
import { localWarehousesFor, sellableToBuyer } from '../../local-markets';
import type { CjDetail } from '../../cj';

/**
 * Local-for-local availability check for a product question. When the sender's
 * destination is confidently derived AND the resolved product's verified origins
 * show it is not sold to that buyer's market (cross-lane stock, or a country we
 * have no market for), returns replacement facts that answer honestly instead of
 * presenting the item as purchasable. Returns null when there is no destination
 * signal, the product is sellable there, or origins are unverified (cannot
 * determine -> keep the normal answer; the drafter never invents availability).
 */
async function destAvailabilityOverride(ctx: AgentContext, title: string, productId: string | null | undefined): Promise<string | null> {
  try {
    const dest = deriveDestinationCountry(ctx.conversation, ctx.thread.subject ?? '', ctx.contactEmail);
    if (!dest) return null;
    const label = countryLabel(dest);
    if (!localWarehousesFor(dest).length) {
      return `Resolved product "${title}", but the sender appears to be in ${label}, which we do not currently deliver to. Say so plainly and apologise briefly; do not present the item as purchasable for them and do not state a price.`;
    }
    if (!productId) return null;
    const link = await ctx.store.getLinkByShopifyProductId(productId);
    if (!link?.cj_pid) return null;
    const row = await ctx.store.getWarehouseProduct(link.cj_pid);
    if (!row?.detail) return null;
    const detail = JSON.parse(row.detail) as CjDetail;
    if (!detail.origins) return null;
    if (sellableToBuyer(detail.origins, dest)) return null;
    return `Resolved product "${title}", but it is not available for delivery to ${label} (the sender's destination) - it is stocked for a different region. Say so plainly, do not present it as purchasable for them and do not state a price; offer to suggest similar items available in their country.`;
  } catch { return null; }
}

export const productAgent: CategoryAgent = {
  category: 'product-question',
  displayName: 'Product Questions',
  description: 'Resolves the asked-about product from the live catalog (availability, price, variants)',
  department: 'sales',
  commercial: true,
  async ground(ctx: AgentContext): Promise<Grounding> {
    try {
      if (!ctx.admin) return hedge('Catalog is not connected right now; answer generally and point the customer to the website to find the item.');
      const query = ctx.latestMessage.slice(0, 80);
      if (!query.trim()) return hedge('No specific product named; ask which item they mean or point them to the website.');
      const r = await resolveLineRequest(ctx.admin, query);
      if (r.status === 'resolved' && r.variant) {
        const v = r.variant;
        // Local-for-local: a sender whose destination cannot buy this item gets an
        // honest not-available answer, never an in-stock + price + purchase push.
        const override = await destAvailabilityOverride(ctx, v.title, v.productId);
        if (override) return { confident: true, quotesFigure: false, facts: override };
        const stock = v.availableQty > 0 ? 'in stock' : 'availability shown at checkout';
        let baseFacts = `Resolved product "${v.title}${v.variantTitle ? ' - ' + v.variantTitle : ''}", price GBP ${v.priceGbp.toFixed(2)}, ${stock}. You MAY state these. Suggest one concrete next step (view the product page or reply with the variant they want).`;

        // Supplement with grounded warehouse stock/specs from D1 (non-fatal if missing)
        let extra = '';
        try {
          const productId = v.productId;
          if (productId && ctx.store?.getLinkByShopifyProductId) {
            const link = await ctx.store.getLinkByShopifyProductId(productId);
            if (link?.cj_pid) {
              const row = await ctx.store.getWarehouseProduct(link.cj_pid);
              if (row) {
                extra = ` Stock: ${row.status} (${row.stock} units known).`;
                try {
                  const detail = JSON.parse(row.detail) as CjDetail;
                  const specParts: string[] = [];
                  if (detail.categoryName) specParts.push(`Category: ${detail.categoryName}`);
                  if (detail.petClass) specParts.push(`For: ${detail.petClass}`);
                  if (specParts.length > 0) extra += ` ${specParts.join(', ')}.`;
                } catch { /* detail parse miss is non-fatal */ }
              }
            }
          }
        } catch { /* warehouse miss is non-fatal */ }

        return {
          confident: true, quotesFigure: true,
          facts: baseFacts + extra,
          data: { variantId: v.variantId }
        };
      }
      if (r.status === 'ambiguous') {
        const candidates = r.candidates ?? [];
        const productIds = new Set(candidates.map((c) => c.productId));
        if (productIds.size === 1) {
          // All candidates are variants of the same product -- answer confidently
          // (after the same local-for-local availability check as the resolved path).
          const first = candidates[0];
          const override = await destAvailabilityOverride(ctx, first.title, first.productId);
          if (override) return { confident: true, quotesFigure: false, facts: override };
          const prices = candidates.map((c) => c.priceGbp);
          const minPrice = Math.min(...prices);
          const maxPrice = Math.max(...prices);
          const priceRange = minPrice === maxPrice ? `GBP ${minPrice.toFixed(2)}` : `GBP ${minPrice.toFixed(2)}-${maxPrice.toFixed(2)}`;
          const variantList = candidates.map((c) => c.variantTitle).filter(Boolean).join(', ');
          return {
            confident: true,
            quotesFigure: true,
            facts: `Product "${first.title}", price ${priceRange}${variantList ? `, available variants: ${variantList}` : ''}. Answer the product question and invite the customer to pick a variant.`
          };
        }
        return hedge('Several products match; ask which specific item they mean before answering.');
      }
      return hedge('No matching product found; point them to the website search and offer to help once they name the item.');
    } catch (e) {
      console.warn(`productAgent.ground failed: ${(e as Error).message}`);
      return hedge('Could not look up the catalog; answer generally and point to the website.');
    }
  },
  promptFragment(g: Grounding): string {
    return 'You are the product specialist. Answer the product question from the grounded facts only, leading with the answer. Never invent specs, prices, stock, or guarantees; if a detail is not grounded, say you will confirm it rather than guessing. End with exactly one concrete next step toward purchase, no pressure. Example: "The Blue Harness comes in small, medium, and large and is machine washable. Would you like the size guide?"';
  },
  deterministicAppendix(_g: Grounding): string | null { return null; }
};

function hedge(facts: string): Grounding { return { confident: false, quotesFigure: false, facts }; }
