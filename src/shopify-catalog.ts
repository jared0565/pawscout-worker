import type { AdminGraphql } from './shopify-admin';

export type CatalogVariant = { variantId: string; productId: string; title: string; variantTitle: string; sku: string | null; priceGbp: number; available: boolean };

const NODES_BY_IDS = `query pawscoutVariantsByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id sku title price
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
      available: true // owner already selected; availableForSale not needed here
    });
  }
  return out;
}

const SEARCH = `query pawscoutCatalog($q: String!, $first: Int!) {
  products(first: $first, query: $q) {
    edges { node { id title variants(first: 20) { edges { node { id title sku price availableForSale } } } } }
  }
}`;

const CUSTOMER = `query pawscoutCustomer($q: String!) { customers(first: 1, query: $q) { edges { node { id } } } }`;

export async function searchShopifyProducts(admin: AdminGraphql, query: string, first = 10): Promise<CatalogVariant[]> {
  const q = query.replace(/["\\]/g, ' ').trim();
  if (!q) return [];
  const data = await admin(SEARCH, { q: `title:*${q}* OR sku:${q}`, first });
  const edges = ((data.products as { edges?: { node: Record<string, unknown> }[] })?.edges) ?? [];
  const out: CatalogVariant[] = [];
  for (const pe of edges) {
    const p = pe.node;
    const ves = ((p.variants as { edges?: { node: Record<string, unknown> }[] })?.edges) ?? [];
    for (const ve of ves) {
      const v = ve.node;
      out.push({
        variantId: String(v.id), productId: String(p.id), title: String(p.title ?? ''),
        variantTitle: String(v.title ?? ''), sku: v.sku ? String(v.sku) : null,
        priceGbp: Number(v.price ?? 0) || 0, available: v.availableForSale === true
      });
    }
  }
  return out;
}

export async function resolveLineRequest(admin: AdminGraphql, query: string): Promise<{ status: 'resolved' | 'ambiguous' | 'none'; variant?: CatalogVariant; candidates?: CatalogVariant[] }> {
  const matches = (await searchShopifyProducts(admin, query)).filter((v) => v.available);
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
