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

async function seed() {
  const s = new TenantStore(env.DB, SHOP);
  const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'p@x.com', name: 'Pat Partner' });
  const voucherId = await s.createAffiliateVoucher({
    partnerId, code: 'PAT5', pctOff: 5, commissionPct: 2, endsAt: new Date(Date.now() + 30 * 86400000).toISOString()
  });
  await s.upsertAffiliateOrder({ shopifyOrderId: 'o1', voucherId, orderName: '#1', grossGbp: 100, discountGbp: 5, commissionGbp: 2, financialStatus: 'PAID', eligible: true, placedAt: '2026-07-01T10:00:00Z' });
  await s.upsertAffiliateOrder({ shopifyOrderId: 'o2', voucherId, orderName: '#2', grossGbp: 50, discountGbp: 2.5, commissionGbp: 1, financialStatus: 'PAID', eligible: true, placedAt: '2026-07-02T10:00:00Z' });
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
    await s.upsertAffiliateOrder({ shopifyOrderId: 'o1', voucherId, orderName: '#1', grossGbp: 0, discountGbp: 0, commissionGbp: 0, financialStatus: 'REFUNDED', eligible: false, placedAt: '2026-07-01T10:00:00Z' });

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
    await s.upsertAffiliateOrder({ shopifyOrderId: 'o3', voucherId, orderName: '#3', grossGbp: 25, discountGbp: 1.25, commissionGbp: 0.5, financialStatus: 'PAID', eligible: true, placedAt: '2026-07-05T10:00:00Z' });

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
