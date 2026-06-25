import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const good = { from: 'CN', to: 'GB', channel: 'CJPacket Ordinary', transitMin: 4, transitMax: 9, agingRaw: '4-9', repVid: 'v1' };

describe('cj_logistics accessors', () => {
  it('upsert then fresh read returns the parsed route', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute(good);
    const r = await s.getLogisticsRoute('CN', 'GB', 72);
    expect(r).not.toBeNull();
    expect(r!.transit_min).toBe(4);
    expect(r!.transit_max).toBe(9);
    expect(r!.channel).toBe('CJPacket Ordinary');
    expect(r!.from_country).toBe('CN');
    expect(r!.to_country).toBe('GB');
  });

  it('a stale row (older than stalenessHours) reads as null (== hedge)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute(good);
    // ask "now" 100h in the future vs a 72h staleness window
    const future = Date.now() + 100 * 3600_000;
    expect(await s.getLogisticsRoute('CN', 'GB', 72, future)).toBeNull();
    // still fresh within a wider window
    expect(await s.getLogisticsRoute('CN', 'GB', 200, future)).not.toBeNull();
  });

  it('a row with NULL transit reads as null', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute({ ...good, transitMin: null, transitMax: null, agingRaw: 'soon' });
    expect(await s.getLogisticsRoute('CN', 'GB', 72)).toBeNull();
  });

  it('a missing route reads as null', async () => {
    const s = new TenantStore(env.DB, SHOP);
    expect(await s.getLogisticsRoute('CN', 'FR', 72)).toBeNull();
  });

  it('routes are shop-scoped (no cross-tenant leakage)', async () => {
    await new TenantStore(env.DB, SHOP).upsertLogisticsRoute(good);
    expect(await new TenantStore(env.DB, 'b.myshopify.com').getLogisticsRoute('CN', 'GB', 72)).toBeNull();
  });

  it('bumpLogisticsFailure keeps the last-good row readable and increments the counter', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute(good);
    await s.bumpLogisticsFailure('CN', 'GB', 'CJ timeout');
    // last-good still served
    expect((await s.getLogisticsRoute('CN', 'GB', 72))!.transit_min).toBe(4);
    const raw = await env.DB.prepare(`SELECT consecutive_failures, last_error FROM cj_logistics WHERE shop=?1 AND from_country='CN' AND to_country='GB'`).bind(SHOP).first<{ consecutive_failures: number; last_error: string }>();
    expect(raw!.consecutive_failures).toBe(1);
    expect(raw!.last_error).toContain('timeout');
    // a successful re-upsert resets the counter
    await s.upsertLogisticsRoute(good);
    const reset = await env.DB.prepare(`SELECT consecutive_failures FROM cj_logistics WHERE shop=?1 AND from_country='CN' AND to_country='GB'`).bind(SHOP).first<{ consecutive_failures: number }>();
    expect(reset!.consecutive_failures).toBe(0);
  });

  it('prune drops out-of-scope destinations, keeps the in-scope ones', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute(good);
    await s.upsertLogisticsRoute({ ...good, to: 'FR' });
    await s.upsertLogisticsRoute({ ...good, to: 'US' });
    await s.pruneLogisticsRoutes('CN', ['GB', 'FR']);
    expect(await s.getLogisticsRoute('CN', 'GB', 72)).not.toBeNull();
    expect(await s.getLogisticsRoute('CN', 'FR', 72)).not.toBeNull();
    expect(await s.getLogisticsRoute('CN', 'US', 72)).toBeNull();
  });

  it('prune with an empty keep-set is a no-op (never a full wipe)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute(good);
    await s.pruneLogisticsRoutes('CN', []);
    expect(await s.getLogisticsRoute('CN', 'GB', 72)).not.toBeNull();
  });

  it('persists and returns the CJ freight cost on a route', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute({ from: 'CN', to: 'US', channel: 'LuWei', transitMin: 5, transitMax: 11, agingRaw: '5-11', repVid: 'v1', freightCostUsd: 6.05 });
    const r = await s.getLogisticsRoute('CN', 'US', 72);
    expect(r?.freight_cost_usd).toBe(6.05);
  });

  it('a route synced without a freight cost reads back null (no cost claim)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute(good); // no freightCostUsd supplied
    const r = await s.getLogisticsRoute('CN', 'GB', 72);
    expect(r!.freight_cost_usd ?? null).toBeNull();
  });

  it('re-upserting a route with a new freight cost overwrites the old one', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute({ ...good, freightCostUsd: 6.05 });
    await s.upsertLogisticsRoute({ ...good, freightCostUsd: 7.20 });
    const r = await s.getLogisticsRoute('CN', 'GB', 72);
    expect(r!.freight_cost_usd).toBe(7.20);
  });
});
