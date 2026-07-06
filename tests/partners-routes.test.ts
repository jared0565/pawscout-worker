/// <reference types="@cloudflare/vitest-pool-workers" />
// Partners view API (2026-07-04): register a collaborator's voucher, read the
// rolled-up ledger, revoke a code on record, stamp payouts, and drill into the
// attributed orders behind one voucher's numbers.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { getPartners, createPartner, partnerVoucherAction, getPartnerOrders } from '../src/console/routes';
import type { PartnerRegistration } from '../src/validate';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

const REG: PartnerRegistration = {
  contactEmail: 'jane@x.com', name: 'Jane', channelUrl: 'https://example.com/jane', notes: null,
  code: 'ACTIVEPAW-JANE5', pctOff: 5, commissionPct: 2, endsAt: '2099-08-03T23:59:59.000Z', usageLimit: 100,
};

async function seed() {
  const store = new TenantStore(env.DB, SHOP);
  await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 'read_orders' });
  return store;
}

describe('createPartner + getPartners', () => {
  it('registers a partner + voucher and lists it with zeroed ledger numbers', async () => {
    await seed();
    const r = await createPartner(env.DB, SHOP, REG);
    expect(r.ok).toBe(true);
    const list = await getPartners(env.DB, SHOP);
    expect(list.partners).toHaveLength(1);
    const p = list.partners[0];
    expect(p.email).toBe('jane@x.com');
    expect(p.code).toBe('ACTIVEPAW-JANE5');
    expect(p.status).toBe('live');
    expect(p.uses).toBe(0);
    expect(p.gross).toBe(0);
    expect(p.owed).toBe(0);
  });

  it('rejects a duplicate code with a friendly error', async () => {
    await seed();
    expect((await createPartner(env.DB, SHOP, REG)).ok).toBe(true);
    const dup = await createPartner(env.DB, SHOP, { ...REG, contactEmail: 'other@x.com' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('ACTIVEPAW-JANE5');
  });

  it('re-registering the same email reuses the partner for a second voucher', async () => {
    const store = await seed();
    const a = await createPartner(env.DB, SHOP, REG);
    const b = await createPartner(env.DB, SHOP, { ...REG, code: 'ACTIVEPAW-JANE10' });
    if (!a.ok || !b.ok) throw new Error('registration failed');
    expect(b.partnerId).toBe(a.partnerId);
    expect(await store.listAffiliateVouchers()).toHaveLength(2);
  });

  it('derives expired status from ends_at without any cron', async () => {
    await seed();
    await createPartner(env.DB, SHOP, { ...REG, endsAt: '2020-01-01T00:00:00.000Z' });
    const list = await getPartners(env.DB, SHOP);
    expect(list.partners[0].status).toBe('expired');
  });
});

describe('ledger roll-up + actions', () => {
  async function seedWithOrders() {
    const store = await seed();
    const r = await createPartner(env.DB, SHOP, REG);
    if (!r.ok) throw new Error('registration failed');
    const voucherId = r.voucherId;
    // two eligible orders + one refunded (zero commission, ineligible)
    await store.upsertAffiliateOrder({ shopifyOrderId: 'o1', voucherId, orderName: '#1', grossGbp: 100, discountGbp: 5, commissionGbp: 2, financialStatus: 'PAID', eligible: true, placedAt: '2026-07-01T10:00:00Z' });
    await store.upsertAffiliateOrder({ shopifyOrderId: 'o2', voucherId, orderName: '#2', grossGbp: 50, discountGbp: 2.5, commissionGbp: 1, financialStatus: 'PAID', eligible: true, placedAt: '2026-07-02T10:00:00Z' });
    await store.upsertAffiliateOrder({ shopifyOrderId: 'o3', voucherId, orderName: '#3', grossGbp: 80, discountGbp: 4, commissionGbp: 0, financialStatus: 'REFUNDED', eligible: false, placedAt: '2026-07-03T10:00:00Z' });
    return { store, voucherId };
  }

  it('rolls up uses/gross/discount over eligible orders and splits owed vs paid', async () => {
    const { voucherId } = await seedWithOrders();
    const before = (await getPartners(env.DB, SHOP)).partners[0];
    expect(before.uses).toBe(2);           // refunded order does not count as a use
    expect(before.gross).toBe(150);
    expect(before.discount).toBe(7.5);
    expect(before.owed).toBe(3);
    expect(before.paid).toBe(0);
    expect(before.lastOrderAt).toBe('2026-07-03T10:00:00Z');

    const mark = await partnerVoucherAction(env.DB, SHOP, voucherId, 'mark_paid');
    expect(mark).toMatchObject({ ok: true, ordersCovered: 2, amount: 3 }); // the £0-commission refund is not "covered"
    const after = (await getPartners(env.DB, SHOP)).partners[0];
    expect(after.owed).toBe(0);
    expect(after.paid).toBe(3);
  });

  it('revoke flips the status on record', async () => {
    const { voucherId } = await seedWithOrders();
    const r = await partnerVoucherAction(env.DB, SHOP, voucherId, 'revoke');
    expect(r.ok).toBe(true);
    expect((await getPartners(env.DB, SHOP)).partners[0].status).toBe('revoked');
  });

  it('rejects unknown actions and a missing voucherId', async () => {
    await seedWithOrders();
    expect((await partnerVoucherAction(env.DB, SHOP, 'x', 'delete')).ok).toBe(false);
    expect((await partnerVoucherAction(env.DB, SHOP, '', 'revoke')).ok).toBe(false);
    expect((await partnerVoucherAction(env.DB, SHOP, undefined, 'revoke')).ok).toBe(false);
  });

  it('drills into the attributed orders newest-first with payout stamps', async () => {
    const { voucherId } = await seedWithOrders();
    await partnerVoucherAction(env.DB, SHOP, voucherId, 'mark_paid');
    const r = await getPartnerOrders(env.DB, SHOP, voucherId);
    if (!r.ok) throw new Error('orders fetch failed');
    expect(r.orders.map((o) => o.name)).toEqual(['#3', '#2', '#1']);
    const [refunded, , paid] = r.orders;
    expect(refunded.eligible).toBe(false);
    expect(refunded.paidOutAt).toBeNull();
    expect(paid.eligible).toBe(true);
    expect(paid.paidOutAt).not.toBeNull();
    expect(paid.commission).toBe(2);
  });
});
