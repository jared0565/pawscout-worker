/// <reference types="@cloudflare/vitest-pool-workers" />
// Commission payout records (2026-07-06): the accounting documentation. Every
// "Mark commission paid" writes an immutable affiliate_payouts row - amount,
// method, reference, and the covered orders SNAPSHOT at payout time - so the
// live ledger stays honest about refunds while what was actually paid can
// never be rewritten. These tests pin exactly that separation.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { getPartners, partnerVoucherAction, getPartnerOrders } from '../src/console/routes';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

// Orders must be past the commission clearance hold (COMMISSION_CLEARANCE_DAYS)
// to be payable, so these payout-mechanics tests seed CLEARED orders (well over
// the hold). daysAgo keeps them relative to now so the tests never rot as the
// clock moves. The clearance gate itself is tested separately below.
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

async function seed() {
  const s = new TenantStore(env.DB, SHOP);
  const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'p@x.com', name: 'Pat Partner' });
  const voucherId = await s.createAffiliateVoucher({
    partnerId, code: 'PAT5', pctOff: 5, commissionPct: 2, endsAt: new Date(Date.now() + 30 * 86400000).toISOString()
  });
  await s.upsertAffiliateOrder({ shopifyOrderId: 'o1', voucherId, orderName: '#1', grossGbp: 100, discountGbp: 5, commissionGbp: 2, financialStatus: 'PAID', eligible: true, placedAt: daysAgo(60) });
  await s.upsertAffiliateOrder({ shopifyOrderId: 'o2', voucherId, orderName: '#2', grossGbp: 50, discountGbp: 2.5, commissionGbp: 1, financialStatus: 'PAID', eligible: true, placedAt: daysAgo(59) });
  return { s, voucherId, partnerId };
}

describe('payout records', () => {
  it('records amount, method, reference and the frozen order snapshot', async () => {
    const { voucherId } = await seed();
    const r = await partnerVoucherAction(env.DB, SHOP, voucherId, 'mark_paid', { method: 'PayPal', reference: 'TX-123' });
    expect(r).toMatchObject({ ok: true, ordersCovered: 2, amount: 3 });

    const drill = await getPartnerOrders(env.DB, SHOP, voucherId);
    if (!drill.ok) throw new Error('drill failed');
    expect(drill.payouts.length).toBe(1);
    const p = drill.payouts[0];
    expect(p.amount).toBe(3);
    expect(p.ordersCount).toBe(2);
    expect(p.method).toBe('PayPal');
    expect(p.reference).toBe('TX-123');
    expect((p.orders as { name: string; commission: number }[]).map((o) => o.name).sort()).toEqual(['#1', '#2']);
    // Every stamped order carries the payout id for the ledger export.
    expect(drill.orders.every((o) => o.payoutId === p.payoutId)).toBe(true);
  });

  it('a refund AFTER the payout corrects the live ledger but never the payout record', async () => {
    const { s, voucherId } = await seed();
    await partnerVoucherAction(env.DB, SHOP, voucherId, 'mark_paid', {});
    // The 15-minute sweep re-surfaces #1 fully refunded: live commission drops to 0.
    await s.upsertAffiliateOrder({ shopifyOrderId: 'o1', voucherId, orderName: '#1', grossGbp: 0, discountGbp: 0, commissionGbp: 0, financialStatus: 'REFUNDED', eligible: false, placedAt: daysAgo(60) });

    const row = (await getPartners(env.DB, SHOP)).partners[0];
    expect(row.paid).toBe(3);   // cash that really left - frozen in the payout
    expect(row.owed).toBe(0);   // nothing new is owed
    const drill = await getPartnerOrders(env.DB, SHOP, voucherId);
    if (!drill.ok) throw new Error('drill failed');
    expect(drill.payouts[0].amount).toBe(3); // snapshot untouched
    const refunded = drill.orders.find((o) => o.name === '#1')!;
    expect(refunded.commission).toBe(0);     // live ledger stays honest
  });

  it('a second payout covers only orders since the first', async () => {
    const { s, voucherId } = await seed();
    await partnerVoucherAction(env.DB, SHOP, voucherId, 'mark_paid', {});
    await s.upsertAffiliateOrder({ shopifyOrderId: 'o3', voucherId, orderName: '#3', grossGbp: 25, discountGbp: 1.25, commissionGbp: 0.5, financialStatus: 'PAID', eligible: true, placedAt: daysAgo(55) });

    const r2 = await partnerVoucherAction(env.DB, SHOP, voucherId, 'mark_paid', { method: 'bank transfer' });
    expect(r2).toMatchObject({ ok: true, ordersCovered: 1, amount: 0.5 });
    const drill = await getPartnerOrders(env.DB, SHOP, voucherId);
    if (!drill.ok) throw new Error('drill failed');
    expect(drill.payouts.length).toBe(2);
    expect(drill.payouts[0].amount).toBe(0.5); // newest first
    expect((await getPartners(env.DB, SHOP)).partners[0].paid).toBe(3.5);
  });

  it('refuses a payout when nothing is owed', async () => {
    const { voucherId } = await seed();
    await partnerVoucherAction(env.DB, SHOP, voucherId, 'mark_paid', {});
    const again = await partnerVoucherAction(env.DB, SHOP, voucherId, 'mark_paid', {});
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('Nothing is owed');
  });
});

// Commission clearance hold (2026-07-14): commission is only PAYABLE once the
// order has cleared the return window (COMMISSION_CLEARANCE_DAYS after the
// order). Refunds during the hold already zero the commission, so what survives
// to clearance is a genuinely settled sale. All three readers (payout, console
// owed, portal) gate on the same server-side cutoff off an injectable `now`.
describe('commission clearance hold', () => {
  async function seedOne(shop: string, placedAt: string, opts: { eligible?: boolean; commission?: number } = {}) {
    const s = new TenantStore(env.DB, shop);
    const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'h@x.com', name: 'Holly' });
    const voucherId = await s.createAffiliateVoucher({ partnerId, code: 'HOLD5', pctOff: 5, commissionPct: 2, endsAt: new Date(Date.now() + 30 * 86400000).toISOString() });
    await s.upsertAffiliateOrder({ shopifyOrderId: 'h1', voucherId, orderName: '#H1', grossGbp: 100, discountGbp: 5, commissionGbp: opts.commission ?? 2, financialStatus: opts.eligible === false ? 'REFUNDED' : 'PAID', eligible: opts.eligible ?? true, placedAt });
    return { s, voucherId, partnerId };
  }

  it('an order at day 44 is NOT payable; the same order at day 46 IS', async () => {
    const { s, voucherId } = await seedOne('d44.myshopify.com', daysAgo(44));
    // Day 44: inside the hold - createAffiliatePayout finds nothing to snapshot.
    expect(await s.createAffiliatePayout(voucherId)).toBeNull();
    const listNow = await s.listAffiliateVouchers();
    expect(listNow[0].owed).toBe(2);          // earned + unpaid (total)
    expect(listNow[0].owed_cleared).toBe(0);  // but not yet payable
    expect(listNow[0].owed_maturing).toBe(2);
    // Advance "now" 2 more days (order is now 46 days old) -> cleared + payable.
    const later = Date.now() + 2 * 86400000;
    expect((await s.listAffiliateVouchers(later))[0].owed_cleared).toBe(2); // cleared BEFORE paying
    const p = await s.createAffiliatePayout(voucherId, {}, later);
    expect(p).toMatchObject({ amount: 2, ordersCovered: 1 });
    expect((await s.listAffiliateVouchers(later))[0].owed_cleared).toBe(0); // now paid, no longer owed
  });

  it('a cleared-age order that was refunded during the hold pays nothing', async () => {
    const { s, voucherId } = await seedOne('ref.myshopify.com', daysAgo(60), { eligible: false, commission: 0 });
    expect(await s.createAffiliatePayout(voucherId)).toBeNull(); // ineligible, commission 0
    expect((await s.listAffiliateVouchers())[0].owed_cleared).toBe(0);
  });

  it('null placed_at falls back to created_at so commission can never be stranded', async () => {
    const s = new TenantStore(env.DB, 'nul.myshopify.com');
    const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'n@x.com', name: 'Nula' });
    const voucherId = await s.createAffiliateVoucher({ partnerId, code: 'NUL5', pctOff: 5, commissionPct: 2, endsAt: new Date(Date.now() + 30 * 86400000).toISOString() });
    // placedAt null; the row's created_at is stamped ~now, so at now it's NOT
    // cleared (fresh), but well past the hold it IS - it never gets stuck.
    await s.upsertAffiliateOrder({ shopifyOrderId: 'n1', voucherId, orderName: '#N1', grossGbp: 100, discountGbp: 5, commissionGbp: 2, financialStatus: 'PAID', eligible: true, placedAt: null });
    expect(await s.createAffiliatePayout(voucherId)).toBeNull(); // fresh created_at -> maturing
    const later = Date.now() + 50 * 86400000;
    expect(await s.createAffiliatePayout(voucherId, {}, later)).toMatchObject({ amount: 2, ordersCovered: 1 });
  });

  it('portal summary splits pending into available (cleared) + maturing on the same cutoff', async () => {
    const s = new TenantStore(env.DB, 'pf.myshopify.com');
    const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'pf@x.com', name: 'Pf' });
    const voucherId = await s.createAffiliateVoucher({ partnerId, code: 'PF5', pctOff: 5, commissionPct: 2, endsAt: new Date(Date.now() + 30 * 86400000).toISOString() });
    await s.upsertAffiliateOrder({ shopifyOrderId: 'c1', voucherId, orderName: '#C1', grossGbp: 100, discountGbp: 5, commissionGbp: 2, financialStatus: 'PAID', eligible: true, placedAt: daysAgo(60) }); // cleared
    await s.upsertAffiliateOrder({ shopifyOrderId: 'm1', voucherId, orderName: '#M1', grossGbp: 100, discountGbp: 5, commissionGbp: 3, financialStatus: 'PAID', eligible: true, placedAt: daysAgo(10) }); // maturing
    const sum = await s.partnerPortalSummary(partnerId);
    expect(sum.pending_gbp).toBe(5);   // total unpaid (unchanged meaning)
    expect(sum.available_gbp).toBe(2); // cleared portion
    expect(sum.maturing_gbp).toBe(3);  // still in the hold
  });
});
