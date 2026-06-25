import { describe, it, expect } from 'vitest';
import { deriveDestinationCountry } from '../../src/inbox/freight';
import { shippingAgent } from '../../src/inbox/agents/shipping';

describe('Texas fix', () => {
  it('resolves a US state name to US', () => {
    expect(deriveDestinationCountry('how long to Texas for your products', '', 'a@gmail.com')).toBe('US');
  });
  it('keeps the ambiguity guard (two destinations -> null)', () => {
    expect(deriveDestinationCountry('to Texas or France?', '', 'a@gmail.com')).toBeNull();
  });
});

describe('shippingAgent.ground', () => {
  const route = { from_country: 'CN', to_country: 'US', channel: 'c', transit_min: 5, transit_max: 11, aging_raw: '5-11', synced_at: new Date().toISOString() };
  const ctx = (msg: string, routeRet: any, cj: any = null) => ({
    store: { async getLogisticsRoute() { return routeRet; } },
    cfg: { fulfil: {} }, admin: null, cj,
    thread: { subject: '', contact_email: 'a@gmail.com' },
    conversation: msg, latestMessage: msg, contactEmail: 'a@gmail.com', customerName: null
  }) as any;

  it('grounds a delivery band and emits a time-only appendix that never names origin', async () => {
    const g = await shippingAgent.ground(ctx('how long to Texas?', route));
    expect(g.confident).toBe(true);
    const line = shippingAgent.deterministicAppendix(g)!;
    expect(line).toMatch(/estimated 7-23 days/);
    expect(line).not.toMatch(/China|CN|UK/);
  });
  it('hedges when no route (stale/missing -> null)', async () => {
    const g = await shippingAgent.ground(ctx('how long to Texas?', null));
    expect(g.confident).toBe(false);
    expect(shippingAgent.deterministicAppendix(g)).toBeNull();
  });
  it('is not shipping intent -> not confident', async () => {
    const g = await shippingAgent.ground(ctx('do you sell cat food?', route));
    expect(g.confident).toBe(false);
  });
  it('ground tolerates cj:null (no throw, falls back to matrix)', async () => {
    const g = await shippingAgent.ground(ctx('how long to Texas?', route, null));
    expect(g).toBeDefined(); // no throw; cj:null means matrix-only path
  });
});
