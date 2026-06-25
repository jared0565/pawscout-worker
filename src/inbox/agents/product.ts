import type { CategoryAgent, AgentContext, Grounding } from './types';
import { resolveLineRequest } from '../../shopify-catalog';
import type { CjDetail } from '../../cj';

export const productAgent: CategoryAgent = {
  category: 'product-question',
  displayName: 'Product Questions',
  description: 'Resolves the asked-about product from the live catalog (availability, price, variants)',
  commercial: true,
  async ground(ctx: AgentContext): Promise<Grounding> {
    try {
      if (!ctx.admin) return hedge('Catalog is not connected right now; answer generally and point the customer to the website to find the item.');
      const query = ctx.latestMessage.slice(0, 80);
      if (!query.trim()) return hedge('No specific product named; ask which item they mean or point them to the website.');
      const r = await resolveLineRequest(ctx.admin, query);
      if (r.status === 'resolved' && r.variant) {
        const v = r.variant;
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
          // All candidates are variants of the same product -- answer confidently.
          const first = candidates[0];
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
