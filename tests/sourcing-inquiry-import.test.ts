import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { startInquiryImport, inquiryImportStatus } from '../src/sourcing/inquiry-import';
import { inquiryDestination } from '../src/sourcing/destination';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
import type { CjClient, CjDetail } from '../src/cj';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const CFG = { pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, fulfil: DEFAULT_FULFIL } as unknown as TenantConfig;
const det = (pid: string, origins: Record<string, number>): CjDetail => ({ pid, nameEn: 'Smart GPS Pet Tracker', images: [], descriptionHtml: '', variants: [{ vid: 'v', name: 'x', sellPriceUsd: 12, sku: 's' }], listedNum: 1, categoryName: 'Pet', origins });

async function setup(details: CjDetail[], live: Record<string, Record<string, number> | 'error'> = {}) {
  const store = new TenantStore(env.DB, 'a.myshopify.com');
  await store.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket', transitMin: 5, transitMax: 9, agingRaw: '5-9', repVid: 'v', freightCostUsd: 4 });
  await store.upsertLogisticsRoute({ from: 'GB', to: 'GB', channel: 'UK Local', transitMin: 1, transitMax: 3, agingRaw: '1-3', repVid: 'v', freightCostUsd: 3 });
  const byPid = new Map(details.map((d) => [d.pid, d]));
  // originsByPid = what CJ reports NOW; defaults to the detail's own origins.
  const cj = {
    detail: async (pid: string) => byPid.get(pid) ?? null,
    originsByPid: async (pid: string) => {
      const l = live[pid];
      if (l === 'error') throw new Error('CJ 500');
      return l ?? byPid.get(pid)?.origins ?? {};
    },
  } as unknown as CjClient;
  const imports: { pid: string; localWarehouses: string[] }[] = [];
  const pending: Promise<unknown>[] = [];
  let runImport = async (d: CjDetail, localWarehouses: string[]) => { imports.push({ pid: d.pid, localWarehouses }); };
  const deps = {
    store, cj, cfg: CFG,
    runImport: (d: CjDetail, lw: string[]) => runImport(d, lw),
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
  };
  return { store, deps, imports, pending, setRunImport: (f: typeof runImport) => { runImport = f; } };
}

describe('startInquiryImport', () => {
  it('imports a China-only item with the lane plus CN', async () => {
    const t = await setup([det('T1', { CN: 5429 })]);
    expect(await startInquiryImport(t.deps, 'T1', 'GB')).toEqual({ ok: true, state: 'importing', handle: null });
    await Promise.all(t.pending);
    expect(t.imports).toEqual([{ pid: 'T1', localWarehouses: ['GB', 'CN'] }]);
    expect((await t.store.getLink('T1'))?.state).toBe('importing');
  });

  it('imports a locally stocked item on the lane alone', async () => {
    const t = await setup([det('C1', { GB: 40, CN: 900 })]);
    await startInquiryImport(t.deps, 'C1', 'GB');
    await Promise.all(t.pending);
    expect(t.imports[0].localWarehouses).toEqual(['GB']);
  });

  it('refuses when no route reaches the buyer, without touching the link', async () => {
    const t = await setup([det('T1', { CN: 5429 })]);
    expect(await startInquiryImport(t.deps, 'T1', 'AU')).toEqual({ ok: false, error: 'not_deliverable' });
    expect(t.imports).toEqual([]);
    expect(await t.store.getLink('T1')).toBeNull();
  });

  it('refuses stock below the floor', async () => {
    const t = await setup([det('T2', { CN: 3 })]);
    expect(await startInquiryImport(t.deps, 'T2', 'GB')).toEqual({ ok: false, error: 'no_stock' });
  });

  it('judges stock on CJ live origins and hands those to the import, not the cached ones', async () => {
    const stale = await setup([det('T1', { CN: 5429 })], { T1: { CN: 0 } });
    expect(await startInquiryImport(stale.deps, 'T1', 'GB')).toEqual({ ok: false, error: 'not_deliverable' });
    const fresh = await setup([det('T1', { CN: 20 })], { T1: { CN: 700 } });
    const seen: Record<string, number>[] = [];
    fresh.setRunImport(async (d) => { seen.push(d.origins ?? {}); });
    await startInquiryImport(fresh.deps, 'T1', 'GB');
    await Promise.all(fresh.pending);
    expect(seen).toEqual([{ CN: 700 }]);
  });

  it('refuses when CJ cannot report live stock', async () => {
    const t = await setup([det('T1', { CN: 5429 })], { T1: 'error' });
    expect(await startInquiryImport(t.deps, 'T1', 'GB')).toEqual({ ok: false, error: 'stock_unknown' });
  });

  it('refuses an unknown product', async () => {
    const t = await setup([]);
    expect(await startInquiryImport(t.deps, 'NOPE', 'GB')).toEqual({ ok: false, error: 'unknown_product' });
  });

  it('returns the handle of an item already imported, without importing again', async () => {
    const t = await setup([det('T1', { CN: 5429 })]);
    await t.store.putLink({ cjPid: 'T1', state: 'imported', handle: 'smart-gps-pet-tracker' });
    expect(await startInquiryImport(t.deps, 'T1', 'GB')).toEqual({ ok: true, state: 'imported', handle: 'smart-gps-pet-tracker' });
    expect(t.imports).toEqual([]);
  });

  it('marks the link failed when the import throws, so the next click can retry', async () => {
    const t = await setup([det('T1', { CN: 5429 })]);
    t.setRunImport(async () => { throw new Error('Shopify timeout'); });
    await startInquiryImport(t.deps, 'T1', 'GB');
    await Promise.all(t.pending);
    const s = await inquiryImportStatus(t.store, 'T1');
    expect(s).toMatchObject({ ok: true, state: 'failed', failReason: 'import-error' });
    expect(s.failDetail).toContain('Shopify timeout');
  });
});

describe('inquiryDestination', () => {
  it('reads the country from the inbound messages, ignoring our quoted footer', async () => {
    const store = new TenantStore(env.DB, 'a.myshopify.com');
    const tid = await store.createThread({ contactEmail: 'aloha@example.com', subject: 'Collar', subjectNorm: 'collar', receivedAt: '2026-09-29T10:00:00Z', initialStatus: 'new' });
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<a@x>', inReplyTo: null, references: [], from: 'aloha@example.com', to: 'contact@activepaw.co.uk', subject: 'Collar', bodyText: 'Do you sell a trackable dog collar? I live in Texas.', bodyHtml: null, headersJson: '{}', receivedAt: '2026-09-29T10:00:00Z' });
    expect(await inquiryDestination(store, tid)).toBe('US');
  });
  it('is null for an unknown thread', async () => {
    expect(await inquiryDestination(new TenantStore(env.DB, 'a.myshopify.com'), 'missing')).toBeNull();
  });
});
