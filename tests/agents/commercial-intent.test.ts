/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';

async function thread(s: TenantStore, email = 'jane@x.com', status: any = 'needs_reply') {
  await s.upsertContact({ email, name: null, phone: null });
  const tid = await s.createThread({ contactEmail: email, subject: 'Hi', subjectNorm: 'hi', receivedAt: '2026-06-18T10:00:00Z', initialStatus: status });
  return tid;
}

describe('insertDraft commercial_intent', () => {
  it('persists commercial_intent=1 when set', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await thread(s);
    const id = await s.insertDraft({
      threadId: tid, bodyText: 'x', bodyHtml: '<p>x</p>', confidence: 50,
      quotesPriceOrder: false, commercialIntent: true, holdReasons: [], model: 'm', status: 'pending'
    });
    const row = await s.getDraft(id);
    expect(row?.commercial_intent).toBe(1);
  });

  it('persists commercial_intent=0 when false', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await thread(s);
    const id = await s.insertDraft({
      threadId: tid, bodyText: 'x', bodyHtml: '<p>x</p>', confidence: 50,
      quotesPriceOrder: false, commercialIntent: false, holdReasons: [], model: 'm', status: 'pending'
    });
    const row = await s.getDraft(id);
    expect(row?.commercial_intent).toBe(0);
  });

  it('defaults commercial_intent=0 when not provided', async () => {
    const s = new TenantStore(env.DB, SHOP);
    const tid = await thread(s);
    const id = await s.insertDraft({
      threadId: tid, bodyText: 'x', bodyHtml: '<p>x</p>', confidence: 50,
      quotesPriceOrder: false, holdReasons: [], model: 'm', status: 'pending'
    });
    const row = await s.getDraft(id);
    expect(row?.commercial_intent).toBe(0);
  });
});
