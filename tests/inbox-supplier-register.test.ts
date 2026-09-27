/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { mergeSupplier, type SupplierFacts } from '../src/inbox/supplier-register';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

const facts = (over: Partial<SupplierFacts> = {}): SupplierFacts => ({
  company: 'Hebei Douke Pet Products', contactName: 'Sabrina Liu', website: null, storeLinks: [],
  kind: 'goods', productLines: ['tofu cat litter'], shipsFrom: 'CN', nicheFit: 'on-niche', dropship: 'unknown', ...over
});
const meta = { email: 'sales@doukecatlitter.com', threadId: 't1', seenAt: '2026-09-24T16:11:15Z', inboundCount: 1 };

describe('mergeSupplier', () => {
  it('creates a new row with status new and the first thread', () => {
    const r = mergeSupplier(null, facts(), meta);
    expect(r.status).toBe('new');
    expect(r.first_thread_id).toBe('t1');
    expect(r.first_seen_at).toBe('2026-09-24T16:11:15Z');
    expect(JSON.parse(r.product_lines)).toEqual(['tofu cat litter']);
    expect(r.dropship).toBe('unknown');
  });

  it('fills and extends, never blanks, and keeps the owner fields', () => {
    const first = { shop: SHOP, ...mergeSupplier(null, facts({ website: 'https://douke.example' }), meta), status: 'reviewed' as const, notes: 'call back' };
    const r = mergeSupplier(first, facts({ website: null, company: null, productLines: ['pine cat litter'], storeLinks: ['https://douke.en.alibaba.com'] }),
      { ...meta, threadId: 't2', seenAt: '2026-09-30T10:00:00Z', inboundCount: 3 });
    expect(r.website).toBe('https://douke.example');
    expect(r.company).toBe('Hebei Douke Pet Products');
    expect(JSON.parse(r.product_lines)).toEqual(['tofu cat litter', 'pine cat litter']);
    expect(JSON.parse(r.store_links)).toEqual(['https://douke.en.alibaba.com']);
    expect(r.first_thread_id).toBe('t1');
    expect(r.last_seen_at).toBe('2026-09-30T10:00:00Z');
    expect(r.message_count).toBe(3);
    expect(r.status).toBe('reviewed');
    expect(r.notes).toBe('call back');
  });

  it('a later unknown never overwrites a known dropshipping answer; a new answer replaces the old one', () => {
    const yes = { shop: SHOP, ...mergeSupplier(null, facts({ dropship: 'yes' }), meta) };
    expect(mergeSupplier(yes, facts({ dropship: 'unknown' }), meta).dropship).toBe('yes');
    expect(mergeSupplier(yes, facts({ dropship: 'no' }), meta).dropship).toBe('no');
  });

  it('never moves last_seen_at backwards (a back-fill of an older thread)', () => {
    const row = { shop: SHOP, ...mergeSupplier(null, facts(), { ...meta, seenAt: '2026-09-30T00:00:00Z' }) };
    const r = mergeSupplier(row, facts(), { ...meta, seenAt: '2026-09-01T00:00:00Z' });
    expect(r.last_seen_at).toBe('2026-09-30T00:00:00Z');
    expect(r.first_seen_at).toBe('2026-09-01T00:00:00Z');
  });

  it('first_thread_id follows first_seen_at, not which call happened first (a back-fill can precede it)', () => {
    const row = { shop: SHOP, ...mergeSupplier(null, facts(), { ...meta, threadId: 't1', seenAt: '2026-09-24T16:11:15Z' }) };
    const backfilled = mergeSupplier(row, facts(), { ...meta, threadId: 't0', seenAt: '2026-09-01T00:00:00Z' });
    expect(backfilled.first_thread_id).toBe('t0');
    expect(backfilled.first_seen_at).toBe('2026-09-01T00:00:00Z');
    const later = mergeSupplier({ shop: SHOP, ...backfilled }, facts(), { ...meta, threadId: 't2', seenAt: '2026-09-30T00:00:00Z' });
    expect(later.first_thread_id).toBe('t0');
  });
});

describe('TenantStore supplier register', () => {
  it('upserts, lists newest first, and isolates tenants', async () => {
    const a = new TenantStore(env.DB, SHOP);
    const b = new TenantStore(env.DB, 'b.myshopify.com');
    await a.upsertSupplier({ email: 'x@a.cn', threadId: 't1', facts: facts({ company: 'Older' }), seenAt: '2026-09-01T00:00:00Z', inboundCount: 1 });
    await a.upsertSupplier({ email: 'y@b.cn', threadId: 't2', facts: facts({ company: 'Newer' }), seenAt: '2026-09-20T00:00:00Z', inboundCount: 1 });
    const rows = await a.listSuppliers();
    expect(rows.map((r) => r.company)).toEqual(['Newer', 'Older']);
    expect(await b.listSuppliers()).toEqual([]);
    expect(await b.getSupplier('x@a.cn')).toBeNull();
  });

  it('owner fields: status is validated, notes are capped, the worker upsert never touches them', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertSupplier({ email: 'x@a.cn', threadId: 't1', facts: facts(), seenAt: '2026-09-01T00:00:00Z', inboundCount: 1 });
    expect(await s.updateSupplierOwnerFields('x@a.cn', { status: 'reviewed', notes: 'n'.repeat(3000) })).toBe(true);
    expect(await s.updateSupplierOwnerFields('x@a.cn', { status: 'bogus' as never })).toBe(false);
    await s.upsertSupplier({ email: 'x@a.cn', threadId: 't9', facts: facts(), seenAt: '2026-09-02T00:00:00Z', inboundCount: 2 });
    const row = await s.getSupplier('x@a.cn');
    expect(row?.status).toBe('reviewed');
    expect(row?.notes?.length).toBe(2000);
  });

  it('saveThreadReading stores the reading and stamps read_at', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
    const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-09-01T00:00:00Z', initialStatus: 'new' });
    await s.saveThreadReading(tid, '{"senderRole":"customer"}');
    const got = await s.getThreadWithMessages(tid);
    expect(got?.thread.reading_json).toBe('{"senderRole":"customer"}');
    expect(got?.thread.read_at).toBeTruthy();
  });

  it('saveThreadReading stores a reading whole or not at all, never sliced, and always stamps read_at', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertContact({ email: 'jane2@x.com', name: 'Jane', phone: null });
    const tid = await s.createThread({ contactEmail: 'jane2@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-09-01T00:00:00Z', initialStatus: 'new' });
    const huge = 'x'.repeat(20000);
    await s.saveThreadReading(tid, huge);
    const oversized = await s.getThreadWithMessages(tid);
    expect(oversized?.thread.reading_json).toBeNull();
    expect(oversized?.thread.read_at).toBeTruthy();

    const normal = '{"senderRole":"supplier","openQuestions":["price?"]}';
    await s.saveThreadReading(tid, normal);
    const got = await s.getThreadWithMessages(tid);
    expect(got?.thread.reading_json).toBe(normal);
  });

  it('the SQL merge, not just mergeSupplier, keeps a known dropship answer and the seen-date window under a second write', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertSupplier({ email: 'x@a.cn', threadId: 't1', facts: facts({ dropship: 'yes' }), seenAt: '2026-09-10T00:00:00Z', inboundCount: 1 });
    await s.upsertSupplier({ email: 'x@a.cn', threadId: 't0', facts: facts({ dropship: 'unknown' }), seenAt: '2026-09-01T00:00:00Z', inboundCount: 1 });
    const row = await s.getSupplier('x@a.cn');
    expect(row?.dropship).toBe('yes');
    expect(row?.last_seen_at).toBe('2026-09-10T00:00:00Z');
    expect(row?.first_seen_at).toBe('2026-09-01T00:00:00Z');
  });
});
