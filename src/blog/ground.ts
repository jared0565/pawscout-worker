// src/blog/ground.ts
//
// Deterministic grounding for the draft agent: given a target collection handle,
// fetch the REAL products it contains (title, handle, price, availability) so
// the drafter references and links to actual stock, never invented products.
// This is the blog equivalent of the inbox agent's ground() step. Pure I/O over
// the Admin API; never throws to the caller (a miss returns null).

import type { AdminGraphql } from '../shopify-admin';
import type { FactPack, GroundedProduct } from './types';

const COLLECTION_QUERY = `query pawscoutBlogGround($q: String!, $n: Int!) {
  collections(first: 1, query: $q) {
    nodes {
      handle
      title
      products(first: $n) {
        nodes {
          handle
          title
          featuredImage { url }
          variants(first: 1) { nodes { price availableForSale } }
        }
      }
    }
  }
}`;

interface CollNode {
  handle?: string;
  title?: string;
  products?: { nodes?: {
    handle?: string; title?: string;
    featuredImage?: { url?: string } | null;
    variants?: { nodes?: { price?: string; availableForSale?: boolean }[] };
  }[] };
}

/**
 * Build a fact pack for the collection with the given handle. Returns null when
 * the collection does not exist or has no products (the caller then skips or
 * picks another collection - the drafter must never be handed an empty pack and
 * asked to invent products). `limit` caps how many products the drafter sees.
 */
export async function groundCollection(
  admin: AdminGraphql, handle: string, limit = 8
): Promise<FactPack | null> {
  let data: { collections?: { nodes?: CollNode[] } };
  try {
    data = await admin(COLLECTION_QUERY, { q: `handle:${handle}`, n: limit }) as typeof data;
  } catch {
    return null; // admin error -> caller degrades
  }
  const node = data.collections?.nodes?.[0];
  if (!node || !node.handle) return null;

  const products: GroundedProduct[] = (node.products?.nodes ?? [])
    .map((p): GroundedProduct | null => {
      if (!p.handle || !p.title) return null;
      const v = p.variants?.nodes?.[0];
      const priceGbp = v?.price != null ? Number(v.price) : 0;
      return {
        title: p.title,
        handle: p.handle,
        path: `/products/${p.handle}`,
        priceGbp: Number.isFinite(priceGbp) ? priceGbp : 0,
        available: v?.availableForSale === true,
        imageUrl: p.featuredImage?.url || undefined
      };
    })
    .filter((p): p is GroundedProduct => p !== null);

  if (products.length === 0) return null;

  return {
    collectionHandle: node.handle,
    collectionTitle: node.title ?? handle,
    collectionPath: `/collections/${node.handle}`,
    products
  };
}

/** Render a fact pack as compact text for a prompt: the ONLY products the drafter
 *  may name or link, with their real paths and prices. */
export function factPackToPrompt(pack: FactPack): string {
  const lines = pack.products
    .filter((p) => p.available)
    .map((p) => `- ${p.title} (link: ${p.path}, price: GBP ${p.priceGbp.toFixed(2)})`);
  return [
    `Target collection: ${pack.collectionTitle} (link: ${pack.collectionPath}).`,
    `Real products you MAY mention and link to (use the EXACT link paths, never invent a product or a link):`,
    ...lines
  ].join('\n');
}
