/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { buildShippingLineForThread } from '../src/inbox/sweep';
import { DEFAULT_INBOX, type ThreadRow } from '../src/inbox/types';
import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const SHOP = 'a.myshopify.com';
const CFG: TenantConfig = { collectionMap: {}, gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' }, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12 };

async function makeThread(s: TenantStore, over: { subject?: string; category?: string; email?: string }): Promise<ThreadRow> {
  const tid = await s.createThread({ contactEmail: over.email ?? 'x@x.com', subject: over.subject ?? '', subjectNorm: '', receivedAt: '2026-06-22T10:00:00Z', initialStatus: 'needs_reply' });
  if (over.category) await s.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: over.category, intentScore: 10, summary: null, classifiedAt: '2026-06-22T10:00:01Z' });
  return (await s.getThreadWithMessages(tid))!.thread;
}

describe('buildShippingLineForThread — grounds the freight line on the LATEST message', () => {
  it('appends the grounded delivery line when the latest message is a shipping question', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute({ from: 'CN', to: 'US', channel: 'LuWei Ordinary US', transitMin: 5, transitMax: 11, agingRaw: '5-11', repVid: 'v1' });
    const t = await makeThread(s, { subject: 'Question', category: 'other', email: 'mary@x.com' });
    const line = await buildShippingLineForThread(s, CFG, t, 'Do you ship to the United States?', 'Do you ship to the United States, and how long to NYC?');
    expect(line).toMatch(/^Delivery to the United States: estimated \d+(-\d+)? days\.$/);
  });

  it('returns null when the latest message has pivoted OFF shipping — even on a shipping-classified thread with a "Shipping Inquiry" subject', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute({ from: 'CN', to: 'GB', channel: 'CJPacket Ordinary', transitMin: 4, transitMax: 9, agingRaw: '4-9', repVid: 'v2' });
    // Stale shipping context (subject + category say shipping-returns, and the UK is named in
    // an earlier turn so a destination IS derivable) — but the LATEST message is a marketing
    // pitch with no shipping language, so no delivery line should be stapled to the reply.
    const t = await makeThread(s, { subject: 'Shipping Inquiry', category: 'shipping-returns', email: 'linda@x.com' });
    const conversation = "Do you ship to the UK?\n\n---\n\nLet's skip the small talk, you want sales, I know how to get them. I'm a Shopify Marketing Directory Partner.";
    const latest = "Let's skip the small talk, you want sales, I know how to get them. I'm a Shopify Marketing Directory Partner.";
    expect(await buildShippingLineForThread(s, CFG, t, conversation, latest)).toBeNull();
  });

  it('returns null on a shipping question to an unknown/ambiguous destination (safe hedge)', async () => {
    const s = new TenantStore(env.DB, SHOP);
    await s.upsertLogisticsRoute({ from: 'CN', to: 'US', channel: 'LuWei', transitMin: 5, transitMax: 11, agingRaw: '5-11', repVid: 'v3' });
    const t = await makeThread(s, { subject: 'Question', category: 'other', email: 'sam@gmail.com' });
    // Two different countries named → ambiguous → null; (also no synced route for FR here).
    expect(await buildShippingLineForThread(s, CFG, t, 'Do you ship to France or the US?', 'Do you ship to France or the US?')).toBeNull();
  });
});
