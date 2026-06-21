import type { AdminGraphql } from '../shopify-admin';

/** Cap written quantities — CJ "stock" can be five digits; Shopify doesn't need that. */
export const MAX_TRACKED_QTY = 999;

export async function getPrimaryLocationId(admin: AdminGraphql): Promise<string | null> {
  try {
    const data = await admin(`query pawscoutLocation { location { id } }`);
    return (data.location as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

export interface VariantInventory { variantId: string; sku: string; price: string; inventoryItemId: string; tracked: boolean; cost: string }

export async function productInventoryItems(admin: AdminGraphql, productId: string): Promise<VariantInventory[]> {
  const data = await admin(
    `query pawscoutVariants($id: ID!) {
      product(id: $id) { variants(first: 50) { nodes { id sku price inventoryItem { id tracked unitCost { amount } } } } }
    }`,
    { id: productId }
  );
  const nodes = ((data.product as { variants?: { nodes?: { id: string; sku: string | null; price?: string; inventoryItem?: { id: string; tracked?: boolean; unitCost?: { amount?: string } | null } }[] } } | null)
    ?.variants?.nodes) ?? [];
  return nodes
    .filter((n) => n.inventoryItem?.id)
    .map((n) => ({ variantId: n.id, sku: n.sku ?? '', price: n.price ?? '', inventoryItemId: n.inventoryItem!.id, tracked: n.inventoryItem!.tracked === true, cost: n.inventoryItem!.unitCost?.amount ?? '' }));
}

/**
 * Set Shopify "Cost per item" (InventoryItem.unitCost) per variant. This is an
 * admin-only analytics field (drives native margin/profit reports) — NEVER
 * customer-facing. One mutation per item (inventoryItemUpdate isn't bulk).
 * Throws on userErrors; callers pass only changed costs.
 */
export async function updateVariantCosts(
  admin: AdminGraphql,
  items: { inventoryItemId: string; cost: string }[]
): Promise<void> {
  for (const it of items) {
    const data = await admin(
      `mutation pawscoutCost($id: ID!, $cost: Decimal!) {
        inventoryItemUpdate(id: $id, input: { cost: $cost }) { userErrors { field message } }
      }`,
      { id: it.inventoryItemId, cost: it.cost }
    );
    const errs = (data.inventoryItemUpdate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  }
}

/**
 * Activate Shopify inventory tracking on untracked variants (ghost-click
 * imports whose CJ detail lacked stock arrive untracked) and set their policy
 * to DENY so a tracked zero can never oversell. Must run BEFORE
 * inventorySetQuantities — quantity writes on untracked items error.
 */
export async function enableTracking(
  admin: AdminGraphql,
  productId: string,
  variants: { variantId: string; inventoryItemId: string }[]
): Promise<void> {
  if (!variants.length) return;
  for (const v of variants) {
    const data = await admin(
      `mutation pawscoutTrack($id: ID!) {
        inventoryItemUpdate(id: $id, input: { tracked: true }) { userErrors { field message } }
      }`,
      { id: v.inventoryItemId }
    );
    const errs = (data.inventoryItemUpdate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  }
  const data = await admin(
    `mutation pawscoutDeny($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId, variants: variants.map((v) => ({ id: v.variantId, inventoryPolicy: 'DENY' })) }
  );
  const errs = (data.productVariantsBulkUpdate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/** Bulk price updates for a product's variants. Throws on userErrors. */
export async function updateVariantPrices(
  admin: AdminGraphql,
  productId: string,
  updates: { id: string; price: string }[]
): Promise<void> {
  if (!updates.length) return;
  const data = await admin(
    `mutation pawscoutPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId, variants: updates }
  );
  const errs = (data.productVariantsBulkUpdate as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/** Absolute-set available quantities (reason: correction). Throws on userErrors. */
export async function setInventoryQuantities(
  admin: AdminGraphql,
  locationId: string,
  items: { inventoryItemId: string; quantity: number }[]
): Promise<void> {
  if (!items.length) return;
  const data = await admin(
    `mutation pawscoutInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) { userErrors { field message } }
    }`,
    {
      input: {
        reason: 'correction',
        name: 'available',
        // API-VERSION DEBT: `ignoreCompareQuantity` is valid on our current
        // version (2025-07) but REMOVED in 2026-04. When @shopify/shopify-api is
        // bumped to a 2026-04+ API version, replace this line with a per-quantity
        // `changeFromQuantity: null` (opt out of the concurrency check — same
        // force-set behaviour). Deadline ~Jan 2027 / 2025-07 sunset. See TASKS.md.
        ignoreCompareQuantity: true,
        quantities: items.map((i) => ({ inventoryItemId: i.inventoryItemId, locationId, quantity: i.quantity }))
      }
    }
  );
  const errs = (data.inventorySetQuantities as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/**
 * The supplier.* metafields the theme's PDP already renders
 * (supplier-aware stock checks): name, status, available_qty, last_checked_at.
 */
export async function setSupplierMetafields(
  admin: AdminGraphql,
  productId: string,
  m: { status: 'available' | 'low_stock' | 'out_of_stock'; qty: number; checkedAt: string; origin?: string; deliveryDays?: string; deliveryDaysActual?: string }
): Promise<void> {
  const fields = [
    { key: 'name', type: 'single_line_text_field', value: 'CJ' },
    { key: 'status', type: 'single_line_text_field', value: m.status },
    { key: 'available_qty', type: 'number_integer', value: String(Math.max(0, Math.floor(m.qty))) },
    { key: 'last_checked_at', type: 'date_time', value: m.checkedAt },
    // Dispatch origin country code — used to pick the per-product delivery estimate (no shipping-origin claim shown to the customer).
    ...(m.origin ? [{ key: 'origin', type: 'single_line_text_field', value: m.origin }] : []),
    // REPRESENTATIVE order->door estimate (shop display: PDP) from the synced matrix,
    // bare calendar-day range e.g. "6-21". Written ONLY when non-empty — Shopify rejects
    // an empty single_line_text_field (would throw), so a stale/missing band just leaves
    // the last-good value (the theme falls back to its static window only when truly unset).
    ...(m.deliveryDays ? [{ key: 'delivery_days', type: 'single_line_text_field', value: m.deliveryDays }] : []),
    // PER-PRODUCT ACTUAL order->door estimate (this product's own freight) — surfaced at
    // checkout via a line-item property. Same non-empty rule.
    ...(m.deliveryDaysActual ? [{ key: 'delivery_days_actual', type: 'single_line_text_field', value: m.deliveryDaysActual }] : [])
  ];
  const data = await admin(
    `mutation pawscoutMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    { metafields: fields.map((f) => ({ ownerId: productId, namespace: 'supplier', ...f })) }
  );
  const errs = (data.metafieldsSet as { userErrors?: { message: string }[] } | undefined)?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}
