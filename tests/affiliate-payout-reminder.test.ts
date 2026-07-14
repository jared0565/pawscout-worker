/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore, listActiveShops } from '../src/tenant-store';
import { maybeAffiliatePayoutReminder } from '../src/affiliate-payout-reminder';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type Env } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

async function seedShopWithClearedCommission(alertEmail = 'owner@activepaw.co.uk') {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await s.seedConfig({
    collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL,
    inbox: { ...DEFAULT_INBOX, alertEmail }, target: 12
  });
  // seedConfig intentionally skips the inbox column (dedicated saver), so persist
  // the owner alert address explicitly - it is what the reminder emails.
  await s.saveInbox({ ...DEFAULT_INBOX, alertEmail });
  const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'p@x.com', name: 'Pat' });
  const voucherId = await s.createAffiliateVoucher({ partnerId, code: 'PAT5', pctOff: 5, commissionPct: 2, endsAt: new Date(Date.now() + 30 * 86400000).toISOString() });
  await s.upsertAffiliateOrder({ shopifyOrderId: 'c1', voucherId, orderName: '#C1', grossGbp: 100, discountGbp: 5, commissionGbp: 2, financialStatus: 'PAID', eligible: true, placedAt: daysAgo(60) }); // cleared
  return s;
}

// A 1st-of-month instant and a mid-month instant, at real years so the config/order
// timestamps (relative to Date.now()) stay valid.
const firstOfMonth = new Date(Date.UTC(2027, 0, 1, 9, 0, 0)).getTime();
const midMonth = new Date(Date.UTC(2027, 0, 15, 9, 0, 0)).getTime();

function captureFetch(sink: { calls: { url: string; body: string }[] }): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    sink.calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
  }) as unknown as typeof fetch;
}

// Reference env.DB explicitly (a spread of cloudflare:test's env does not carry
// the live D1 binding through, so listActiveShops would see an empty database).
const ENV = { DB: env.DB, RESEND_API_KEY: 'rk' } as unknown as Env;

describe('maybeAffiliatePayoutReminder', () => {
  it('on the 1st, emails the owner the cleared amount awaiting payout', async () => {
    const s = await seedShopWithClearedCommission();
    // Sanity: the seeded order is cleared at the reminder instant.
    expect((await s.listAffiliateVouchers(firstOfMonth))[0].owed_cleared).toBe(2);
    expect(await listActiveShops(env.DB)).toContain(SHOP); // reminder's shop discovery
    expect((await s.getConfig())?.inbox.alertEmail).toBe('owner@activepaw.co.uk'); // reminder's config read
    const sink = { calls: [] as { url: string; body: string }[] };
    await maybeAffiliatePayoutReminder(ENV, firstOfMonth, captureFetch(sink));
    const resend = sink.calls.filter((c) => c.url.includes('resend.com'));
    expect(resend.length).toBe(1);
    expect(resend[0].body).toContain('owner@activepaw.co.uk');
    expect(resend[0].body).toContain('2.00'); // the cleared total
  });

  it('is a no-op on any day other than the 1st', async () => {
    await seedShopWithClearedCommission();
    const sink = { calls: [] as { url: string; body: string }[] };
    await maybeAffiliatePayoutReminder(ENV, midMonth, captureFetch(sink));
    expect(sink.calls).toHaveLength(0);
  });

  it('is a no-op on the 1st when nothing has cleared yet', async () => {
    const s = await seedShopWithClearedCommission();
    // Replace the cleared order with one still MATURING at the reminder instant
    // (5 days before firstOfMonth, not before real now - clearance is judged
    // against the reminder's own `now`).
    const maturingAtReminder = new Date(firstOfMonth - 5 * 86400000).toISOString();
    await s.upsertAffiliateOrder({ shopifyOrderId: 'c1', voucherId: (await s.listAffiliateVouchers())[0].voucher_id, orderName: '#C1', grossGbp: 100, discountGbp: 5, commissionGbp: 2, financialStatus: 'PAID', eligible: true, placedAt: maturingAtReminder });
    const sink = { calls: [] as { url: string; body: string }[] };
    await maybeAffiliatePayoutReminder(ENV, firstOfMonth, captureFetch(sink));
    expect(sink.calls).toHaveLength(0);
  });

  it('never sends without a RESEND key', async () => {
    await seedShopWithClearedCommission();
    const sink = { calls: [] as { url: string; body: string }[] };
    await maybeAffiliatePayoutReminder({ DB: env.DB } as unknown as Env, firstOfMonth, captureFetch(sink));
    expect(sink.calls).toHaveLength(0);
  });
});
