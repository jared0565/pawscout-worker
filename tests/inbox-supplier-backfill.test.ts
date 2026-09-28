/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { startSupplierBackfill, runSupplierBackfillStep, readBackfillCursor } from '../src/inbox/supplier-backfill';
import { THREAD_READER_MARKER } from '../src/inbox/thread-read';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';
const ENV = { ...env, OPENROUTER_API_KEY: 'k' } as any;

async function seedMany(n: number) {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await s.seedConfig({ collectionMap: ACTIVE_PAW_COLLECTION_MAP, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: { ...DEFAULT_INBOX }, target: 12 });
  await s.saveInbox({ ...DEFAULT_INBOX });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const email = `s${i}@factory${i}.cn`;
    await s.upsertContact({ email, name: `S${i}`, phone: null });
    const tid = await s.createThread({ contactEmail: email, subject: 'Offer', subjectNorm: 'offer', receivedAt: new Date().toISOString(), initialStatus: 'new' });
    await s.insertInboundMessageIfNew({ threadId: tid, messageId: `<b${i}@x>`, inReplyTo: null, references: [], from: email, to: 'contact@activepaw.co.uk', subject: 'Offer', bodyText: 'We are a pet toy factory.', bodyHtml: null, headersJson: '{}', receivedAt: new Date().toISOString() });
    await s.setThreadClassification(tid, { status: 'awaiting_customer', primaryCategory: 'other', intentScore: 0, summary: 's', classifiedAt: new Date().toISOString() });
    ids.push(tid);
  }
  return { s, ids };
}

const fetchImpl = (async (_u: string, init: RequestInit) => {
  const sys = JSON.parse(String(init.body)).messages?.[0]?.content ?? '';
  const content = sys.startsWith(THREAD_READER_MARKER)
    ? JSON.stringify({ senderRole: 'goods-supplier', openAsks: [], offered: 'pet toys', alreadyAnswered: [], replyNeeded: true, supplier: { company: 'Toy Factory', kind: 'goods', productLines: ['pet toys'], nicheFit: 'on-niche', dropship: 'unknown', storeLinks: [] } })
    : 'unexpected';
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0 } }), { status: 200 });
}) as unknown as typeof fetch;

describe('supplier back-fill', () => {
  it('does nothing until started', async () => {
    const { s } = await seedMany(1);
    expect(await runSupplierBackfillStep(ENV, s, (await s.getConfig())!, fetchImpl)).toBeNull();
    expect(await s.listSuppliers()).toEqual([]);
  });

  // Its own timeout, measured: seeding 25 threads makes this the slowest test
  // in the file (1.2s alone on a quiet machine, 2026-09-28), and inside a
  // loaded full-suite run (aramid's mutation baseline, 2026-09-27 22:00Z) it
  // passed vitest's 5s default and failed the whole suite. 30s still catches a
  // real hang.
  it('drains in batches of 20, registers suppliers, drafts nothing, changes no status', async () => {
    const { s, ids } = await seedMany(25);
    await startSupplierBackfill(s);
    const c1 = await runSupplierBackfillStep(ENV, s, (await s.getConfig())!, fetchImpl);
    expect(c1?.scanned).toBe(20);
    expect(c1?.done).toBe(false);
    const c2 = await runSupplierBackfillStep(ENV, s, (await s.getConfig())!, fetchImpl);
    expect(c2?.scanned).toBe(25);
    expect(c2?.done).toBe(true);
    expect((await s.listSuppliers()).length).toBe(25);
    for (const id of ids) {
      expect(await s.getPendingDraft(id)).toBeNull();
      expect((await s.getThreadWithMessages(id))?.thread.status).toBe('awaiting_customer');
    }
    expect((await readBackfillCursor(s))?.found).toBe(25);
  }, 30_000);

  // Plan review fix: a closed thread is never a back-fill candidate. Stamping
  // its read_at would hide a new inbound message from the closed-thread reopen
  // check (store.closedReopenCandidates reads read_at as the "already seen" mark).
  it('skips closed threads', async () => {
    const { s, ids } = await seedMany(2);
    await s.setThreadClassification(ids[0], { status: 'closed', primaryCategory: 'other', intentScore: 0, summary: 's', classifiedAt: new Date().toISOString() });
    await startSupplierBackfill(s);
    const c = await runSupplierBackfillStep(ENV, s, (await s.getConfig())!, fetchImpl);
    expect(c?.scanned).toBe(1);
    expect(c?.done).toBe(true);
    expect((await s.listSuppliers()).length).toBe(1);
    expect((await s.getThreadWithMessages(ids[0]))?.thread.read_at).toBeNull();
  });

  // Review fix, round 1: the owner can set a thread's status to 'spam' or it
  // can become 'converted' from the console without touching primary_category,
  // so a dismissed thread filed 'other' must not stay a back-fill candidate -
  // it would cost a paid read and could still register a supplier row for a
  // thread the owner already dismissed.
  it('skips spam and converted threads', async () => {
    const { s, ids } = await seedMany(3);
    await s.setThreadClassification(ids[0], { status: 'spam', primaryCategory: 'other', intentScore: 0, summary: 's', classifiedAt: new Date().toISOString() });
    await s.setThreadClassification(ids[1], { status: 'converted', primaryCategory: 'other', intentScore: 0, summary: 's', classifiedAt: new Date().toISOString() });
    let calls = 0;
    const counting = (async (u: string, init: RequestInit) => { calls++; return fetchImpl(u, init); }) as unknown as typeof fetch;
    await startSupplierBackfill(s);
    const c = await runSupplierBackfillStep(ENV, s, (await s.getConfig())!, counting);
    expect(c?.scanned).toBe(1); // only ids[2] (still 'awaiting_customer') is a candidate
    expect(c?.done).toBe(true);
    expect(calls).toBe(1); // no reader call was made for the spam or converted threads
    expect((await s.listSuppliers()).length).toBe(1);
    expect((await s.getThreadWithMessages(ids[0]))?.thread.read_at).toBeNull();
    expect((await s.getThreadWithMessages(ids[1]))?.thread.read_at).toBeNull();
  });
});
