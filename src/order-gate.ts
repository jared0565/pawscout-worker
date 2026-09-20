import { riskHold, addressComplete, type OrderAddress } from './fulfil';
import type { AdminGraphql } from './shopify-admin';

// The live-order gate. Pure decision logic evaluated just before money is
// spent on a supplier order - is the Shopify order still live (not
// cancelled, refunded or already fulfilled), does its fraud risk allow
// spend, and which shipping address to trust. No database, no network here:
// readOrderGate takes an injected AdminGraphql caller, and decideGate is a
// pure function.

export const ORDER_GATE_QUERY = `query pawscoutOrderGate($id: ID!) {
  order(id: $id) {
    cancelledAt
    closed
    displayFinancialStatus
    displayFulfillmentStatus
    phone
    risk { recommendation }
    shippingAddress { name address1 address2 city province zip countryCodeV2 phone }
  }
}`;

export interface OrderSnapshot {
  exists: boolean;
  cancelledAt: string | null;
  financialStatus: string | null; // Shopify displayFinancialStatus
  fulfillmentStatus: string | null; // Shopify displayFulfillmentStatus
  riskRecommendation: string | null; // ACCEPT | INVESTIGATE | CANCEL | NONE | null
  address: OrderAddress | null; // null when Shopify returned no shipping address
}

export type GateRead = { ok: true; snapshot: OrderSnapshot } | { ok: false; error: string };

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const EMPTY_SNAPSHOT: OrderSnapshot = {
  exists: false, cancelledAt: null, financialStatus: null, fulfillmentStatus: null, riskRecommendation: null, address: null
};

/** Never throws. ok:false means "could not tell", which the caller treats as DO NOT SPEND. */
export async function readOrderGate(admin: AdminGraphql, shopifyOrderId: string): Promise<GateRead> {
  try {
    const data = await admin(ORDER_GATE_QUERY, { id: `gid://shopify/Order/${shopifyOrderId}` });
    const order = (data.order ?? null) as Record<string, unknown> | null;
    if (!order) return { ok: true, snapshot: EMPTY_SNAPSHOT };
    const addr = (order.shippingAddress ?? null) as Record<string, unknown> | null;
    const risk = (order.risk ?? null) as Record<string, unknown> | null;
    return {
      ok: true,
      snapshot: {
        exists: true,
        cancelledAt: order.cancelledAt == null ? null : str(order.cancelledAt),
        financialStatus: order.displayFinancialStatus == null ? null : str(order.displayFinancialStatus),
        fulfillmentStatus: order.displayFulfillmentStatus == null ? null : str(order.displayFulfillmentStatus),
        riskRecommendation: risk && risk.recommendation != null ? str(risk.recommendation) : null,
        address: addr
          ? {
              name: str(addr.name),
              address1: str(addr.address1),
              address2: str(addr.address2),
              city: str(addr.city),
              province: str(addr.province),
              zip: str(addr.zip),
              countryCode: str(addr.countryCodeV2),
              // Same fallback the order was first recorded with: a customer
              // can give a phone as their contact detail and none on the
              // address, and reading only the address one would look like the
              // phone had just been removed, replace the stored address with
              // one that has none, and send the supplier an empty field.
              phone: str(addr.phone) || str(order.phone)
            }
          : null
      }
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type GateHoldReason =
  | 'refunded'
  | 'already-fulfilled'
  | 'order-missing'
  | 'incomplete-address'
  | 'high-risk'
  | 'medium-risk-value'
  | 'not-paid'
  | 'on-hold';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | null;

export type GateDecision =
  | { action: 'proceed'; address: OrderAddress; addressChanged: boolean; riskLevel: RiskLevel }
  | { action: 'cancel'; reason: 'shopify-cancelled' }
  | { action: 'hold'; reason: GateHoldReason; riskLevel: RiskLevel };

function riskLevelFor(recommendation: string | null): RiskLevel {
  if (recommendation === 'CANCEL') return 'HIGH';
  if (recommendation === 'INVESTIGATE') return 'MEDIUM';
  return recommendation ? 'LOW' : null;
}

/** Trim and lower-case every field, then join, so a case/whitespace-only edit reads as "unchanged".
 *  Coerce with `?? ''` first: OrderAddress's type promises non-null strings, but a caller can hand
 *  in a raw D1 row (a TEXT column defaults to SQL NULL, not '', unless the store layer coerces it)
 *  or an unvalidated Shopify payload, and this must never throw on that. */
function normalisedAddress(a: OrderAddress): string {
  return [a.name, a.address1, a.address2, a.city, a.province, a.zip, a.countryCode, a.phone].map((v) => (v ?? '').trim().toLowerCase()).join('|');
}

function addressDiffersFromStored(shopifyAddr: OrderAddress, storedAddr: OrderAddress | null): boolean {
  return !storedAddr || normalisedAddress(shopifyAddr) !== normalisedAddress(storedAddr);
}

/** riskHold (src/fulfil.ts) today only ever returns 'high-risk', 'medium-risk-value' or null.
 *  Map explicitly instead of casting: an unrecognised future reason string fails CLOSED (treated
 *  as the strictest hold) rather than being silently forced into GateHoldReason by an `as` cast. */
function mapRiskHoldReason(hold: string): GateHoldReason {
  if (hold === 'high-risk' || hold === 'medium-risk-value') return hold;
  return 'high-risk';
}

/**
 * Decide whether it is still safe to spend money on this order, evaluated
 * first-match-wins in the order below:
 * 1. order missing -> hold
 * 2. Shopify-cancelled -> cancel (beats every later check, including risk)
 * 3. financial status is a WHITELIST on PAID (case-insensitive), not a blacklist
 *    on the refunded family: refunded/partially refunded/voided -> hold refunded;
 *    anything else that is not PAID (including null and '') -> hold not-paid.
 *    An unpaid order with every status field null used to fall through every
 *    blacklist check and proceed - the whitelist closes that.
 * 4. fulfillment status (case-insensitive): already (partially) fulfilled -> hold;
 *    ON_HOLD (the merchant paused it in Shopify) -> hold; any other value, and
 *    null, passes - the fulfillment vocabulary is wide and merchant-driven
 *    (UNFULFILLED, OPEN, IN_PROGRESS, SCHEDULED, ...) and it is the payment
 *    whitelist above, not this list, that makes the gate fail closed.
 * 5. no usable shipping address -> hold
 * 6. fraud risk, unless skipRisk -> hold
 * 7. otherwise -> proceed
 *
 * skipRisk only ever skips step 6 - every earlier step still applies.
 */
export function decideGate(
  s: OrderSnapshot,
  stored: { address: OrderAddress | null; totalPrice: number; skipRisk: boolean }
): GateDecision {
  const riskLevel = riskLevelFor(s.riskRecommendation);

  if (!s.exists) return { action: 'hold', reason: 'order-missing', riskLevel };
  if (s.cancelledAt) return { action: 'cancel', reason: 'shopify-cancelled' };

  const financialUpper = (s.financialStatus ?? '').toUpperCase();
  if (financialUpper === 'REFUNDED' || financialUpper === 'PARTIALLY_REFUNDED' || financialUpper === 'VOIDED') {
    return { action: 'hold', reason: 'refunded', riskLevel };
  }
  if (financialUpper !== 'PAID') return { action: 'hold', reason: 'not-paid', riskLevel };

  const fulfillmentUpper = (s.fulfillmentStatus ?? '').toUpperCase();
  if (fulfillmentUpper === 'FULFILLED' || fulfillmentUpper === 'PARTIALLY_FULFILLED') {
    return { action: 'hold', reason: 'already-fulfilled', riskLevel };
  }
  if (fulfillmentUpper === 'ON_HOLD') return { action: 'hold', reason: 'on-hold', riskLevel };

  // A missing Shopify address is not a change - fall back to the stored one.
  const address = s.address ?? stored.address;
  if (!addressComplete(address)) return { action: 'hold', reason: 'incomplete-address', riskLevel };
  const addressChanged = !!s.address && addressDiffersFromStored(s.address, stored.address);

  if (!stored.skipRisk) {
    const hold = riskHold(s.riskRecommendation, stored.totalPrice);
    if (hold) return { action: 'hold', reason: mapRiskHoldReason(hold), riskLevel };
  }

  return { action: 'proceed', address: address as OrderAddress, addressChanged, riskLevel };
}
