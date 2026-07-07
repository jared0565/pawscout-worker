// src/shipping/us-price-list.ts
//
// Fixed USD pricing for the US & Canada market catalog (owner decision,
// 2026-07-07). Managed Markets (Global-e) was converting GBP stickers at an
// effective ~1.65-1.69 (its own FX + guarantee padding + duty inclusion until
// the owner moved duties to checkout), which priced US-warehoused stock ~30%
// above plain FX and sank every street-parity test. A fixed USD price list on
// the catalog takes shelf pricing out of the converter entirely: the price a
// US buyer sees is OUR number, anchored to the tenant's existing fx knob
// (pricing.fxUsdToGbp), rounded to .99.
//
// Design mirrors syncMarketExclusions: adopt-or-create idempotently, read the
// current state, write only the diff, converge nightly. A variant published
// mid-cycle (between nightly stamps) falls back to the price list's 0%
// adjustment = the platform's plain conversion, then gets its fixed price on
// the next run. Canada shares the catalog: Global-e derives CAD from the USD
// fixed price, which is still anchored to our number.
//
// Mutation shapes (priceListCreate/Update, priceListFixedPricesUpdate,
// MarketCatalog.priceList, PriceList.prices pagination) verified against the
// pinned 2026-04 Admin API by introspection on 2026-07-07.

import type { AdminGraphql } from '../shopify-admin';
import { listLiveMarkets } from './market-catalogs';
import { chunk } from './market-catalogs';

/** GBP sticker -> USD shelf price at the tenant's own rate, nearest .99,
 *  floored at 0.99. Examples at fx 0.78: 47.99 -> 61.99, 10.99 -> 13.99. */
export function usdFromGbp(gbp: number, fxUsdToGbp: number): number {
  if (!(gbp > 0) || !(fxUsdToGbp > 0)) return 0.99;
  const raw = gbp / fxUsdToGbp;
  return Math.max(0.99, Math.round(raw + 0.01) - 0.01);
}

const CATALOG_PRICE_LIST_QUERY = `query pawscoutCatalogPriceList($id: ID!) {
  catalog(id: $id) { ... on MarketCatalog { priceList { id currency } } }
}`;
const PRICE_LIST_CREATE = `mutation pawscoutPriceListCreate($input: PriceListCreateInput!) {
  priceListCreate(input: $input) { priceList { id } userErrors { field message } }
}`;
const PRICE_LIST_UPDATE = `mutation pawscoutPriceListUpdate($id: ID!, $input: PriceListUpdateInput!) {
  priceListUpdate(id: $id, input: $input) { priceList { id } userErrors { field message } }
}`;
const FIXED_PRICES_QUERY = `query pawscoutFixedPrices($id: ID!, $cursor: String) {
  priceList(id: $id) {
    prices(first: 250, after: $cursor, originType: FIXED) {
      pageInfo { hasNextPage endCursor }
      nodes { variant { id } price { amount } }
    }
  }
}`;
const FIXED_PRICES_UPDATE = `mutation pawscoutFixedPricesUpdate($priceListId: ID!, $pricesToAdd: [PriceListPriceInput!]!, $variantIdsToDelete: [ID!]!) {
  priceListFixedPricesUpdate(priceListId: $priceListId, pricesToAdd: $pricesToAdd, variantIdsToDelete: $variantIdsToDelete) {
    priceList { id } userErrors { field message }
  }
}`;
const ACTIVE_VARIANTS_QUERY = `query pawscoutActiveVariantPrices($cursor: String) {
  productVariants(first: 250, after: $cursor, query: "product_status:active") {
    pageInfo { hasNextPage endCursor }
    nodes { id price }
  }
}`;

function firstErr(data: Record<string, unknown>, key: string): string | null {
  const errs = ((data[key] as { userErrors?: { message: string }[] })?.userErrors) ?? [];
  return errs.length ? errs.map((e) => e.message).join('; ') : null;
}

/** The US & Canada market's catalog id, or null when no US market exists. */
async function usCatalogId(admin: AdminGraphql): Promise<string | null> {
  const markets = await listLiveMarkets(admin);
  const us = markets.find((m) => m.countries.includes('US'));
  return us?.catalogId ?? null;
}

/** Adopt the catalog's price list (retargeting its currency to USD when it was
 *  created in store currency), or create a USD list with a 0% adjustment - the
 *  fallback behavior for any variant we have not stamped yet. Idempotent. */
export async function ensureUsPriceList(admin: AdminGraphql, catalogId: string): Promise<string> {
  const data = await admin(CATALOG_PRICE_LIST_QUERY, { id: catalogId });
  const existing = (data.catalog as { priceList?: { id?: string; currency?: string } | null })?.priceList;
  if (existing?.id) {
    if (existing.currency !== 'USD') {
      const upd = await admin(PRICE_LIST_UPDATE, { id: existing.id, input: { currency: 'USD' } });
      const err = firstErr(upd, 'priceListUpdate');
      if (err) throw new Error(`priceListUpdate(USD): ${err}`);
    }
    return existing.id;
  }
  const created = await admin(PRICE_LIST_CREATE, {
    input: {
      name: 'US & Canada fixed USD prices',
      currency: 'USD',
      catalogId,
      parent: { adjustment: { type: 'PERCENTAGE_INCREASE', value: 0 } }
    }
  });
  const err = firstErr(created, 'priceListCreate');
  if (err) throw new Error(`priceListCreate: ${err}`);
  const id = String((created.priceListCreate as { priceList?: { id?: string } })?.priceList?.id ?? '');
  if (!id) throw new Error('priceListCreate: no price list id returned');
  return id;
}

export interface UsPriceSyncResult {
  priceListId: string | null;
  stamped: number;  // fixed prices added or changed this run
  deleted: number;  // stale fixed prices removed (variant no longer active)
  total: number;    // active variants considered
}

/**
 * Nightly reconcile: every ACTIVE variant carries a fixed USD price derived
 * from its live GBP sticker. Converged runs issue no mutations. Variants that
 * left the active catalog (archived/deleted products) have their fixed prices
 * deleted so a resurrected product cannot resurface with a stale price.
 */
export async function syncUsFixedPrices(
  admin: AdminGraphql,
  cfg: { pricing: { fxUsdToGbp: number } }
): Promise<UsPriceSyncResult> {
  const catalogId = await usCatalogId(admin);
  if (!catalogId) return { priceListId: null, stamped: 0, deleted: 0, total: 0 };
  const priceListId = await ensureUsPriceList(admin, catalogId);

  // Current fixed prices (paged).
  const current = new Map<string, number>();
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data = await admin(FIXED_PRICES_QUERY, { id: priceListId, cursor });
    const conn = (data.priceList as { prices?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: { variant?: { id?: string }; price?: { amount?: string } }[] } })?.prices;
    for (const n of conn?.nodes ?? []) {
      if (n.variant?.id && n.price?.amount != null) current.set(n.variant.id, Number(n.price.amount));
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }

  // Desired: every active variant at usdFromGbp(its GBP price).
  const desired = new Map<string, number>();
  cursor = null;
  for (let page = 0; page < 40; page++) {
    const data = await admin(ACTIVE_VARIANTS_QUERY, { cursor });
    const conn = data.productVariants as { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: { id?: string; price?: string }[] };
    for (const n of conn?.nodes ?? []) {
      if (n.id && n.price != null) desired.set(n.id, usdFromGbp(Number(n.price), cfg.pricing.fxUsdToGbp));
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }

  const toAdd = [...desired].filter(([vid, usd]) => current.get(vid) !== usd);
  const toDelete = [...current.keys()].filter((vid) => !desired.has(vid));

  // One mutation can carry both sides; chunk to stay far under input caps.
  const addChunks = chunk(toAdd, 200);
  const delChunks = chunk(toDelete, 200);
  const rounds = Math.max(addChunks.length, delChunks.length);
  for (let i = 0; i < rounds; i++) {
    const data = await admin(FIXED_PRICES_UPDATE, {
      priceListId,
      pricesToAdd: (addChunks[i] ?? []).map(([variantId, usd]) => ({
        variantId, price: { amount: usd.toFixed(2), currencyCode: 'USD' }
      })),
      variantIdsToDelete: delChunks[i] ?? []
    });
    const err = firstErr(data, 'priceListFixedPricesUpdate');
    if (err) throw new Error(`priceListFixedPricesUpdate: ${err}`);
  }

  return { priceListId, stamped: toAdd.length, deleted: toDelete.length, total: desired.size };
}
