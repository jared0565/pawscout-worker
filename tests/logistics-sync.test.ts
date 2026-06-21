import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { syncCjLogisticsRoutes } from '../src/jobs';
import type { CjClient } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const noPause = async () => {};
type Opt = { priceUsd: number; days: string; name: string };
function fakeCj(handler: (to: string) => Opt[] | Error): Pick<CjClient, 'freightQuote'> {
  return { freightQuote: async (_vid: string, _from?: string, to?: string) => {
    const r = handler(to as string);
    if (r instanceof Error) throw r;
    return r;
  } } as Pick<CjClient, 'freightQuote'>;
}
const ok = (days = '4-9'): Opt[] => [{ priceUsd: 3, days, name: 'CJPacket Ordinary' }];

describe('syncCjLogisticsRoutes (fetch-once-fan-out)', () => {
  it('refreshes every destination and FANS OUT to all shops', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    const b = new TenantStore(env.DB, 'b.myshopify.com');
    const res = await syncCjLogisticsRoutes([a, b], a, fakeCj(() => ok()), 'vRep', ['GB', 'FR'], { pause: noPause });
    expect(res).toEqual({ refreshed: 2, failed: 0 });
    for (const s of [a, b]) {
      const gb = await s.getLogisticsRoute('CN', 'GB', 72);
      expect(gb!.transit_min).toBe(4); expect(gb!.transit_max).toBe(9);
      expect((await s.getLogisticsRoute('CN', 'FR', 72))).not.toBeNull();
    }
  });

  it('keeps the last-good row and bumps the counter when a route quote fails', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'old', transitMin: 4, transitMax: 9, agingRaw: '4-9', repVid: 'v0' });
    const cj = fakeCj((to) => (to === 'GB' ? new Error('CJ HTTP 500 — boom') : ok('5-10')));
    const res = await syncCjLogisticsRoutes([a], a, cj, 'vRep', ['GB', 'FR'], { pause: noPause });
    expect(res).toEqual({ refreshed: 1, failed: 1 });
    expect((await a.getLogisticsRoute('CN', 'GB', 72))!.transit_min).toBe(4); // last-good preserved
    const raw = await env.DB.prepare(`SELECT consecutive_failures FROM cj_logistics WHERE shop='a.myshopify.com' AND to_country='GB'`).first<{ consecutive_failures: number }>();
    expect(raw!.consecutive_failures).toBe(1);
    expect((await a.getLogisticsRoute('CN', 'FR', 72))!.transit_max).toBe(10);
  });

  it('treats unparseable aging as a failure (no row written)', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    const res = await syncCjLogisticsRoutes([a], a, fakeCj(() => ok('soon-ish')), 'vRep', ['GB'], { pause: noPause });
    expect(res).toEqual({ refreshed: 0, failed: 1 });
    expect(await a.getLogisticsRoute('CN', 'GB', 72)).toBeNull();
  });

  it('aborts after 3 consecutive 429s (relay IP is shared)', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    const cj = fakeCj(() => new Error('CJ HTTP 429 (CJ code 1600200)'));
    const res = await syncCjLogisticsRoutes([a], a, cj, 'vRep', ['GB', 'FR', 'DE', 'ES', 'IT'], { pause: noPause });
    expect(res.failed).toBe(3); // stops at the 3rd consecutive 429
    expect(await a.getLogisticsRoute('CN', 'ES', 72)).toBeNull(); // never reached
  });

  it('prunes destinations that fell out of scope', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.upsertLogisticsRoute({ from: 'CN', to: 'US', channel: 'old', transitMin: 6, transitMax: 12, agingRaw: '6-12', repVid: 'v0' });
    await syncCjLogisticsRoutes([a], a, fakeCj(() => ok()), 'vRep', ['GB'], { pause: noPause });
    expect(await a.getLogisticsRoute('CN', 'GB', 72)).not.toBeNull();
    expect(await a.getLogisticsRoute('CN', 'US', 72)).toBeNull(); // pruned (out of scope)
  });
});
