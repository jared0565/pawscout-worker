/// <reference types="@cloudflare/vitest-plugin" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { eraseOwedFiles, r2KeyFor, fileUrl, serveInboxFile } from '../src/inbox/attachments';
import type { SupplierFacts } from '../src/inbox/supplier-register';
import type { Env } from '../src/types';

// Design 2026-11-14 (inbox attachments), 5.8: a GDPR erasure records the R2
// prefixes it owes in the same D1 batch that deletes the rows (the webhook is
// never retried), and eraseOwedFiles finishes the R2 side. The supplier
// register, which holds a contact's name and email, is erased too.
beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';
const BYTES = new TextEncoder().encode('%PDF-1.4 file');
const FACTS: SupplierFacts = { company: 'Nongshine', contactName: 'Jennie', website: null, storeLinks: [], kind: 'goods', productLines: ['cat cages'], shipsFrom: 'CN', nicheFit: 'on-niche', dropship: 'unknown' };

async function threadWithFile(store: TenantStore, email: string) {
  const t = await store.createThread({ contactEmail: email, subject: 'Cat', subjectNorm: 'cat', receivedAt: '2026-11-14T09:00:00Z', initialStatus: 'new' });
  const id = crypto.randomUUID();
  const key = r2KeyFor(store.shop, t, id);
  await env.INBOX_FILES.put(key, BYTES);
  await store.insertAttachment({ id, thread_id: t, message_id: 'm', filename: 'a.pdf', content_type: 'application/pdf', size_bytes: BYTES.byteLength, status: 'stored', r2_key: key });
  return { threadId: t, id, key };
}

async function owed(shop = SHOP): Promise<string[]> {
  const rs = await env.DB.prepare('SELECT prefix FROM inbox_file_erasures WHERE shop = ?1 ORDER BY prefix').bind(shop).all<{ prefix: string }>();
  return (rs.results ?? []).map((r) => r.prefix);
}

describe('erasure of inbound files', () => {
  it('redactContact records an owed prefix per thread and deletes the attachment and supplier_register rows', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await threadWithFile(store, 'jane@x.com');
    const b = await threadWithFile(store, 'jane@x.com');
    const bob = await threadWithFile(store, 'bob@x.com');
    await store.upsertSupplier({ email: 'jane@x.com', threadId: a.threadId, facts: FACTS, seenAt: '2026-11-14T09:00:00Z', inboundCount: 1 });
    await store.upsertSupplier({ email: 'bob@x.com', threadId: bob.threadId, facts: FACTS, seenAt: '2026-11-14T09:00:00Z', inboundCount: 1 });

    await store.redactContact('Jane@X.com');

    expect(await owed()).toEqual([`inbox/${SHOP}/${a.threadId}/`, `inbox/${SHOP}/${b.threadId}/`].sort());
    expect(await store.listAttachmentsForThread(a.threadId)).toEqual([]);
    expect(await store.getSupplier('jane@x.com')).toBeNull();
    expect(await store.listAttachmentsForThread(bob.threadId)).toHaveLength(1);
    expect(await store.getSupplier('bob@x.com')).not.toBeNull();
  });

  it('eraseOwedFiles deletes every object under owed prefixes and clears the rows', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await threadWithFile(store, 'jane@x.com');
    // An orphan: an object with no D1 row under the same thread prefix.
    await env.INBOX_FILES.put(`inbox/${SHOP}/${a.threadId}/orphan`, BYTES);
    const bob = await threadWithFile(store, 'bob@x.com');
    await store.redactContact('jane@x.com');

    const r = await eraseOwedFiles(env.INBOX_FILES, env.DB, SHOP);
    expect(r).toEqual({ deleted: 2, remaining: 0 });
    expect(await env.INBOX_FILES.get(a.key)).toBeNull();
    expect(await env.INBOX_FILES.get(`inbox/${SHOP}/${a.threadId}/orphan`)).toBeNull();
    expect(await env.INBOX_FILES.get(bob.key)).not.toBeNull();
    expect(await owed()).toEqual([]);
  });

  it('a failing delete keeps the row for the daily stage', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await threadWithFile(store, 'jane@x.com');
    await store.redactContact('jane@x.com');
    const broken = {
      list: (o: R2ListOptions) => env.INBOX_FILES.list(o),
      delete: async () => { throw new Error('r2 down'); },
    } as unknown as R2Bucket;
    const r = await eraseOwedFiles(broken, env.DB, SHOP);
    expect(r.remaining).toBe(1);
    expect(await owed()).toHaveLength(1);
  });

  it('never deletes outside the owed shop prefix', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const keep = await threadWithFile(store, 'bob@x.com');
    await env.DB.prepare('INSERT INTO inbox_file_erasures (shop, prefix, created_at) VALUES (?1, ?2, ?3)').bind(SHOP, '', '2026-11-14T00:00:00Z').run();
    await env.DB.prepare('INSERT INTO inbox_file_erasures (shop, prefix, created_at) VALUES (?1, ?2, ?3)').bind(SHOP, 'inbox/b.myshopify.com/', '2026-11-14T00:00:00Z').run();
    await eraseOwedFiles(env.INBOX_FILES, env.DB, SHOP);
    expect(await env.INBOX_FILES.get(keep.key)).not.toBeNull();
  });

  it('redactShop owes inbox/<shop>/ and deletes all attachment rows and supplier rows', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await threadWithFile(store, 'jane@x.com');
    await store.upsertSupplier({ email: 'jane@x.com', threadId: a.threadId, facts: FACTS, seenAt: '2026-11-14T09:00:00Z', inboundCount: 1 });
    await store.redactShop();
    expect(await owed()).toEqual([`inbox/${SHOP}/`]);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM inbox_attachments WHERE shop = ?1').bind(SHOP).first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect(await store.getSupplier('jane@x.com')).toBeNull();
    await eraseOwedFiles(env.INBOX_FILES, env.DB);
    expect(await env.INBOX_FILES.get(a.key)).toBeNull();
    expect(await owed()).toEqual([]);
  });

  // Review Focus 5: a link signed before the erasure must not serve the file.
  it('a link opened after redactContact is 404', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const a = await threadWithFile(store, 'jane@x.com');
    const E = { ...env, SHOPIFY_API_SECRET: 's3cret', SHOPIFY_APP_URL: 'https://x' } as unknown as Env;
    const now = Math.floor(Date.now() / 1000);
    const url = new URL(await fileUrl('https://x', 's3cret', SHOP, a.id, now));
    const q = Object.fromEntries(url.searchParams);
    expect((await serveInboxFile(E, a.id, q, now)).status).toBe(200);
    await store.redactContact('jane@x.com');
    await eraseOwedFiles(env.INBOX_FILES, env.DB, SHOP);
    expect((await serveInboxFile(E, a.id, q, now)).status).toBe(404);
  });

  it('inboxDataSummary counts attachments', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await threadWithFile(store, 'jane@x.com');
    await threadWithFile(store, 'jane@x.com');
    expect((await store.inboxDataSummary('jane@x.com')).attachments).toBe(2);
  });
});
