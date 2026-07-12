// Affiliate voucher attribution (2026-07-04): keeps the commission ledger in
// step with Shopify. Rides the 15-minute order pipeline (read_orders scope,
// already granted): polls orders updated since the stored cursor, matches
// their discount codes to registered vouchers, and upserts one ledger row per
// (order, voucher). Because the poll keys on updated_at, refunds and edits
// re-surface the order and the recomputed CURRENT amounts claw commission
// back automatically. Phase 1 deliberately needs no write_discounts: the code
// itself is created by the owner in Shopify admin and registered in the
// Partners view.
import type { AdminGraphql } from './shopify-admin';
import type { TenantStore } from './tenant-store';
import { hmacHex } from './retention';

export const AFFIL_CURSOR_KEY = 'affil:orders-cursor';
const CURSOR_TTL_DAYS = 90; // refreshed every run; expiry just forces a bounded re-scan
const PAGE_SIZE = 50;
const MAX_PAGES = 5; // 250 orders per run; the cursor carries any overflow to the next run

// Commission counts only while the money is really ours: paid (or partially
// refunded, where the CURRENT amounts already exclude the refunded part) and
// not cancelled. Anything else zeroes commission but keeps the row, so a later
// payment or refund flips it honestly in place.
const ELIGIBLE_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED']);

const ORDERS_QUERY = `query pawscoutAffiliateOrders($q: String!, $first: Int!, $after: String) {
  orders(first: $first, query: $q, sortKey: UPDATED_AT, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      updatedAt
      cancelledAt
      displayFinancialStatus
      discountCodes
      email
      shippingAddress { address1 zip }
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalDiscountsSet { shopMoney { amount } }
    }
  }
}`;

interface OrderNode {
  id: string;
  name?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  cancelledAt?: string | null;
  displayFinancialStatus?: string | null;
  discountCodes?: (string | null)[] | null;
  // Protected customer data: null unless the app dashboard grants field-level
  // access to order email/shipping address. A null value here is NOT "no
  // buyer" - it may just mean the field is unavailable - so the self-referral
  // guard treats null as "no determination", never a false negative or a
  // commission change (see classifySelfReferral / the call site below).
  email?: string | null;
  shippingAddress?: { address1?: string | null; zip?: string | null } | null;
  currentSubtotalPriceSet?: { shopMoney?: { amount?: string | null } | null } | null;
  currentTotalDiscountsSet?: { shopMoney?: { amount?: string | null } | null } | null;
}

interface OrdersConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: OrderNode[] | null;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// --- Self-referral guard (independent of signup; applies to ALL partners) ---
// When the order's buyer is really the partner behind the voucher, the sale
// still happened (gross/discount stay honest) but no commission is paid.
// Accepted as a speed bump, not a hard security boundary - the low usage
// limit + tier review + revoke are the real controls.

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Normalize an email for BOTH the self-referral match comparison AND the
 *  stored `buyer_email_hash` - one shared function so the two can never
 *  drift apart. Lowercase+trim, plus Gmail-specific alias folding: Gmail
 *  ignores dots and anything after a `+` in the local part, so two addresses
 *  that differ only that way are the same inbox and must both match AND
 *  hash identically. That also means a future GDPR redaction keyed on a
 *  person's canonical email nulls ALL of that inbox's order-hash rows, not
 *  just rows that happen to have the literal alias string. Folding is
 *  scoped to Gmail's own domains; other providers may treat dots/plus-tags
 *  as significant, so folding them too would risk a false match. (Earlier
 *  revision kept the hash plain-normalized on the theory that
 *  `redactContact` needed to independently recompute the same hash from a
 *  plain email to null a row - it does not: `redactContact` only compares
 *  against whatever `emailHash` the caller supplies, so there is no
 *  competing constraint here.) */
function normalizeEmailForSelfReferral(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 0) return e;
  const domain = e.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return e;
  const local = e.slice(0, at).split('+')[0].replace(/\./g, '');
  return `${local}@${domain}`;
}

/** Keyed hash (HMAC-SHA256) of the buyer's normalized (Gmail-alias-folded)
 *  email for `affiliate_orders.buyer_email_hash`. Never store the raw
 *  email. Uses the exact same normalization as the match comparison below,
 *  so the stored hash and the self-referral decision can never disagree. */
export function hashBuyerEmail(email: string, secret: string): Promise<string> {
  return hmacHex(normalizeEmailForSelfReferral(email), secret);
}

/** Normalized shipping-address key: lowercase, punctuation/space-stripped
 *  address1 + zip. Returns null when either half is missing - there is
 *  nothing usable to compare. */
export function normalizeShippingKey(address1?: string | null, zip?: string | null): string | null {
  const a = (address1 ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const z = (zip ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!a || !z) return null;
  return `${a}|${z}`;
}

export interface SelfReferralCheck {
  buyerEmail?: string | null;
  shippingAddress?: { address1?: string | null; zip?: string | null } | null;
  // Nullable: attributionVouchers() LEFT JOINs affiliate_partners, so a
  // voucher whose partner row is ever missing still reaches this guard with
  // no email to compare - that must degrade to "no determination", not drop
  // the voucher from the sweep (see tenant-store.ts attributionVouchers).
  partnerEmail?: string | null;
  // Normalized (normalizeShippingKey form) key for the partner's own known
  // shipping address, when one is on file. No data source populates this
  // today - affiliate_partners has no address column - so this is always
  // null/undefined in production; the comparison stays real and tested so
  // nothing else has to change once such a column exists. See task-2-report.md.
  partnerAddressKey?: string | null;
}

/** Pure self-referral decision: true when the buyer's email or shipping
 *  address matches the voucher's partner. A missing/empty buyerEmail (or
 *  partnerEmail) can never cause a match on its own - callers must treat
 *  that as "no determination", not evidence either way (see
 *  attributeAffiliateOrders). */
export function classifySelfReferral(input: SelfReferralCheck): boolean {
  const buyer = (input.buyerEmail ?? '').trim();
  const partner = (input.partnerEmail ?? '').trim();
  if (buyer && partner && normalizeEmailForSelfReferral(buyer) === normalizeEmailForSelfReferral(partner)) return true;
  if (input.partnerAddressKey) {
    const shipKey = normalizeShippingKey(input.shippingAddress?.address1, input.shippingAddress?.zip);
    if (shipKey && shipKey === input.partnerAddressKey) return true;
  }
  return false;
}

/** Poll recently-updated orders and refresh the affiliate ledger. Returns the
 *  scan/match counts for logging. Early-exits (no Shopify call) when the shop
 *  has no registered vouchers, so uninvolved tenants pay nothing for this.
 *  `hmacSecret` keys the buyer_email_hash written to affiliate_orders (the
 *  caller passes env.SHOPIFY_API_SECRET - the same secret already used for
 *  other keyed hashes in this codebase, e.g. retention.ts's unsubscribe
 *  token). */
export async function attributeAffiliateOrders(
  store: TenantStore,
  admin: AdminGraphql,
  hmacSecret: string
): Promise<{ scanned: number; matched: number }> {
  const vouchers = await store.attributionVouchers();
  if (!vouchers.length) return { scanned: 0, matched: 0 };
  const byCode = new Map(vouchers.map((v) => [v.code.toUpperCase(), v]));

  let since = await store.getSearchCache(AFFIL_CURSOR_KEY);
  if (!since) {
    // First run (or expired cursor): look back to the earliest registration,
    // with an hour of slack, so orders placed just before registering count.
    const earliest = vouchers.map((v) => v.created_at).sort()[0];
    since = new Date(new Date(earliest).getTime() - 3600_000).toISOString();
  }

  const q = `updated_at:>='${since}'`;
  let after: string | null = null;
  let scanned = 0;
  let matched = 0;
  let maxUpdated = '';
  let noEmailCount = 0; // matched orders where protected order.email came back null

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await admin(ORDERS_QUERY, { q, first: PAGE_SIZE, after });
    const conn = data.orders as OrdersConnection | undefined;
    const nodes = conn?.nodes ?? [];
    for (const n of nodes ?? []) {
      scanned++;
      if (n.updatedAt && n.updatedAt > maxUpdated) maxUpdated = n.updatedAt;
      const codes = (n.discountCodes ?? [])
        .map((c) => (c ?? '').trim().toUpperCase())
        .filter(Boolean);
      for (const code of codes) {
        const v = byCode.get(code);
        if (!v) continue;
        // Face value (the commission base the owner promised): the CURRENT
        // goods subtotal plus the discounts taken off it - i.e. what the goods
        // cost before the voucher, excluding shipping. "Current" fields shrink
        // with refunds/edits, so partial refunds reduce commission pro rata.
        const subtotal = Number(n.currentSubtotalPriceSet?.shopMoney?.amount ?? 0) || 0;
        const discounts = Number(n.currentTotalDiscountsSet?.shopMoney?.amount ?? 0) || 0;
        const gross = round2(subtotal + discounts);
        const eligible = !n.cancelledAt && ELIGIBLE_STATUSES.has(n.displayFinancialStatus ?? '');

        // Self-referral guard: order.email/shippingAddress are protected
        // customer data and come back null unless the app dashboard grants
        // field-level access. A null email is "no determination" - it must
        // never be read as "no buyer" and never changes commission on its
        // own. Counted (not logged per-order - up to 250 orders/run would
        // spam the log while access is ungranted) and summarized once below.
        const buyerEmail = n.email ?? null;
        if (!buyerEmail) noEmailCount++;
        const selfReferral = classifySelfReferral({
          buyerEmail,
          shippingAddress: n.shippingAddress ?? null,
          partnerEmail: v.partner_email,
          partnerAddressKey: null, // no partner-address data source yet; see classifySelfReferral doc
        });
        const buyerEmailHash = buyerEmail ? await hashBuyerEmail(buyerEmail, hmacSecret) : null;

        await store.upsertAffiliateOrder({
          shopifyOrderId: n.id,
          voucherId: v.id,
          orderName: n.name ?? null,
          grossGbp: gross,
          discountGbp: round2(discounts),
          // The sale still happened (gross/discount stay honest above), but a
          // self-referral order earns no commission - even one that would
          // otherwise be eligible.
          commissionGbp: selfReferral ? 0 : (eligible ? round2((gross * v.commission_pct) / 100) : 0),
          financialStatus: n.displayFinancialStatus ?? null,
          eligible,
          placedAt: n.createdAt ?? null,
          buyerEmailHash,
          selfReferral,
        });
        matched++;
      }
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }

  // Advance the cursor only past orders actually seen. The next run queries
  // `updated_at:>=` so the boundary order is re-read once - the upsert makes
  // that idempotent - and nothing can fall in a gap.
  if (maxUpdated) await store.putSearchCache(AFFIL_CURSOR_KEY, maxUpdated, CURSOR_TTL_DAYS);
  if (noEmailCount) {
    console.warn(`affiliate attribution: ${noEmailCount} of ${matched} matched order(s) had no email (protected customer data access likely not granted) - self-referral guard is inert for those rows, commission unaffected`);
  }
  return { scanned, matched };
}
