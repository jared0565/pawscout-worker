import type { CategoryAgent, AgentContext, Grounding } from './types';
import { resolveLineRequest, extractProductHandle } from '../../shopify-catalog';
import { deriveDestinationCountry, countryLabel } from '../freight';
import { localWarehousesFor, sellableToBuyer } from '../../local-markets';
import type { CjDetail } from '../../cj';
import { sourcingGrounding, NO_MATCH_FACTS, OVERSEAS_FACTS, COUNTRY_UNKNOWN_FACTS, NEVER_NAME_ORIGIN } from './sourcing';
import { loadCatalog, matchCatalog, type Catalog, type CatalogItem } from '../catalog-match';

const STORE_URL = 'https://activepaw.co.uk';
const NEXT_STEP = ' Suggest one concrete next step (view the product page or reply with the variant they want).';

const ORIGIN_QUERY = `query pawscoutOrigin($id: ID!) {
  product(id: $id) {
    origin: metafield(namespace: "supplier", key: "origin") { value }
    days: metafield(namespace: "supplier", key: "delivery_days") { value }
  }
}`;

/**
 * Owner rule 2026-09-30: an item sold from an overseas warehouse is offered
 * with a plain "ships from overseas" note. A sourced offer carried it; the same
 * item answered from the catalog once imported did not. Reads the
 * `supplier.origin` metafield the worker writes on import and every night.
 * Returns '' for a local item, an unknown origin, or any read failure: the
 * catalog answer stays silent on where an item ships from unless it is overseas.
 */
async function overseasNote(ctx: AgentContext, productId: string | null | undefined): Promise<string> {
  try {
    if (!productId || !ctx.admin) return '';
    const data = await ctx.admin(ORIGIN_QUERY, { id: productId }) as { product?: { origin?: { value?: string } | null; days?: { value?: string } | null } | null };
    let origin = (data?.product?.origin?.value ?? '').trim().toUpperCase();
    if (origin === 'UK') origin = 'GB';
    if (!origin) return '';
    const known = deriveDestinationCountry(ctx.conversation, ctx.thread.subject ?? '', ctx.contactEmail);
    // No country: judged against the home market, as the sourced offer is.
    if (localWarehousesFor(known ?? 'GB').includes(origin)) return '';
    // `delivery_days` is the band from this origin to the UK (the nightly sync),
    // so it is stated to a UK buyer only.
    const days = (data?.product?.days?.value ?? '').trim();
    const delivery = !known ? COUNTRY_UNKNOWN_FACTS
      : known === 'GB' && days ? `Estimated delivery to ${countryLabel(known)}: ${days} days from order. You MAY state this.`
        : 'Do not state a delivery time.';
    return ` ${OVERSEAS_FACTS} ${delivery} ${NEVER_NAME_ORIGIN}`;
  } catch { return ''; }
}

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
  department: 'tech',
  commercial: true,
  async ground(ctx: AgentContext): Promise<Grounding> {
    try {
      if (!ctx.admin) return hedge('Catalog is not connected right now; answer generally and point the customer to the website to find the item.');
      // A pasted product link is the most precise reference there is: read it
      // from the latest message, or from an earlier one in the thread when the
      // latest has none (a follow-up rarely repeats the link). Only without a
      // link does the free-text title search run (Rose thread, 2026-09-05: a
      // message that BEGAN with the URL was title-searched and hedged).
      const linked = extractProductHandle(ctx.latestMessage) ?? extractProductHandle(ctx.conversation);
      // The thread reader's product phrase ("gps tracker dog collar") searches far
      // better than the first 80 characters of a chatty message; the raw text is
      // the fallback when the phrase finds nothing.
      const typed = ctx.latestMessage.slice(0, 80);
      // Without a link, the catalogue matcher reads the question against the whole
      // live catalogue first; a title substring cannot answer "any anti escape
      // accessory?" or "do you sell accessories?". Null means it could not
      // answer, and the title search below runs exactly as before.
      if (!linked) {
        const matched = await catalogGrounding(ctx, typed);
        if (matched) return matched;
      }
      const query = linked ? `/products/${linked}` : (ctx.productQuery || typed);
      if (!query.trim()) return hedge('No specific product named; ask which item they mean or point them to the website.');
      let r = await resolveLineRequest(ctx.admin, query);
      if (r.status === 'none' && !linked && ctx.productQuery && typed.trim()) r = await resolveLineRequest(ctx.admin, typed);
      if (r.status === 'resolved' && r.variant) {
        const v = r.variant;
        // Local-for-local: a sender whose destination cannot buy this item gets an
        // honest not-available answer, never an in-stock + price + purchase push.
        const override = await destAvailabilityOverride(ctx, v.title, v.productId);
        if (override) return { confident: true, quotesFigure: false, facts: override };
        const stock = v.availableQty > 0 ? 'in stock' : 'availability shown at checkout';
        const baseFacts = `Resolved product "${v.title}${v.variantTitle ? ' - ' + v.variantTitle : ''}", price GBP ${v.priceGbp.toFixed(2)}, ${stock}. You MAY state these.${NEXT_STEP}`;

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
          facts: baseFacts + extra + await overseasNote(ctx, v.productId),
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
              + await overseasNote(ctx, first.productId)
          };
        }
        return hedge('Several products match; ask which specific item they mean before answering.');
      }
      if (linked) return hedge(NO_MATCH_FACTS);
      return await sourceOrHedge(ctx, ctx.productQuery || typed);
    } catch (e) {
      console.warn(`productAgent.ground failed: ${(e as Error).message}`);
      return hedge('Could not look up the catalog; answer generally and point to the website.');
    }
  },
  promptFragment(_g: Grounding): string {
    return 'You are the product specialist. Answer the product question from the grounded facts only, leading with the answer. Never invent specs, prices, stock, or guarantees; if a detail is not grounded, say you will confirm it rather than guessing. End with exactly one concrete next step toward purchase, no pressure. Example: "The Blue Harness comes in small, medium, and large and is machine washable. Would you like the size guide?"';
  },
  deterministicAppendix(_g: Grounding): string | null { return null; }
};

function hedge(facts: string): Grounding { return { confident: false, quotesFigure: false, facts }; }

/** The grounding of one catalogue product, through the link path (real price,
 * stock, local-for-local check and overseas note). The link path never reaches
 * the matcher again: a linked question skips it. */
function groundListed(ctx: AgentContext, handle: string): Promise<Grounding> {
  return productAgent.ground({ ...ctx, latestMessage: `${STORE_URL}/products/${handle}`, productQuery: null });
}

/** A catalogue miss: look the item up at the supplier (owner rule 2026-09-30). */
async function sourceOrHedge(ctx: AgentContext, query: string): Promise<Grounding> {
  const sourced = await sourcingGrounding(ctx, query);
  // Already imported (its Shopify title or search index may not match the
  // phrase yet): answer from the real listing through the link path, which
  // carries the real price and needs no sourcing hold. The link path cannot
  // recurse back here: a linked miss returns NO_MATCH_FACTS.
  const handle = (sourced.data as { sourcingHandle?: string | null } | undefined)?.sourcingHandle;
  if (handle) {
    const listed = await groundListed(ctx, handle);
    if (listed.confident) return listed;
  }
  return sourced;
}

/** What a product's own page says it is: the only description a reply may use.
 * A tracker helps FIND a pet that got out; it does not stop one escaping. */
function ownWords(item: CatalogItem | undefined): string {
  return item?.description
    ? ` What it is, from its own product page (describe it only this way, and never say it does something this does not say): ${item.description}`
    : '';
}

function collectionFacts(catalog: Catalog, handle: string): string {
  const c = catalog.collections.find((x) => x.handle === handle);
  const titles = catalog.products.filter((p) => p.collections.includes(handle)).slice(0, 6).map((p) => p.title);
  return `Yes: our ${c?.title ?? handle} range is at ${STORE_URL}/collections/${handle}.`
    + (titles.length ? ` Items in it include: ${titles.join('; ')}.` : '');
}

/**
 * A product question matched against the whole live catalogue (see
 * catalog-match.ts). Null when the matcher cannot answer: no model, no admin,
 * an unreadable catalogue or a bad answer; the caller then searches titles.
 * One product answers exactly as a pasted link would. Several answer as a short
 * list of real items, each with its own price, link and overseas note. A broad
 * "do you sell X" answers with the real collection and quotes no price. Nothing
 * that fits goes to the supplier lookup, never to a title substring.
 */
async function catalogGrounding(ctx: AgentContext, typed: string): Promise<Grounding | null> {
  if (!ctx.llm || !ctx.admin) return null;
  const catalog = await loadCatalog(ctx.admin);
  if (!catalog) return null;
  const match = await matchCatalog(ctx.llm, ctx.store, ctx.cfg,
    { message: ctx.latestMessage, subject: ctx.thread.subject ?? '', productQuery: ctx.productQuery ?? null }, catalog);
  if (!match) return null;

  const byHandle = new Map(catalog.products.map((p) => [p.handle, p]));
  const listed: { handle: string; g: Grounding }[] = [];
  for (const handle of match.handles) listed.push({ handle, g: await groundListed(ctx, handle) });
  // Purchasable for this sender, with a real price. An item the local-for-local
  // check withholds (confident, no price) answers alone only when nothing else does.
  const sellable = listed.filter((x) => x.g.confident && x.g.quotesFigure);
  const range = match.collection ? collectionFacts(catalog, match.collection) : '';

  if (sellable.length === 1 && !range) {
    const { handle, g } = sellable[0];
    return { ...g, facts: g.facts + ownWords(byHandle.get(handle)) };
  }
  if (sellable.length > 0) {
    const items = sellable.map(({ handle, g }, i) =>
      `Item ${i + 1}: ${g.facts.replace(NEXT_STEP, '')} Link: ${STORE_URL}/products/${handle}.${ownWords(byHandle.get(handle))}`);
    return {
      confident: true, quotesFigure: true,
      facts: 'The sender asked about a kind of product, not one named item. These items from our live catalogue fit what they asked. '
        + 'Present them briefly, most relevant first: one line each saying in plain words what it does for their need, with its price and link. '
        + 'Name no other product, and never claim an item does more than its own description says. '
        + 'End with one question that helps them choose (for example whether it is for a dog or a cat). '
        + items.join(' ')
        + (range ? ` ${range} You MAY give that link too.` : ''),
    };
  }
  if (range) {
    return {
      confident: true, quotesFigure: false,
      facts: `The sender asked whether we sell a type of product. ${range} `
        + 'You MAY give that link and describe in plain words the kinds of items it includes. Do not state a price, stock or delivery time for any single item. '
        + 'Ask what they are looking for, so the team can point them to the right item.',
    };
  }
  const withheld = listed.find((x) => x.g.confident);
  if (withheld) return withheld.g;
  return sourceOrHedge(ctx, ctx.productQuery || typed);
}
