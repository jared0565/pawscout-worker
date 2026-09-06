import { describe, it, expect } from 'vitest';
import { alertOwner } from '../src/owner-alert';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig, type Env } from '../src/types';

// The one owner-email helper for operational alerts (extracted 2026-09-07 from
// the affiliate screen so the nightly event rotation can use it too). It
// respects the configured alert address and stays silent without a key.
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: { ...DEFAULT_INBOX, alertEmail: 'owner@example.com' }, target: 12 };

function capture() {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_u: unknown, init: RequestInit) => { sent.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe('alertOwner', () => {
  it('emails the configured alert address with the subject and text, from the support desk', async () => {
    const { sent, fetchImpl } = capture();
    await alertOwner({ RESEND_API_KEY: 'rk' } as unknown as Env, CFG, 'Event rotation needs attention', 'summersale: ACTIVE too early', fetchImpl);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['owner@example.com']);
    expect(sent[0].subject).toBe('Event rotation needs attention');
    expect(sent[0].text).toBe('summersale: ACTIVE too early');
    expect(sent[0].from).toBe('Active Paw <support@activepaw.co.uk>');
  });

  it('sends nothing without a Resend key or an alert address', async () => {
    const { sent, fetchImpl } = capture();
    await alertOwner({} as unknown as Env, CFG, 'x', 'y', fetchImpl);
    const noAddress: TenantConfig = { ...CFG, inbox: { ...CFG.inbox, alertEmail: undefined }, fulfil: { ...CFG.fulfil, alertEmail: undefined } };
    await alertOwner({ RESEND_API_KEY: 'rk' } as unknown as Env, noAddress, 'x', 'y', fetchImpl);
    expect(sent).toHaveLength(0);
  });
});
