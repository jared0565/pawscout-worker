import type { CategoryAgent, AgentContext, Grounding } from './types';
import { resolveLineRequest } from '../../shopify-catalog';

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
        return {
          confident: true, quotesFigure: true,
          facts: `Resolved product "${v.title}${v.variantTitle ? ' - ' + v.variantTitle : ''}", price GBP ${v.priceGbp.toFixed(2)}, ${stock}. You MAY state these. Suggest one concrete next step (view the product page or reply with the variant they want).`,
          data: { variantId: v.variantId }
        };
      }
      if (r.status === 'ambiguous') return hedge('Several products match; ask which specific item they mean before answering.');
      return hedge('No matching product found; point them to the website search and offer to help once they name the item.');
    } catch (e) {
      console.warn(`productAgent.ground failed: ${(e as Error).message}`);
      return hedge('Could not look up the catalog; answer generally and point to the website.');
    }
  },
  promptFragment(g: Grounding): string {
    return 'You are the product specialist. Answer the product question from the grounded facts only. Never invent specs, prices, stock, or guarantees. End with exactly one concrete next step toward purchase, with no pressure.';
  },
  deterministicAppendix(_g: Grounding): string | null { return null; }
};

function hedge(facts: string): Grounding { return { confident: false, quotesFigure: false, facts }; }
