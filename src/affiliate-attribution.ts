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
  currentSubtotalPriceSet?: { shopMoney?: { amount?: string | null } | null } | null;
  currentTotalDiscountsSet?: { shopMoney?: { amount?: string | null } | null } | null;
}

interface OrdersConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: OrderNode[] | null;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Poll recently-updated orders and refresh the affiliate ledger. Returns the
 *  scan/match counts for logging. Early-exits (no Shopify call) when the shop
 *  has no registered vouchers, so uninvolved tenants pay nothing for this. */
export async function attributeAffiliateOrders(
  store: TenantStore,
  admin: AdminGraphql
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
        await store.upsertAffiliateOrder({
          shopifyOrderId: n.id,
          voucherId: v.id,
          orderName: n.name ?? null,
          grossGbp: gross,
          discountGbp: round2(discounts),
          commissionGbp: eligible ? round2((gross * v.commission_pct) / 100) : 0,
          financialStatus: n.displayFinancialStatus ?? null,
          eligible,
          placedAt: n.createdAt ?? null,
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
  return { scanned, matched };
}
