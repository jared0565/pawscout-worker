/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { collectSystemStates, type SystemStatesReport } from '../src/system-states';
import { DEFAULT_INBOX, INBOX_LABELS } from '../src/inbox/types';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type Env } from '../src/types';
import { JOB_STAMP_DAILY } from '../src/jobs';
// Raw import resolved at build time (workerd has no fs): the doc that maps
// every state to its authoritative store, pinned to the registry below.
import statesDoc from '../docs/STATES.md?raw';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

async function seed(inboxOver: Record<string, unknown> = {}) {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 'read_products,write_products' });
  const inbox = { ...DEFAULT_INBOX, ...inboxOver };
  await s.seedConfig({
    collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox, target: 12
  });
  await s.saveInbox(inbox);
  return s;
}

const BARE_ENV = () => ({ ...env } as unknown as Env); // no RESEND/OPENROUTER keys

function flat(r: SystemStatesReport) {
  const out = new Map<string, { value: string; on: boolean | null; detail?: string; source: string }>();
  for (const g of r.groups) for (const st of g.states) out.set(st.key, st);
  return out;
}

describe('collectSystemStates', () => {
  it('reads every switch live from the enforcing stores (fresh tenant)', async () => {
    await seed();
    const r = await collectSystemStates(BARE_ENV(), new TenantStore(env.DB, SHOP));
    expect(r.ok).toBe(true);
    const states = flat(r as SystemStatesReport);
    // Reply master: HITL by default.
    expect(states.get('inbox.autosend')?.value).toBe('Manual (HITL)');
    expect(states.get('inbox.autosend')?.on).toBe(false);
    // One row per agent lane - the register is complete, not a sample.
    for (const l of INBOX_LABELS) expect(states.has(`inbox.agents.${l}.autosend`), l).toBe(true);
    // Partnership mode reflects config; auto-issue defaults off.
    expect(states.get('inbox.affiliateMode')?.value).toBe('funnel_voucher');
    expect(states.get('inbox.autoIssueVoucher')?.on).toBe(false);
    // Tracking: no key, no secret, no events → not on, and the detail says why.
    const tr = states.get('email.tracking')!;
    expect(tr.on).not.toBe(true);
    expect(tr.detail).toContain('webhook secret NOT stored');
    // Connections read presence, never values.
    expect(states.get('conn.shopify')?.on).toBe(true);
    expect(states.get('conn.shopify')?.detail).toContain('read_products');
    expect(states.get('conn.cj')?.on).toBe(false);
    expect(states.get('conn.resend')?.on).toBe(false);
    // Jobs that never ran say so honestly.
    expect(states.get('job.daily')?.value).toBe('never');
  });

  it('email tracking turns ON from evidence alone: sealed secret + stored events', async () => {
    const s = await seed();
    await s.putSupplierCredential('resend-webhook', 'sealed', 'resend-webhook');
    await s.insertEmailEvent({
      svixId: 'sv1', resendId: 're1', email: 'x@y.com', eventType: 'delivered',
      kind: 'campaign_test', campaignId: 'c1', threadId: null, link: null, occurredAt: '2026-07-06T02:51:00Z'
    });
    const r = await collectSystemStates(BARE_ENV(), new TenantStore(env.DB, SHOP));
    const tr = flat(r as SystemStatesReport).get('email.tracking')!;
    expect(tr.on).toBe(true);
    expect(tr.detail).toContain('1 events');
    expect(tr.detail).toContain('2026-07-06T02:51:00Z');
  });

  it('probes the Resend domain flags live when the key is present', async () => {
    const s = await seed();
    await s.putSupplierCredential('resend-webhook', 'sealed', 'resend-webhook');
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.endsWith('/domains')) return new Response(JSON.stringify({ data: [{ id: 'dom1', name: 'activepaw.co.uk' }] }), { status: 200 });
      if (u.includes('/domains/dom1')) return new Response(JSON.stringify({ open_tracking: true, click_tracking: true }), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await collectSystemStates({ ...env, RESEND_API_KEY: 'rk' } as unknown as Env, new TenantStore(env.DB, SHOP), fetchImpl);
    const tr = flat(r as SystemStatesReport).get('email.tracking')!;
    expect(tr.value).toBe('On');
    expect(tr.on).toBe(true);
    expect(tr.detail).toContain('domain open/click: on');
  });

  it('reflects owner changes immediately - the register is never a copy', async () => {
    const s = await seed({ autosend: true, agents: { affiliate: { autosend: true } }, autoIssueVoucher: true });
    await s.putSearchCache(JOB_STAMP_DAILY, '2026-07-06T05:30:00Z', 30);
    const r = await collectSystemStates(BARE_ENV(), new TenantStore(env.DB, SHOP));
    const states = flat(r as SystemStatesReport);
    expect(states.get('inbox.autosend')?.value).toBe('Automatic');
    expect(states.get('inbox.agents.affiliate.autosend')?.on).toBe(true);
    expect(states.get('inbox.agents.order-status.autosend')?.on).toBe(false);
    expect(states.get('inbox.autoIssueVoucher')?.on).toBe(true);
    expect(states.get('job.daily')?.value).toBe('2026-07-06T05:30:00Z');
  });

  it('every registry key is documented in docs/STATES.md (no undocumented switches)', async () => {
    await seed();
    const r = await collectSystemStates(BARE_ENV(), new TenantStore(env.DB, SHOP));
    for (const g of (r as SystemStatesReport).groups) {
      for (const st of g.states) {
        // Agent rows share one documented pattern line.
        const docKey = st.key.startsWith('inbox.agents.') ? 'inbox.agents.<label>.autosend' : st.key;
        expect(statesDoc, `state '${st.key}' missing from docs/STATES.md`).toContain('`' + docKey + '`');
      }
    }
  });
});
