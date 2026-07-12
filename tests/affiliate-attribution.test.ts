/// <reference types="@cloudflare/vitest-pool-workers" />
// Affiliate voucher attribution (2026-07-04): the 15-minute sweep polls orders
// updated since the cursor, matches discount codes to registered vouchers, and
// keeps the ledger's CURRENT amounts honest (refunds claw commission back).
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { attributeAffiliateOrders, AFFIL_CURSOR_KEY, classifySelfReferral, normalizeShippingKey, hashBuyerEmail } from '../src/affiliate-attribution';
import type { AdminGraphql } from '../src/shopify-admin';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';
// Test-only HMAC key material for buyer_email_hash (never a real secret).
const HMAC_SECRET = 'test-hmac-secret';

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

async function seedVoucher(commissionPct = 2, partnerEmail = 'jane@x.com'): Promise<{ store: TenantStore; voucherId: string }> {
  const store = new TenantStore(env.DB, SHOP);
  await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 'read_orders' });
  const partnerId = await store.upsertAffiliatePartner({ contactEmail: partnerEmail, name: 'Jane' });
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
    const r = await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    expect(r).toEqual({ scanned: 0, matched: 0 });
    expect(calls()).toBe(0);
  });

  it('matches a paid order to its voucher: face-value gross, commission on gross', async () => {
    const { store, voucherId } = await seedVoucher(2);
    const { admin } = adminReturning([[orderNode()]]);
    const r = await attributeAffiliateOrders(store, admin, HMAC_SECRET);
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
    const r = await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    expect(r).toEqual({ scanned: 1, matched: 0 });
    expect(await store.affiliateOrdersForVoucher(voucherId)).toHaveLength(0);
    expect(await store.getSearchCache(AFFIL_CURSOR_KEY)).toBe('2026-07-04T10:05:00Z');
  });

  it('matches codes case-insensitively', async () => {
    const { store, voucherId } = await seedVoucher();
    const { admin } = adminReturning([[orderNode({ discountCodes: ['activepaw-jane5'] })]]);
    await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    expect(await store.affiliateOrdersForVoucher(voucherId)).toHaveLength(1);
  });

  it('zeroes commission for unpaid and cancelled orders but keeps the row', async () => {
    const { store, voucherId } = await seedVoucher();
    const { admin } = adminReturning([[
      orderNode({ id: 'gid://shopify/Order/1', name: '#1', displayFinancialStatus: 'PENDING' }),
      orderNode({ id: 'gid://shopify/Order/2', name: '#2', cancelledAt: '2026-07-04T11:00:00Z' }),
    ]]);
    await attributeAffiliateOrders(store, admin, HMAC_SECRET);
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
    await attributeAffiliateOrders(store, first.admin, HMAC_SECRET);
    expect((await store.createAffiliatePayout(voucherId))?.ordersCovered).toBe(1);

    // The refund re-surfaces the order with a newer updated_at and zeroed
    // CURRENT amounts; the re-upsert must zero commission but keep paid_out_at.
    const refunded = adminReturning([[orderNode({
      updatedAt: '2026-07-05T09:00:00Z',
      displayFinancialStatus: 'REFUNDED',
      currentSubtotalPriceSet: { shopMoney: { amount: '0.00' } },
      currentTotalDiscountsSet: { shopMoney: { amount: '0.00' } },
    })]]);
    await attributeAffiliateOrders(store, refunded.admin, HMAC_SECRET);
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
    await attributeAffiliateOrders(store, admin, HMAC_SECRET);
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
    const r = await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    expect(calls()).toBe(2);
    expect(r.matched).toBe(2);
    expect(await store.affiliateOrdersForVoucher(voucherId)).toHaveLength(2);
    expect(await store.getSearchCache(AFFIL_CURSOR_KEY)).toBe('2026-07-04T10:06:00Z');
  });

  it('still records orders for a revoked voucher (the discount was really given)', async () => {
    const { store, voucherId } = await seedVoucher();
    await store.setAffiliateVoucherStatus(voucherId, 'revoked');
    const { admin } = adminReturning([[orderNode()]]);
    await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    expect(await store.affiliateOrdersForVoucher(voucherId)).toHaveLength(1);
  });

  it('still attributes a voucher whose partner row is missing (attributionVouchers is a LEFT JOIN, not INNER) - commission unaffected', async () => {
    const { store, voucherId } = await seedVoucher(2);
    // Simulate an orphaned voucher (partner row gone) directly via D1 - there
    // is no product path that does this today, but the join must not
    // silently drop the voucher from the sweep if one ever appears.
    await env.DB.prepare(`DELETE FROM affiliate_partners WHERE shop = ?1`).bind(SHOP).run();
    const { admin } = adminReturning([[orderNode({ email: 'someone@example.com' })]]);
    await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows).toHaveLength(1);
    expect(rows[0].commission_gbp).toBe(2); // unaffected: computed exactly as before this guard existed
    expect(rows[0].self_referral).toBe(0); // no partner email to compare against - "no determination"
  });
});

// Self-referral guard (independent of signup; applies to ALL partners, not
// just self-serve ones). Commission is zeroed and self_referral flagged when
// the buyer is really the partner; a missing (protected-data-absent) email
// must NEVER be treated as a match.
describe('attributeAffiliateOrders: self-referral guard', () => {
  it('flags self_referral and zeroes commission when the buyer email matches the partner - gross still recorded', async () => {
    const { store, voucherId } = await seedVoucher(2, 'jane@x.com');
    const { admin } = adminReturning([[orderNode({ email: 'jane@x.com' })]]);
    await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows).toHaveLength(1);
    expect(rows[0].self_referral).toBe(1);
    expect(rows[0].commission_gbp).toBe(0); // forced to 0 even though the order is eligible
    expect(rows[0].eligible).toBe(1); // eligibility itself is untouched
    expect(rows[0].gross_gbp).toBe(100); // the sale happened; only commission is denied
    expect(rows[0].buyer_email_hash).toBeTruthy();
    expect(rows[0].buyer_email_hash).not.toBe('jane@x.com'); // never stored raw
  });

  it('does not flag and does not change commission when the order email is null (protected-data-absent case)', async () => {
    const { store, voucherId } = await seedVoucher(2, 'jane@x.com');
    const { admin } = adminReturning([[orderNode({ email: null })]]);
    await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows[0].self_referral).toBe(0);
    expect(rows[0].commission_gbp).toBe(2); // unchanged: 2% of the 100 face value, exactly as before this guard existed
    expect(rows[0].buyer_email_hash).toBeNull();
  });

  it('leaves a normal third-party order unaffected', async () => {
    const { store, voucherId } = await seedVoucher(2, 'jane@x.com');
    const { admin } = adminReturning([[orderNode({ email: 'customer@somewhere-else.com' })]]);
    await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows[0].self_referral).toBe(0);
    expect(rows[0].commission_gbp).toBe(2);
    expect(rows[0].buyer_email_hash).toBeTruthy(); // still hashed and stored (GDPR redaction can find it)
  });

  it('matches a Gmail plus-tag/dot alias of the partner email', async () => {
    const { store, voucherId } = await seedVoucher(2, 'jane.doe@gmail.com');
    const { admin } = adminReturning([[orderNode({ email: 'JaneDoe+promo@gmail.com' })]]);
    await attributeAffiliateOrders(store, admin, HMAC_SECRET);
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows[0].self_referral).toBe(1);
    expect(rows[0].commission_gbp).toBe(0);
  });

  it('stays flagged self_referral and commission zero when a LATER poll of the same order returns no email (sticky, never restored)', async () => {
    const { store, voucherId } = await seedVoucher(2, 'jane@x.com');
    const first = adminReturning([[orderNode({ email: 'jane@x.com' })]]);
    await attributeAffiliateOrders(store, first.admin, HMAC_SECRET);
    let rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows).toHaveLength(1);
    expect(rows[0].self_referral).toBe(1);
    expect(rows[0].commission_gbp).toBe(0);

    // Same order re-surfaces with a newer updated_at and protected order.email
    // now coming back null - which on its own would recompute self_referral=0
    // and a non-zero commission. Absence of protected data must never restore
    // a commission that was already correctly denied.
    const second = adminReturning([[orderNode({
      email: null,
      updatedAt: '2026-07-05T09:00:00Z',
    })]]);
    await attributeAffiliateOrders(store, second.admin, HMAC_SECRET);
    rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows).toHaveLength(1);
    expect(rows[0].self_referral).toBe(1); // still flagged - sticky
    expect(rows[0].commission_gbp).toBe(0); // never restored
  });
});

// Direct store-level coverage for upsertAffiliateOrder's sticky-self-referral
// SQL (tenant-store.ts): self_referral is monotonic (MAX of stored vs new)
// and commission_gbp follows the EFFECTIVE (post-max) self_referral, but a
// normal non-self-referral row must keep updating commission freely in
// either direction, exactly as before this guard existed.
describe('upsertAffiliateOrder: sticky self_referral', () => {
  it('never lets a non-self-referral re-upsert un-stick a self-referral row, even with commissionGbp/selfReferral omitted (defaults false/0)', async () => {
    const { store, voucherId } = await seedVoucher(2, 'jane@x.com');
    await store.upsertAffiliateOrder({
      shopifyOrderId: 'gid://shopify/Order/501', voucherId, orderName: '#501', grossGbp: 100, discountGbp: 5,
      commissionGbp: 0, financialStatus: 'PAID', eligible: true, placedAt: '2026-07-01T00:00:00Z',
      selfReferral: true, buyerEmailHash: 'hash-1',
    });
    // Re-upsert omits selfReferral entirely (defaults to false/0 in the SQL
    // bind) and supplies a non-zero commissionGbp, as a caller that forgot
    // to recompute the guard would.
    await store.upsertAffiliateOrder({
      shopifyOrderId: 'gid://shopify/Order/501', voucherId, orderName: '#501', grossGbp: 100, discountGbp: 5,
      commissionGbp: 2, financialStatus: 'PAID', eligible: true, placedAt: '2026-07-01T00:00:00Z',
    });
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows).toHaveLength(1);
    expect(rows[0].self_referral).toBe(1);
    expect(rows[0].commission_gbp).toBe(0);
  });

  it('still updates commission freely (including upward) for a normal non-self-referral order on re-upsert', async () => {
    const { store, voucherId } = await seedVoucher(2, 'jane@x.com');
    await store.upsertAffiliateOrder({
      shopifyOrderId: 'gid://shopify/Order/502', voucherId, orderName: '#502', grossGbp: 50, discountGbp: 2.5,
      commissionGbp: 1, financialStatus: 'PAID', eligible: true, placedAt: '2026-07-01T00:00:00Z',
      selfReferral: false, buyerEmailHash: null,
    });
    // A correction that raises the amounts (e.g. an edit reversing an earlier
    // partial refund) - commission must move UP, not just clawback DOWN.
    await store.upsertAffiliateOrder({
      shopifyOrderId: 'gid://shopify/Order/502', voucherId, orderName: '#502', grossGbp: 100, discountGbp: 5,
      commissionGbp: 2, financialStatus: 'PAID', eligible: true, placedAt: '2026-07-01T00:00:00Z',
      selfReferral: false, buyerEmailHash: null,
    });
    const rows = await store.affiliateOrdersForVoucher(voucherId);
    expect(rows).toHaveLength(1);
    expect(rows[0].self_referral).toBe(0);
    expect(rows[0].commission_gbp).toBe(2); // moved freely upward - not stuck by the sticky logic
  });
});

// hashBuyerEmail (Fix 1): the stored buyer_email_hash must use the SAME
// Gmail-alias-folded normalization as the match comparison, so they can
// never disagree and a redaction keyed on the canonical form of an alias
// nulls every row for that inbox.
describe('hashBuyerEmail', () => {
  it('hashes a Gmail dot/plus-tag alias identically to its canonical form', async () => {
    const canonical = await hashBuyerEmail('janedoe@gmail.com', HMAC_SECRET);
    const dotted = await hashBuyerEmail('jane.doe@gmail.com', HMAC_SECRET);
    const plusTagged = await hashBuyerEmail('JaneDoe+promo@gmail.com', HMAC_SECRET);
    const dottedAndPlusTagged = await hashBuyerEmail('Jane.Doe+promo@GMail.com', HMAC_SECRET);
    expect(dotted).toBe(canonical);
    expect(plusTagged).toBe(canonical);
    expect(dottedAndPlusTagged).toBe(canonical);
  });

  it('does not fold dots/plus-tags on a non-Gmail domain (folding is Gmail-only, matching classifySelfReferral)', async () => {
    const withDotsAndTag = await hashBuyerEmail('jane.doe+promo@example.com', HMAC_SECRET);
    const canonical = await hashBuyerEmail('janedoe@example.com', HMAC_SECRET);
    expect(withDotsAndTag).not.toBe(canonical); // different local-parts, non-Gmail domain: different hashes
  });

  it('stays consistent with the match decision: two emails classifySelfReferral treats as the same inbox hash identically, and vice versa', async () => {
    const gmailAlias = await hashBuyerEmail('jane.doe+promo@gmail.com', HMAC_SECRET);
    const gmailCanonical = await hashBuyerEmail('jane.doe@gmail.com', HMAC_SECRET);
    expect(classifySelfReferral({ buyerEmail: 'jane.doe+promo@gmail.com', partnerEmail: 'jane.doe@gmail.com' })).toBe(true);
    expect(gmailAlias).toBe(gmailCanonical);

    const otherProviderAlias = await hashBuyerEmail('jane.doe+promo@example.com', HMAC_SECRET);
    const otherProviderCanonical = await hashBuyerEmail('jane.doe@example.com', HMAC_SECRET);
    expect(classifySelfReferral({ buyerEmail: 'jane.doe+promo@example.com', partnerEmail: 'jane.doe@example.com' })).toBe(false);
    expect(otherProviderAlias).not.toBe(otherProviderCanonical);
  });
});

// classifySelfReferral is the pure decision function the guard above is built
// on. The shipping-address branch is unit-tested directly here because no
// current data source populates a partner's known address (affiliate_partners
// has no address column - see task-2-report.md); the comparison is real and
// wired, just dormant in production until that data source exists.
describe('classifySelfReferral (pure)', () => {
  it('flags a shipping-address match even when the email differs', () => {
    const partnerAddressKey = normalizeShippingKey('10 Example Street', 'AB1 2CD');
    const result = classifySelfReferral({
      buyerEmail: 'someone-else@example.com',
      shippingAddress: { address1: '10 Example Street', zip: 'AB1 2CD' },
      partnerEmail: 'jane@x.com',
      partnerAddressKey,
    });
    expect(result).toBe(true);
  });

  it('does not flag when neither email nor shipping address matches', () => {
    const partnerAddressKey = normalizeShippingKey('10 Example Street', 'AB1 2CD');
    const result = classifySelfReferral({
      buyerEmail: 'someone-else@example.com',
      shippingAddress: { address1: '99 Other Road', zip: 'ZZ9 9ZZ' },
      partnerEmail: 'jane@x.com',
      partnerAddressKey,
    });
    expect(result).toBe(false);
  });

  it('skips the shipping comparison entirely when the partner has no known address on file', () => {
    const result = classifySelfReferral({
      buyerEmail: 'someone-else@example.com',
      shippingAddress: { address1: '10 Example Street', zip: 'AB1 2CD' },
      partnerEmail: 'jane@x.com',
      partnerAddressKey: null,
    });
    expect(result).toBe(false);
  });

  it('never matches on a missing buyer email alone', () => {
    const result = classifySelfReferral({
      buyerEmail: null,
      shippingAddress: null,
      partnerEmail: 'jane@x.com',
      partnerAddressKey: null,
    });
    expect(result).toBe(false);
  });
});
