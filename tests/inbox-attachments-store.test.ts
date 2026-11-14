/// <reference types="@cloudflare/vitest-plugin" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

// Spec 2026-11-14 inbox attachments, 5.3: the file records (migration 0048)
// and the store methods the ingest, the console and the drafter read them by.
beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

async function thread(store: TenantStore, email: string, at = '2026-11-14T09:00:00Z'): Promise<string> {
  return store.createThread({ contactEmail: email, subject: 'Catalogue', subjectNorm: 'catalogue', receivedAt: at, initialStatus: 'new' });
}

function msg(threadId: string, messageId: string, from = 'jane@x.com') {
  return {
    threadId, messageId, inReplyTo: null, references: [], from, to: 'contact@activepaw.co.uk',
    subject: 'Catalogue', bodyText: 'Please find attached.', bodyHtml: null, headersJson: null,
    receivedAt: '2026-11-14T09:00:00Z'
  };
}

function row(threadId: string, messageId: string, filename: string, status: 'stored' | 'skipped_type' = 'stored') {
  return {
    id: crypto.randomUUID(), thread_id: threadId, message_id: messageId, filename,
    content_type: 'application/pdf', size_bytes: 1234, status,
    r2_key: status === 'stored' ? `inbox/${SHOP}/${threadId}/x` : null,
  };
}

describe('inbox attachment store', () => {
  it('insertInboundMessage returns the new id, then null for the same Message-ID', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const t = await thread(store, 'jane@x.com');
    const id1 = await store.insertInboundMessage(msg(t, '<m1@x>'));
    const id2 = await store.insertInboundMessage(msg(t, '<m1@x>'));
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
    expect(id2).toBeNull();
    expect((await store.getThreadWithMessages(t))!.messages[0].id).toBe(id1);
  });

  it('insertInboundMessageIfNew still returns true then false', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const t = await thread(store, 'jane@x.com');
    expect(await store.insertInboundMessageIfNew(msg(t, '<m2@x>'))).toBe(true);
    expect(await store.insertInboundMessageIfNew(msg(t, '<m2@x>'))).toBe(false);
  });

  it('lists attachments by thread and by contact, scoped to the shop', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const other = new TenantStore(env.DB, 'b.myshopify.com');
    const t1 = await thread(store, 'jane@x.com', '2026-11-14T09:00:00Z');
    const t2 = await thread(store, 'jane@x.com', '2026-11-14T10:00:00Z');
    const t3 = await thread(store, 'bob@x.com');
    const tOther = await thread(other, 'jane@x.com');
    await store.insertAttachment(row(t1, 'm1', 'a.pdf'));
    await store.insertAttachment(row(t2, 'm2', 'b.pdf'));
    await store.insertAttachment(row(t3, 'm3', 'bob.pdf'));
    await other.insertAttachment(row(tOther, 'm4', 'other-shop.pdf'));

    expect((await store.listAttachmentsForContact('Jane@X.com ')).map((r) => r.filename)).toEqual(['a.pdf', 'b.pdf']);
    expect((await store.listAttachmentsForThread(t1)).map((r) => r.filename)).toEqual(['a.pdf']);
    expect(await other.listAttachmentsForThread(t1)).toEqual([]);
    const got = (await store.listAttachmentsForThread(t2))[0];
    expect(got).toMatchObject({ shop: SHOP, thread_id: t2, message_id: 'm2', status: 'stored', size_bytes: 1234 });
    expect(got.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('getStoredAttachment ignores skipped rows and other shops', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const t = await thread(store, 'jane@x.com');
    const kept = row(t, 'm1', 'a.pdf');
    const skipped = row(t, 'm1', 'p.xlsm', 'skipped_type');
    await store.insertAttachment(kept);
    await store.insertAttachment(skipped);
    expect((await store.getStoredAttachment(kept.id))?.filename).toBe('a.pdf');
    expect(await store.getStoredAttachment(skipped.id)).toBeNull();
    expect(await new TenantStore(env.DB, 'b.myshopify.com').getStoredAttachment(kept.id)).toBeNull();
  });

  it('the R2 binding exists in tests', () => {
    expect((env as unknown as { INBOX_FILES?: unknown }).INBOX_FILES).toBeDefined();
  });
});
