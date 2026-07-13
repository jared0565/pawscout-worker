/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import {
  TenantStore, AFFILIATE_SCREEN_LLM_TASK, AFFILIATE_STAGE_APPROVED, AFFILIATE_STAGE_DECLINED, AFFILIATE_STAGE_OWNER_QUEUE,
  AFFILIATE_STAGE_SUBMITTED, AFFILIATE_STAGE_VERIFIED, AFFILIATE_STAGE_JUDGING
} from '../src/tenant-store';
import {
  DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX,
  DEFAULT_SELF_SERVE, type TenantConfig
} from '../src/types';

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

    it('listApplicationsForConsole never evicts an actionable row behind >100 more-recently-updated terminal rows', async () => {
      const s = store();
      // Seed via raw INSERTs (batched, not the store API) so updated_at is
      // explicit and strictly increasing - insertApplication only stamps
      // "now", which can't guarantee the owner_queue row sorts oldest when
      // called in a tight loop. The owner_queue row is planted first, with
      // an updated_at strictly older than every terminal row that follows;
      // under the old `ORDER BY updated_at DESC LIMIT 100` it would rank
      // 106th and fall off the list entirely.
      const ownerQueueId = crypto.randomUUID();
      const baseMs = Date.parse('2026-01-01T00:00:00.000Z');
      const stmts = [
        env.DB.prepare(
          `INSERT INTO affiliate_applications (shop, id, email, name, channel_url, answers_json, stage, score, facts_json, flags_json, ip_hash, created_at, updated_at)
           VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, NULL, NULL, NULL, NULL, ?5, ?5)`
        ).bind(SHOP, ownerQueueId, 'stuck@x.com', AFFILIATE_STAGE_OWNER_QUEUE, new Date(baseMs).toISOString())
      ];
      for (let i = 0; i < 105; i++) {
        const ts = new Date(baseMs + 1000 + i * 1000).toISOString(); // strictly newer than the owner_queue row
        stmts.push(
          env.DB.prepare(
            `INSERT INTO affiliate_applications (shop, id, email, name, channel_url, answers_json, stage, score, facts_json, flags_json, ip_hash, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, NULL, NULL, NULL, NULL, ?5, ?5)`
          ).bind(SHOP, crypto.randomUUID(), `terminal${i}@x.com`, i % 2 === 0 ? AFFILIATE_STAGE_APPROVED : AFFILIATE_STAGE_DECLINED, ts)
        );
      }
      await env.DB.batch(stmts);

      const all = await s.listApplicationsForConsole(); // default limit 100
      expect(all.length).toBe(100);
      expect(all.map((r) => r.id)).toContain(ownerQueueId);
      // The owner_queue row is the sole priority-0 row, so it sorts first.
      expect(all[0].id).toBe(ownerQueueId);
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

    // Fix 7 (2026-07-13 final review): redactShop purged the NEW self-serve
    // tables (affiliate_applications/affiliate_tokens, above) but missed the
    // five PRE-EXISTING affiliate tables (migrations 0015/0019/0024) - a
    // shop/redact request left every partner, voucher, order (including
    // buyer_email_hash), payout, and inbox-partnership-applicant record
    // behind. Seed one row in each of the five and confirm all are gone.
    it('also clears affiliate_partners, affiliate_vouchers, affiliate_orders, affiliate_payouts, and affiliate_applicants', async () => {
      const s = store();
      await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
      const partnerId = await s.upsertAffiliatePartner({ contactEmail: 'redact-all@x.com', name: 'Redact Me' });
      const voucherId = await s.createAffiliateVoucher({
        partnerId, code: 'ACTIVEPAW-REDACT5', pctOff: 5, commissionPct: 2,
        endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), usageLimit: 15
      });
      await s.upsertAffiliateOrder({
        shopifyOrderId: 'gid://shopify/Order/1', voucherId, orderName: '#1001', grossGbp: 50, discountGbp: 2.5,
        commissionGbp: 1, financialStatus: 'paid', eligible: true, placedAt: new Date().toISOString(), buyerEmailHash: 'hash-redact-all'
      });
      const payout = await s.createAffiliatePayout(voucherId);
      expect(payout).not.toBeNull(); // sanity: the payout row genuinely exists before redaction
      await s.upsertApplicant({ threadId: 'thread-redact-all', contactEmail: 'redact-all@x.com', stage: 'screen_sent' });

      const tables = ['affiliate_partners', 'affiliate_vouchers', 'affiliate_orders', 'affiliate_payouts', 'affiliate_applicants'];
      for (const t of tables) {
        const before = await env.DB.prepare(`SELECT * FROM ${t} WHERE shop = ?1`).bind(SHOP).all();
        expect((before.results ?? []).length, `${t} should be seeded before redaction`).toBeGreaterThan(0);
      }

      await s.redactShop();

      for (const t of tables) {
        const after = await env.DB.prepare(`SELECT * FROM ${t} WHERE shop = ?1`).bind(SHOP).all();
        expect((after.results ?? []), `${t} should be empty after redactShop`).toHaveLength(0);
      }
    });
  });

  describe('advanceApplicationStage (CAS - Fix 1 / Fix 3)', () => {
    it('advances when the row IS at fromStage, and COALESCEs the optional fields', async () => {
      const s = store();
      const id = await s.insertApplication({ email: 'cas-ok@x.com', stage: AFFILIATE_STAGE_SUBMITTED });
      const changed = await s.advanceApplicationStage(id, AFFILIATE_STAGE_SUBMITTED, AFFILIATE_STAGE_VERIFIED, { score: 7 });
      expect(changed).toBe(true);
      const row = await s.getApplication(id);
      expect(row?.stage).toBe(AFFILIATE_STAGE_VERIFIED);
      expect(row?.score).toBe(7);
    });

    it('is a no-op (returns false, changes nothing) when the row is NOT at fromStage', async () => {
      const s = store();
      const id = await s.insertApplication({ email: 'cas-noop@x.com', stage: AFFILIATE_STAGE_APPROVED, score: 11 });
      const changed = await s.advanceApplicationStage(id, AFFILIATE_STAGE_SUBMITTED, AFFILIATE_STAGE_VERIFIED, { score: 1 });
      expect(changed).toBe(false);
      const row = await s.getApplication(id);
      expect(row?.stage).toBe(AFFILIATE_STAGE_APPROVED); // unchanged - never demoted
      expect(row?.score).toBe(11); // unchanged - the (would-be) new score was never written
    });
  });

  describe('reclaimStaleJudging (Fix 3 - isolate-death recovery)', () => {
    it('resets a judging row older than the cutoff back to verified, and returns the count reset', async () => {
      const s = store();
      const staleId = await s.insertApplication({ email: 'stale-judging@x.com', stage: AFFILIATE_STAGE_JUDGING });
      const oldTs = '2020-01-01T00:00:00.000Z';
      await env.DB.prepare(`UPDATE affiliate_applications SET updated_at = ?3 WHERE shop = ?1 AND id = ?2`)
        .bind(SHOP, staleId, oldTs).run();

      const n = await s.reclaimStaleJudging(new Date(Date.now() - 60_000).toISOString());
      expect(n).toBe(1);
      const row = await s.getApplication(staleId);
      expect(row?.stage).toBe(AFFILIATE_STAGE_VERIFIED);
    });

    it('leaves a FRESH judging row (updated_at after the cutoff) untouched', async () => {
      const s = store();
      const freshId = await s.insertApplication({ email: 'fresh-judging@x.com', stage: AFFILIATE_STAGE_JUDGING });
      const n = await s.reclaimStaleJudging(new Date(Date.now() - 60_000).toISOString());
      expect(n).toBe(0);
      const row = await s.getApplication(freshId);
      expect(row?.stage).toBe(AFFILIATE_STAGE_JUDGING);
    });

    it('never touches a row at any OTHER stage', async () => {
      const s = store();
      const id = await s.insertApplication({ email: 'not-judging@x.com', stage: AFFILIATE_STAGE_VERIFIED });
      await env.DB.prepare(`UPDATE affiliate_applications SET updated_at = ?3 WHERE shop = ?1 AND id = ?2`)
        .bind(SHOP, id, '2020-01-01T00:00:00.000Z').run();
      const n = await s.reclaimStaleJudging(new Date().toISOString());
      expect(n).toBe(0);
      expect((await s.getApplication(id))?.stage).toBe(AFFILIATE_STAGE_VERIFIED);
    });
  });

  describe('recentUnclaimedToken (Fix 4 - portal login cooldown)', () => {
    it('finds an unexpired, unclaimed token of the right kind+subject issued since the cutoff', async () => {
      const s = store();
      await s.insertToken({ tokenHash: 'h-recent', kind: 'login', subjectId: 'partner-1', expiresAt: '2099-01-01T00:00:00.000Z' });
      const sinceIso = new Date(Date.now() - 5 * 60_000).toISOString();
      expect(await s.recentUnclaimedToken('partner-1', 'login', sinceIso)).toBe(true);
    });

    it('ignores a CLAIMED token even if recently issued', async () => {
      const s = store();
      await s.insertToken({ tokenHash: 'h-claimed', kind: 'login', subjectId: 'partner-2', expiresAt: '2099-01-01T00:00:00.000Z' });
      await s.claimToken('h-claimed', 'login');
      const sinceIso = new Date(Date.now() - 5 * 60_000).toISOString();
      expect(await s.recentUnclaimedToken('partner-2', 'login', sinceIso)).toBe(false);
    });

    it('ignores a token of the wrong kind or subject', async () => {
      const s = store();
      await s.insertToken({ tokenHash: 'h-wrongkind', kind: 'verify', subjectId: 'partner-3', expiresAt: '2099-01-01T00:00:00.000Z' });
      const sinceIso = new Date(Date.now() - 5 * 60_000).toISOString();
      expect(await s.recentUnclaimedToken('partner-3', 'login', sinceIso)).toBe(false);
      expect(await s.recentUnclaimedToken('someone-else', 'verify', sinceIso)).toBe(false);
    });

    it('ignores a token issued before the cutoff', async () => {
      const s = store();
      await s.insertToken({ tokenHash: 'h-old-issue', kind: 'login', subjectId: 'partner-4', expiresAt: '2099-01-01T00:00:00.000Z' });
      const futureSinceIso = new Date(Date.now() + 60_000).toISOString(); // "since" a moment in the future
      expect(await s.recentUnclaimedToken('partner-4', 'login', futureSinceIso)).toBe(false);
    });
  });

  describe('selfServe config persistence (Task 6: migration 0033 + saveSelfServe)', () => {
    const BASE: TenantConfig = {
      collectionMap: {}, gates: { popularityFloor: 1, priceMin: 5, priceMax: 80, relevance: 'title' },
      pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS,
      fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
    };

    it('getConfig merges in DEFAULT_SELF_SERVE when no selfserve row has ever been saved', async () => {
      const s = store();
      await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
      await s.seedConfig(BASE);
      const cfg = await s.getConfig();
      expect(cfg?.selfServe).toEqual(DEFAULT_SELF_SERVE);
    });

    it('saveSelfServe persists a full round trip and overrides the default on the next getConfig', async () => {
      const s = store();
      await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
      await s.seedConfig(BASE);
      await s.saveSelfServe({ enabled: true, autoIssueCapPerDay: 9, screenSpendCapGbpPerDay: 3.5, scoreThreshold: 6, starterUsageLimit: 40 });
      const cfg = await s.getConfig();
      expect(cfg?.selfServe).toEqual({ enabled: true, autoIssueCapPerDay: 9, screenSpendCapGbpPerDay: 3.5, scoreThreshold: 6, starterUsageLimit: 40 });
    });

    it('saveSelfServe is scoped to its own shop', async () => {
      const a = store();
      const b = new TenantStore(env.DB, 'b.myshopify.com');
      await a.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
      await b.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
      await a.seedConfig(BASE);
      await b.seedConfig(BASE);
      await a.saveSelfServe({ enabled: true, autoIssueCapPerDay: 1, screenSpendCapGbpPerDay: 1, scoreThreshold: 1, starterUsageLimit: 1 });
      const cfgB = await b.getConfig();
      expect(cfgB?.selfServe).toEqual(DEFAULT_SELF_SERVE);
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
