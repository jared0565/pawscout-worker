/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore, AFFILIATE_SCREEN_LLM_TASK, AFFILIATE_STAGE_APPROVED } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const store = () => new TenantStore(env.DB, SHOP);

describe('affiliate self-serve store layer (migration 0032)', () => {
  it('applies the migration and creates the new tables/columns/index', async () => {
    // affiliate_applications + affiliate_tokens exist and are queryable.
    await expect(env.DB.prepare(`SELECT * FROM affiliate_applications WHERE shop = ?1`).bind(SHOP).all()).resolves.toBeTruthy();
    await expect(env.DB.prepare(`SELECT * FROM affiliate_tokens WHERE shop = ?1`).bind(SHOP).all()).resolves.toBeTruthy();
    // affiliate_orders gained the new columns.
    const cols = await env.DB.prepare(`PRAGMA table_info(affiliate_orders)`).all<{ name: string }>();
    const names = (cols.results ?? []).map((c) => c.name);
    expect(names).toContain('buyer_email_hash');
    expect(names).toContain('self_referral');
  });

  describe('claimToken', () => {
    it('is single-use: the second claim of the same hash returns null', async () => {
      const s = store();
      await s.insertToken({ tokenHash: 'h-abc', kind: 'verify', subjectId: 'app-1', expiresAt: '2099-01-01T00:00:00.000Z' });
      const first = await s.claimToken('h-abc', 'verify');
      expect(first).toBe('app-1');
      const second = await s.claimToken('h-abc', 'verify');
      expect(second).toBeNull();
    });

    it('rejects an expired token', async () => {
      const s = store();
      await s.insertToken({ tokenHash: 'h-old', kind: 'verify', subjectId: 'app-2', expiresAt: '2020-01-01T00:00:00.000Z' });
      expect(await s.claimToken('h-old', 'verify')).toBeNull();
    });

    it('rejects a claim with the wrong kind', async () => {
      const s = store();
      await s.insertToken({ tokenHash: 'h-kind', kind: 'verify', subjectId: 'app-3', expiresAt: '2099-01-01T00:00:00.000Z' });
      expect(await s.claimToken('h-kind', 'login')).toBeNull();
      // the correct kind still claims it (proves the wrong-kind attempt above never consumed it)
      expect(await s.claimToken('h-kind', 'verify')).toBe('app-3');
    });

    it('returns null for an unknown token hash', async () => {
      const s = store();
      expect(await s.claimToken('never-issued', 'verify')).toBeNull();
    });
  });

  describe('applications: insert/get/update/lookup round-trip', () => {
    it('insertApplication + getApplication + updateApplicationStage + applicationByEmail', async () => {
      const s = store();
      const id = await s.insertApplication({
        email: 'Jane@Example.com', name: 'Jane', channelUrl: 'https://example.com/blog',
        answersJson: JSON.stringify({ q1: 'a1' }), stage: 'submitted', ipHash: 'ip-1',
      });
      expect(id).toBeTruthy();

      let row = await s.getApplication(id);
      expect(row?.email).toBe('jane@example.com'); // normalized lowercase
      expect(row?.stage).toBe('submitted');
      expect(row?.score).toBeNull();

      await s.updateApplicationStage(id, 'judging', { score: 9, factsJson: '{"f":1}', flagsJson: '[]' });
      row = await s.getApplication(id);
      expect(row?.stage).toBe('judging');
      expect(row?.score).toBe(9);
      expect(row?.facts_json).toBe('{"f":1}');

      const byEmail = await s.applicationByEmail('JANE@example.com');
      expect(byEmail?.id).toBe(id);

      expect(await s.getApplication('nope')).toBeNull();
      expect(await s.applicationByEmail('nobody@nowhere.com')).toBeNull();
    });

    it('applicationByEmail returns the most recently updated application for that email', async () => {
      const s = store();
      const id1 = await s.insertApplication({ email: 'bob@x.com', stage: 'submitted' });
      await new Promise((r) => setTimeout(r, 2));
      const id2 = await s.insertApplication({ email: 'bob@x.com', stage: 'submitted' });
      await s.updateApplicationStage(id2, 'judging');
      const latest = await s.applicationByEmail('bob@x.com');
      expect(latest?.id).toBe(id2);
      expect(id1).not.toBe(id2);
    });

    it('listApplicationsByStage and listApplicationsForConsole', async () => {
      const s = store();
      const a = await s.insertApplication({ email: 'a@x.com', stage: 'submitted' });
      const b = await s.insertApplication({ email: 'b@x.com', stage: 'submitted' });
      await s.updateApplicationStage(b, AFFILIATE_STAGE_APPROVED);

      const submitted = await s.listApplicationsByStage('submitted');
      expect(submitted.map((r) => r.id)).toEqual([a]);

      const issued = await s.listApplicationsByStage(AFFILIATE_STAGE_APPROVED);
      expect(issued.map((r) => r.id)).toEqual([b]);

      const all = await s.listApplicationsForConsole();
      expect(all.length).toBe(2);
    });
  });

  describe('channelUrlRegistered', () => {
    it('detects a registered host from an application channel_url', async () => {
      const s = store();
      expect(await s.channelUrlRegistered('example.com')).toBe(false);
      await s.insertApplication({ email: 'c@x.com', channelUrl: 'https://example.com/my-blog', stage: 'submitted' });
      expect(await s.channelUrlRegistered('example.com')).toBe(true);
      expect(await s.channelUrlRegistered('totally-different.com')).toBe(false);
    });

    it('detects a registered host from a live affiliate_partners channel_url', async () => {
      const s = store();
      await s.upsertAffiliatePartner({ contactEmail: 'partner@x.com', channelUrl: 'https://petsite.co.uk/reviews' });
      expect(await s.channelUrlRegistered('petsite.co.uk')).toBe(true);
    });
  });

  describe('daily counters', () => {
    const DAY_START = '2026-07-12T00:00:00.000Z';

    it('countApplicationsToday counts since a cutoff, optionally scoped by ipHash or emailDomain', async () => {
      const s = store();
      await s.insertApplication({ email: 'x1@foo.com', stage: 'submitted', ipHash: 'ip-9' });
      await s.insertApplication({ email: 'x2@foo.com', stage: 'submitted', ipHash: 'ip-9' });
      await s.insertApplication({ email: 'x3@bar.com', stage: 'submitted', ipHash: 'ip-other' });

      expect(await s.countApplicationsToday(DAY_START)).toBe(3);
      expect(await s.countApplicationsToday(DAY_START, { ipHash: 'ip-9' })).toBe(2);
      expect(await s.countApplicationsToday(DAY_START, { emailDomain: 'foo.com' })).toBe(2);
      expect(await s.countApplicationsToday(DAY_START, { emailDomain: 'bar.com' })).toBe(1);
      // a cutoff in the future sees nothing
      expect(await s.countApplicationsToday('2099-01-01T00:00:00.000Z')).toBe(0);
    });

    it('countAutoIssuedToday counts only approved-stage (issued) applications since a cutoff', async () => {
      const s = store();
      const a = await s.insertApplication({ email: 'y1@foo.com', stage: 'submitted' });
      const b = await s.insertApplication({ email: 'y2@foo.com', stage: 'submitted' });
      await s.insertApplication({ email: 'y3@foo.com', stage: 'declined' });
      await s.updateApplicationStage(a, AFFILIATE_STAGE_APPROVED);
      await s.updateApplicationStage(b, AFFILIATE_STAGE_APPROVED);

      expect(await s.countAutoIssuedToday(DAY_START)).toBe(2);
      expect(await s.countAutoIssuedToday('2099-01-01T00:00:00.000Z')).toBe(0);
    });

    it('sumScreenSpendTodayGbp sums llm_usage cost for the screening task, converted by the given fx rate', async () => {
      const s = store();
      await s.logLlmUsage(AFFILIATE_SCREEN_LLM_TASK, 'gpt-5.4-mini', 100, 50, 1.0);
      await s.logLlmUsage(AFFILIATE_SCREEN_LLM_TASK, 'gpt-5.4-mini', 100, 50, 0.5);
      await s.logLlmUsage('some-other-task', 'gpt-5.4-mini', 100, 50, 10.0); // must be excluded

      const gbp = await s.sumScreenSpendTodayGbp(DAY_START, 0.8);
      expect(gbp).toBeCloseTo(1.2, 5); // (1.0 + 0.5) * 0.8
      expect(await s.sumScreenSpendTodayGbp('2099-01-01T00:00:00.000Z', 0.8)).toBe(0);
    });
  });

  describe('GDPR: redactContact', () => {
    it('removes an application by email and nulls the matching buyer hash on affiliate_orders', async () => {
      const s = store();
      await s.insertApplication({ email: 'gdpr@x.com', stage: 'submitted' });
      // seed a partner + voucher + order carrying a buyer_email_hash (population is a later
      // task's job; seeded here directly to exercise the redaction path).
      const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'partner-g@x.com' });
      const voucherId = await s.createAffiliateVoucher({ partnerId, code: 'GDPR10', pctOff: 10, commissionPct: 5, endsAt: '2099-01-01T00:00:00.000Z' });
      await s.upsertAffiliateOrder({
        shopifyOrderId: 'ord-1', voucherId, orderName: '#1', grossGbp: 10, discountGbp: 1, commissionGbp: 0.5,
        financialStatus: 'paid', eligible: true, placedAt: '2026-07-01T00:00:00.000Z',
      });
      await env.DB.prepare(`UPDATE affiliate_orders SET buyer_email_hash = ?1 WHERE shop = ?2 AND shopify_order_id = 'ord-1'`)
        .bind('hash-of-gdpr', SHOP).run();

      expect(await s.applicationByEmail('gdpr@x.com')).not.toBeNull();

      const removed = await s.redactContact('gdpr@x.com', 'hash-of-gdpr');
      expect(removed).toBeGreaterThan(0);

      expect(await s.applicationByEmail('gdpr@x.com')).toBeNull();
      const order = await env.DB.prepare(`SELECT buyer_email_hash FROM affiliate_orders WHERE shop = ?1 AND shopify_order_id = 'ord-1'`)
        .bind(SHOP).first<{ buyer_email_hash: string | null }>();
      expect(order?.buyer_email_hash).toBeNull();
    });

    it('without an emailHash, still purges the application but leaves buyer_email_hash untouched (no-op on orders)', async () => {
      const s = store();
      await s.insertApplication({ email: 'nohash@x.com', stage: 'submitted' });
      const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'partner-h@x.com' });
      const voucherId = await s.createAffiliateVoucher({ partnerId, code: 'NOHASH10', pctOff: 10, commissionPct: 5, endsAt: '2099-01-01T00:00:00.000Z' });
      await s.upsertAffiliateOrder({
        shopifyOrderId: 'ord-2', voucherId, orderName: '#2', grossGbp: 10, discountGbp: 1, commissionGbp: 0.5,
        financialStatus: 'paid', eligible: true, placedAt: '2026-07-01T00:00:00.000Z',
      });
      await env.DB.prepare(`UPDATE affiliate_orders SET buyer_email_hash = ?1 WHERE shop = ?2 AND shopify_order_id = 'ord-2'`)
        .bind('hash-untouched', SHOP).run();

      await s.redactContact('nohash@x.com');
      expect(await s.applicationByEmail('nohash@x.com')).toBeNull();
      const order = await env.DB.prepare(`SELECT buyer_email_hash FROM affiliate_orders WHERE shop = ?1 AND shopify_order_id = 'ord-2'`)
        .bind(SHOP).first<{ buyer_email_hash: string | null }>();
      expect(order?.buyer_email_hash).toBe('hash-untouched');
    });

    it('does not touch another shop\'s application', async () => {
      const s = store();
      const other = new TenantStore(env.DB, 'b.myshopify.com');
      await s.insertApplication({ email: 'shared@x.com', stage: 'submitted' });
      await other.insertApplication({ email: 'shared@x.com', stage: 'submitted' });
      await s.redactContact('shared@x.com');
      expect(await s.applicationByEmail('shared@x.com')).toBeNull();
      expect(await other.applicationByEmail('shared@x.com')).not.toBeNull();
    });
  });

  describe('GDPR: redactShop', () => {
    it('clears affiliate_applications and affiliate_tokens for the shop', async () => {
      const s = store();
      await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
      await s.insertApplication({ email: 'shop-redact@x.com', stage: 'submitted' });
      await s.insertToken({ tokenHash: 'h-shop', kind: 'verify', subjectId: 'whatever', expiresAt: '2099-01-01T00:00:00.000Z' });

      await s.redactShop();

      const apps = await env.DB.prepare(`SELECT * FROM affiliate_applications WHERE shop = ?1`).bind(SHOP).all();
      expect(apps.results ?? []).toHaveLength(0);
      const tokens = await env.DB.prepare(`SELECT * FROM affiliate_tokens WHERE shop = ?1`).bind(SHOP).all();
      expect(tokens.results ?? []).toHaveLength(0);
    });
  });

  describe('UNIQUE partner-email index', () => {
    it('rejects a duplicate (shop, contact_email) insert straight against affiliate_partners', async () => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO affiliate_partners (shop, id, contact_email, name, channel_url, status, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, NULL, 'active', NULL, ?4, ?4)`
      ).bind(SHOP, 'p-1', 'dupe@x.com', now).run();

      await expect(
        env.DB.prepare(
          `INSERT INTO affiliate_partners (shop, id, contact_email, name, channel_url, status, notes, created_at, updated_at)
           VALUES (?1, ?2, ?3, NULL, NULL, 'active', NULL, ?4, ?4)`
        ).bind(SHOP, 'p-2', 'dupe@x.com', now).run()
      ).rejects.toThrow();
    });
  });
});
