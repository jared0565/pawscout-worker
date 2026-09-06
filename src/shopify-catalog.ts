import type { AdminGraphql } from './shopify-admin';

export type CatalogVariant = { variantId: string; productId: string; title: string; variantTitle: string; sku: string | null; priceGbp: number; availableQty: number; available: boolean };

const NODES_BY_IDS = `query pawscoutVariantsByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id sku title price inventoryQuantity
      product { id title }
    }
  }
}`;

export async function variantsByIds(admin: AdminGraphql, ids: string[]): Promise<CatalogVariant[]> {
  if (!ids.length) return [];
  const data = await admin(NODES_BY_IDS, { ids });
  const nodes = ((data.nodes as unknown[]) ?? []).filter(Boolean) as Record<string, unknown>[];
  const out: CatalogVariant[] = [];
  for (const node of nodes) {
    if (!node.id) continue;
    const product = (node.product ?? {}) as Record<string, unknown>;
    out.push({
      variantId: String(node.id),
      productId: String(product.id ?? ''),
      title: String(product.title ?? ''),
      variantTitle: String(node.title ?? ''),
      sku: node.sku ? String(node.sku) : null,
      priceGbp: Number(node.price ?? 0) || 0,
      availableQty: Number(node.inventoryQuantity ?? 0) || 0,
      available: true // owner already selected; availableForSale not needed here
    });
  }
  return out;
}

const SEARCH = `query pawscoutCatalog($q: String!, $first: Int!) {
  products(first: $first, query: $q) {
    edges { node { id title variants(first: 20) { edges { node { id title sku price availableForSale inventoryQuantity } } } } }
  }
}`;

const BY_HANDLE = `query pawscoutProductByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id title handle variants(first: 20) { edges { node { id title sku price availableForSale inventoryQuantity } } }
  }
}`;

const CUSTOMER = `query pawscoutCustomer($q: String!) { customers(first: 1, query: $q) { edges { node { id } } } }`;

/** A storefront product link in free text: "/products/<handle>", with or without
 * the domain; a query string or trailing punctuation is ignored. The LAST link in
 * the text wins, so a thread transcript resolves to the most recent one. Shared by
 * the product and shipping agents so both read the same reference. */
const PRODUCT_LINK_RE = /(?:activepaw\.co\.uk)?\/products\/([a-z0-9][a-z0-9-]{2,})/gi;
export function extractProductHandle(text: string): string | null {
  let last: string | null = null;
  for (const m of (text ?? '').matchAll(PRODUCT_LINK_RE)) last = m[1].toLowerCase();
  return last;
}

function variantsOfProduct(p: Record<string, unknown>): CatalogVariant[] {
  const ves = ((p.variants as { edges?: { node: Record<string, unknown> }[] })?.edges) ?? [];
  return ves.map(({ node: v }) => ({
    variantId: String(v.id), productId: String(p.id), title: String(p.title ?? ''),
    variantTitle: String(v.title ?? ''), sku: v.sku ? String(v.sku) : null,
    priceGbp: Number(v.price ?? 0) || 0, availableQty: Number(v.inventoryQuantity ?? 0) || 0,
    available: v.availableForSale === true
  }));
}

export async function searchShopifyProducts(admin: AdminGraphql, query: string, first = 10): Promise<CatalogVariant[]> {
  const q = query.replace(/["\\]/g, ' ').trim();
  if (!q) return [];
  const data = await admin(SEARCH, { q: `title:*${q}* OR sku:${q}`, first });
  const edges = ((data.products as { edges?: { node: Record<string, unknown> }[] })?.edges) ?? [];
  return edges.flatMap((pe) => variantsOfProduct(pe.node));
}

/** The variants of one product looked up by its storefront handle; [] when the
 * handle is not in the catalog. */
export async function productVariantsByHandle(admin: AdminGraphql, handle: string): Promise<CatalogVariant[]> {
  const data = await admin(BY_HANDLE, { handle });
  const p = data.productByHandle as Record<string, unknown> | null | undefined;
  return p ? variantsOfProduct(p) : [];
}

/** Resolve free text (or a product link) to a variant. A pasted product link is
 * the most precise reference a customer can give, so it resolves by handle and
 * never falls through to a title guess (Rose thread, 2026-09-05: a message that
 * BEGAN with the product URL was title-searched, matched nothing, and the reply
 * said we "cannot verify the specific product"). */
export async function resolveLineRequest(admin: AdminGraphql, query: string): Promise<{ status: 'resolved' | 'ambiguous' | 'none'; variant?: CatalogVariant; candidates?: CatalogVariant[] }> {
  const handle = extractProductHandle(query);
  const matches = handle
    ? await productVariantsByHandle(admin, handle)
    : (await searchShopifyProducts(admin, query)).filter((v) => v.available);
  if (matches.length === 0) return { status: 'none' };
  if (matches.length === 1) return { status: 'resolved', variant: matches[0] };
  return { status: 'ambiguous', candidates: matches.slice(0, 8) };
}

export async function findCustomerByEmail(admin: AdminGraphql, email: string): Promise<{ customerId: string } | null> {
  const e = email.replace(/["\\]/g, '').trim();
  if (!e) return null;
  const data = await admin(CUSTOMER, { q: `email:${e}` });
  const node = ((data.customers as { edges?: { node: { id: string } }[] })?.edges ?? [])[0]?.node;
  return node ? { customerId: node.id } : null;
}
