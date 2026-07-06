/// <reference types="@cloudflare/vitest-pool-workers" />
// Affiliate voucher attribution (2026-07-04): the 15-minute sweep polls orders
// updated since the cursor, matches discount codes to registered vouchers, and
// keeps the ledger's CURRENT amounts honest (refunds claw commission back).
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { attributeAffiliateOrders, AFFIL_CURSOR_KEY } from '../src/affiliate-attribution';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

function orderNode(over: Record<string, unknown> = {}) {
  return {
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    createdAt: '2026-07-04T10:00:00Z',
    updatedAt: '2026-07-04T10:05:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    discountCodes: ['ACTIVEPAW-JANE5'],
    currentSubtotalPriceSet: { shopMoney: { amount: '95.00' } },
    currentTotalDiscountsSet: { shopMoney: { amount: '5.00' } },
    ...over,
  };
}

function adminReturning(pages: unknown[][]): { admin: AdminGraphql; calls: () => number } {
  let n = 0;
  const admin: AdminGraphql = async () => {
    const nodes = pages[Math.min(n, pages.length - 1)] ?? [];
    n++;
    return { orders: { pageInfo: { hasNextPage: n < pages.length, endCursor: 'c' + n }, nodes } };
  };
  return { admin, calls: () => n };
}

async function seedVoucher(commissionPct = 2): Promise<{ store: TenantStore; voucherId: string }> {
  const store = new TenantStore(env.DB, SHOP);
  await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 'read_orders' });
  const partnerId = await store.upsertAffiliatePartner({ contactEmail: 'jane@x.com', name: 'Jane' });
  const voucherId = await store.createAffiliateVoucher({
    partnerId, code: 'ACTIVEPAW-JANE5', pctOff: 5, commissionPct, endsAt: '2026-08-03T23:59:59Z',
  });
  return { store, voucherId };
}

describe('attributeAffiliateOrders', () => {
  it('does not call Shopify at all when no vouchers are registered', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 'read_orders' });
    const { admin, calls } = adminReturning([[orderNode()]]);
    const r = await attributeAffiliateOrders(store, admin);
    expect(r).toEqual({ scanned: 0, matched: 0 });
    expect(calls()).toBe(0);
  });

  it('matches a paid order to its voucher: face-value gross, commission on gross', async () => {
    const { store, voucherId } = await seedVoucher(2);
    const { admin } = adminReturning([[orderNode()]]);
    const r = await attributeAffiliateOrders(store, admin);
    expect(r).toEqual({ scanned: 1, matched: 1 });
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows).toHaveLength(1);
    // gross = current subtotal (95, after the 5% code) + discounts (5) = 100 face value
    expect(rows[0].gross_gbp).toBe(100);
    expect(rows[0].discount_gbp).toBe(5);
    expect(rows[0].commission_gbp).toBe(2); // 2% of face value
    expect(rows[0].eligible).toBe(1);
    // cursor advanced to the newest updatedAt seen
    expect(await store.getSearchCache(AFFIL_CURSOR_KEY)).toBe('2026-07-04T10:05:00Z');
  });

  it('ignores orders whose codes match no voucher (still advances the cursor past them)', async () => {
    const { store, voucherId } = await seedVoucher();
    const { admin } = adminReturning([[orderNode({ discountCodes: ['SOMEONE-ELSES-CODE'] })]]);
    const r = await attributeAffiliateOrders(store, admin);
    expect(r).toEqual({ scanned: 1, matched: 0 });
    expect(await store.affiliateOrdersForVoucher(voucherId)).toHaveLength(0);
    expect(await store.getSearchCache(AFFIL_CURSOR_KEY)).toBe('2026-07-04T10:05:00Z');
  });

  it('matches codes case-insensitively', async () => {
    const { store, voucherId } = await seedVoucher();
    const { admin } = adminReturning([[orderNode({ discountCodes: ['activepaw-jane5'] })]]);
    await attributeAffiliateOrders(store, admin);
    expect(await store.affiliateOrdersForVoucher(voucherId)).toHaveLength(1);
  });

  it('zeroes commission for unpaid and cancelled orders but keeps the row', async () => {
    const { store, voucherId } = await seedVoucher();
    const { admin } = adminReturning([[
      orderNode({ id: 'gid://shopify/Order/1', name: '#1', displayFinancialStatus: 'PENDING' }),
      orderNode({ id: 'gid://shopify/Order/2', name: '#2', cancelledAt: '2026-07-04T11:00:00Z' }),
    ]]);
    await attributeAffiliateOrders(store, admin);
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.eligible).toBe(0);
      expect(row.commission_gbp).toBe(0);
      expect(row.gross_gbp).toBe(100); // amounts still recorded honestly
    }
  });

  it('claws commission back on refund while preserving an existing payout stamp', async () => {
    const { store, voucherId } = await seedVoucher(2);
    const first = adminReturning([[orderNode()]]);
    await attributeAffiliateOrders(store, first.admin);
    expect((await store.createAffiliatePayout(voucherId))?.ordersCovered).toBe(1);

    // The refund re-surfaces the order with a newer updated_at and zeroed
    // CURRENT amounts; the re-upsert must zero commission but keep paid_out_at.
    const refunded = adminReturning([[orderNode({
      updatedAt: '2026-07-05T09:00:00Z',
      displayFinancialStatus: 'REFUNDED',
      currentSubtotalPriceSet: { shopMoney: { amount: '0.00' } },
      currentTotalDiscountsSet: { shopMoney: { amount: '0.00' } },
    })]]);
    await attributeAffiliateOrders(store, refunded.admin);
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows).toHaveLength(1);
    expect(rows[0].commission_gbp).toBe(0);
    expect(rows[0].eligible).toBe(0);
    expect(rows[0].paid_out_at).not.toBeNull(); // the payout already happened; the ledger shows both facts
    expect(await store.getSearchCache(AFFIL_CURSOR_KEY)).toBe('2026-07-05T09:00:00Z');
  });

  it('reduces commission pro rata on a partial refund via the CURRENT amounts', async () => {
    const { store, voucherId } = await seedVoucher(2);
    const { admin } = adminReturning([[orderNode({
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      currentSubtotalPriceSet: { shopMoney: { amount: '47.50' } },
      currentTotalDiscountsSet: { shopMoney: { amount: '2.50' } },
    })]]);
    await attributeAffiliateOrders(store, admin);
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows[0].gross_gbp).toBe(50);
    expect(rows[0].commission_gbp).toBe(1); // 2% of the remaining 50
    expect(rows[0].eligible).toBe(1);
  });

  it('walks paginated results and records matches from every page', async () => {
    const { store, voucherId } = await seedVoucher();
    const { admin, calls } = adminReturning([
      [orderNode({ id: 'gid://shopify/Order/1', name: '#1' })],
      [orderNode({ id: 'gid://shopify/Order/2', name: '#2', updatedAt: '2026-07-04T10:06:00Z' })],
    ]);
    const r = await attributeAffiliateOrders(store, admin);
    expect(calls()).toBe(2);
    expect(r.matched).toBe(2);
    expect(await store.affiliateOrdersForVoucher(voucherId)).toHaveLength(2);
    expect(await store.getSearchCache(AFFIL_CURSOR_KEY)).toBe('2026-07-04T10:06:00Z');
  });

  it('still records orders for a revoked voucher (the discount was really given)', async () => {
    const { store, voucherId } = await seedVoucher();
    await store.setAffiliateVoucherStatus(voucherId, 'revoked');
    const { admin } = adminReturning([[orderNode()]]);
    await attributeAffiliateOrders(store, admin);
    expect(await store.affiliateOrdersForVoucher(voucherId)).toHaveLength(1);
  });
});
