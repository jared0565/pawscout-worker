/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { listInboxThreads, getInboxThread, setInboxStatus, setInboxLabels } from '../src/inbox/routes';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

async function seed() {
  const s = new TenantStore(env.DB, SHOP);
  await s.upsertContact({ email: 'jane@x.com', name: 'Jane', phone: null });
  const tid = await s.createThread({ contactEmail: 'jane@x.com', subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'new' });
  await s.insertInboundMessageIfNew({ threadId: tid, messageId: '<m@x>', inReplyTo: null, references: [], from: 'jane@x.com', to: 'support@activepaw.co.uk', subject: 'Hi', bodyText: 'hello', bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z' });
  return tid;
}

describe('inbox routes', () => {
  it('lists threads with contact + label summary', async () => {
    const tid = await seed();
    const r = await listInboxThreads(env.DB, SHOP, null);
    expect(r.ok).toBe(true);
    expect(r.threads[0].id).toBe(tid);
    expect(r.threads[0].contactEmail).toBe('jane@x.com');
  });
  it('reads a thread with its messages', async () => {
    const tid = await seed();
    const r = await getInboxThread(env.DB, SHOP, tid);
    expect(r.ok).toBe(true);
    expect(r.messages![0].body_text).toBe('hello');
  });
  it('sets status and labels with validation', async () => {
    const tid = await seed();
    expect((await setInboxStatus(env.DB, SHOP, tid, 'closed')).ok).toBe(true);
    expect((await setInboxStatus(env.DB, SHOP, tid, 'bogus')).ok).toBe(false);
    expect((await setInboxLabels(env.DB, SHOP, tid, ['lead'])).ok).toBe(true);
    expect((await setInboxLabels(env.DB, SHOP, tid, ['nope'])).ok).toBe(false);
    const got = await new TenantStore(env.DB, SHOP).getThreadWithMessages(tid);
    expect(got?.thread.status).toBe('closed');
    expect(got?.labels).toEqual(['lead']);
  });
  it('404s an unknown thread', async () => {
    const r = await getInboxThread(env.DB, SHOP, 'no-such-id');
    expect(r.ok).toBe(false);
  });
});
