import type { TenantStore } from './tenant-store';
import type { TenantConfig } from './types';

// W-FULFIL Stage A: receive a paid Shopify order, normalise it, and run the
// pre-spend guardrails. The money leg (CJ createOrder + payBalance) is Stage B
// and lives behind these checks - nothing here spends money or calls CJ.

/** £ order total above which we always hold for a human (guardrail). */
export const FULFIL_REVIEW_THRESHOLD_GBP = 100;
/** £ order total above which a Shopify INVESTIGATE (medium-risk) recommendation
 *  holds for a human. Below it, medium-risk orders flow: Shopify flags MEDIUM
 *  often enough that holding them all would drown the operator, and the CJ
 *  spend at stake on a small order is a few pounds. */
export const MEDIUM_RISK_REVIEW_THRESHOLD_GBP = 40;
/** Minutes to wait after payment before auto-submitting (buyer edit/cancel grace). */
export const FULFIL_GRACE_MINUTES = 60;

/**
 * Stage-B fraud-gate policy on Shopify's order risk recommendation
 * (Order.risk.recommendation: ACCEPT | INVESTIGATE | CANCEL | NONE), evaluated
 * just before money moves. CANCEL always holds; INVESTIGATE holds only above
 * MEDIUM_RISK_REVIEW_THRESHOLD_GBP; anything else (including an unavailable
 * read) flows - fail-open, because the GBP100 hard cap and the operator-held
 * queue still bound the worst case, while fail-closed would hold every order
 * whenever the risk API hiccups and train the operator to rubber-stamp.
 */
export function riskHold(recommendation: string | null, totalPriceGbp: number): string | null {
  if (recommendation === 'CANCEL') return 'high-risk';
  if (recommendation === 'INVESTIGATE' && totalPriceGbp > MEDIUM_RISK_REVIEW_THRESHOLD_GBP) return 'medium-risk-value';
  return null;
}

export interface OrderLineItem {
  productId: string | null; // Shopify product GID
  variantId: string | null;
  sku: string | null;
  quantity: number;
  price: number; // per-unit, order currency
  cjPid: string | null; // resolved during validation (null = unmapped)
}

export interface OrderAddress {
  name: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  countryCode: string;
  phone: string;
}

export interface OrderRecord {
  shopifyOrderId: string;
  orderName: string;
  totalPrice: number;
  currency: string;
  financialStatus: string;
  riskLevel: string | null; // LOW | MEDIUM | HIGH | null. The orders/paid webhook
  // payload does NOT carry risk (this stays null at Stage A); Stage B fetches
  // Order.risk via GraphQL before spending and stamps the row then.
  address: OrderAddress | null;
  lineItems: OrderLineItem[];
  noteAttributes: Record<string, string>;
  customerEmail: string | null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Normalise the orders/paid REST webhook payload into an OrderRecord. */
export function parseOrderWebhook(raw: unknown): OrderRecord {
  const o = (raw ?? {}) as Record<string, unknown>;
  const a = (o.shipping_address ?? null) as Record<string, unknown> | null;
  const items = Array.isArray(o.line_items) ? (o.line_items as Record<string, unknown>[]) : [];
  return {
    shopifyOrderId: str(o.id),
    orderName: str(o.name),
    totalPrice: num(o.total_price ?? o.current_total_price),
    currency: str(o.currency || o.presentment_currency || 'GBP'),
    financialStatus: str(o.financial_status),
    riskLevel: o.risk_level ? str(o.risk_level).toUpperCase() : null,
    address: a
      ? {
          name: str(a.name) || `${str(a.first_name)} ${str(a.last_name)}`.trim(),
          address1: str(a.address1),
          address2: str(a.address2),
          city: str(a.city),
          province: str(a.province),
          zip: str(a.zip),
          countryCode: str(a.country_code),
          phone: str(a.phone || o.phone)
        }
      : null,
    lineItems: items.map((li) => ({
      productId: li.product_id != null ? `gid://shopify/Product/${str(li.product_id)}` : null,
      variantId: li.variant_id != null ? `gid://shopify/ProductVariant/${str(li.variant_id)}` : null,
      sku: li.sku ? str(li.sku) : null,
      quantity: num(li.quantity) || 1,
      price: num(li.price),
      cjPid: null
    })),
    noteAttributes: (() => {
      const na: Record<string, string> = {};
      if (Array.isArray(o.note_attributes)) for (const x of o.note_attributes as { name?: unknown; value?: unknown }[]) { if (x && typeof x.name === 'string') na[x.name] = str(x.value); }
      return na;
    })(),
    customerEmail: (() => {
      const cust = (o.customer ?? null) as Record<string, unknown> | null;
      return str(o.email || o.contact_email || (cust ? cust.email : '')) || null;
    })()
  };
}

export function addressComplete(a: OrderAddress | null): boolean {
  return !!a && !!a.name && !!a.address1 && !!a.city && !!a.zip && !!a.countryCode;
}

/**
 * Resolve each line item to its CJ pid and run the pre-spend guardrails. Returns
 * the holds (empty = clears auto-fulfil) and the line items with cjPid filled in.
 * A held order is never auto-submitted - it waits for an operator in the console.
 */
export async function validateOrder(
  order: OrderRecord,
  store: TenantStore,
  _cfg: TenantConfig
): Promise<{ holds: string[]; lineItems: OrderLineItem[] }> {
  const holds: string[] = [];

  // Map every line item to an imported CJ product.
  const lineItems = await Promise.all(
    order.lineItems.map(async (li) => {
      if (!li.productId) return li;
      const link = await store.getLinkByShopifyProductId(li.productId);
      return { ...li, cjPid: link && link.state === 'imported' ? link.cj_pid : null };
    })
  );
  if (lineItems.some((li) => !li.cjPid)) holds.push('unmapped-items');

  if (!addressComplete(order.address)) holds.push('incomplete-address');
  if (order.riskLevel === 'HIGH') holds.push('high-risk');
  if (order.totalPrice > FULFIL_REVIEW_THRESHOLD_GBP) holds.push('over-threshold');
  if (order.financialStatus && order.financialStatus !== 'paid') holds.push('not-paid');

  return { holds, lineItems };
}
