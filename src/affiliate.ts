import type { AdminGraphql } from './shopify-admin';
import type { Pricing } from './types';
import { retailPriceGbp, landedCostGbp, affiliateEligible } from './pricing';

/** Storefront tag marking a product as eligible for affiliate commission. */
export const AFFILIATE_ELIGIBLE_TAG = 'affiliate-eligible';
export const AFFILIATE_COLLECTION_HANDLE = 'affiliate-eligible';
const AFFILIATE_COLLECTION_TITLE = 'Affiliate Eligible';

/**
 * A product is affiliate-eligible only if EVERY sellable variant clears the £6
 * floor. Product-level promotion can't control which variant an affiliate sells,
 * so one thin variant disqualifies the whole product — an affiliate must never
 * be able to earn a commission on a SKU that doesn't carry it. Retail and COGS
 * are recomputed from CJ cost so eligibility tracks the same numbers the daily
 * price/cost sync writes.
 */
export function productAffiliateEligible(
  variants: { sellPriceUsd: number }[],
  pricing: Pricing,
  freightUsd?: number
): boolean {
  const sellable = variants.filter((v) => Number.isFinite(v.sellPriceUsd) && v.sellPriceUsd > 0);
  if (!sellable.length) return false;
  return sellable.every((v) =>
    affiliateEligible(
      retailPriceGbp(v.sellPriceUsd, pricing, freightUsd),
      landedCostGbp(v.sellPriceUsd, pricing, freightUsd)
    )
  );
}

/**
 * Ensure the internal smart collection that mirrors the `affiliate-eligible`
 * tag exists, so UpPromote can scope commissionable products to it. Idempotent
 * — looks up by handle first; the TAG-EQUALS rule auto-maintains membership
 * thereafter. Not published to the Online Store (internal targeting only).
 */
export async function ensureAffiliateCollection(admin: AdminGraphql): Promise<void> {
  const found = await admin(
    `query pawscoutAffCollLookup($q: String!) { collections(first: 1, query: $q) { nodes { id } } }`,
    { q: `handle:${AFFILIATE_COLLECTION_HANDLE}` }
  );
  if (((found.collections as { nodes?: { id: string }[] } | undefined)?.nodes ?? []).length) return;
  const data = await admin(
    `mutation pawscoutAffCollCreate($input: CollectionInput!) {
      collectionCreate(input: $input) { collection { id } userErrors { field message } }
    }`,
    {
      input: {
        title: AFFILIATE_COLLECTION_TITLE,
        handle: AFFILIATE_COLLECTION_HANDLE,
        ruleSet: {
          appliedDisjunctively: false,
          rules: [{ column: 'TAG', relation: 'EQUALS', condition: AFFILIATE_ELIGIBLE_TAG }]
        }
      }
    }
  );
  const errs = (data.collectionCreate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}
