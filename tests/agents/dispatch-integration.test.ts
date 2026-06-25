/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../../src/tenant-store';
import { composeAgentDraft, composeDraftForThread } from '../../src/inbox/sweep';
import { DEFAULT_INBOX } from '../../src/inbox/types';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL } from '../../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'dispatch-test.myshopify.com';

async function seedShop(store: TenantStore) {
  await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 's' });
  await store.seedConfig({
    collectionMap: ACTIVE_PAW_COLLECTION_MAP,
    gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM,
    addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL,
    inbox: { ...DEFAULT_INBOX, alertEmail: 'owner@example.com' }, target: 12
  });
  await store.saveInbox({ ...DEFAULT_INBOX, alertEmail: 'owner@example.com' });
}

// ---------------------------------------------------------------------------
// Pure-function cases: composeAgentDraft trusted-figure exemption
// ---------------------------------------------------------------------------
describe('composeAgentDraft (trusted-figure exemption)', () => {
  it('appends the trusted line without flagging money when the LLM body is clean', () => {
    const r = composeAgentDraft(
      { bodyText: 'Happy to help with delivery.', quotesPriceOrOrder: false },
      'Delivery to the United States: estimated 7-23 days.'
    );
    expect(r.bodyText).toContain('estimated 7-23 days');
    expect(r.quotesPriceOrder).toBe(false); // trusted appendix is exempt
  });

  it('flags money when the LLM body itself quotes a price', () => {
    // mentionsMoney matches NUMBER-then-currency ("20 GBP") or £/$/€ prefix ("£20"),
    // but NOT currency-then-number ("GBP 20"); use the canonical £ prefix form.
    const r = composeAgentDraft(
      { bodyText: 'That will be £20.', quotesPriceOrOrder: false },
      null
    );
    expect(r.quotesPriceOrder).toBe(true); // mentionsMoney caught the £ figure
  });
});

// ---------------------------------------------------------------------------
// E2E: composeDraftForThread wires the shipping agent through dispatch
// ---------------------------------------------------------------------------
describe('composeDraftForThread (agent dispatch E2E)', () => {
  it('Case A: shipping-returns thread gets grounded 7-23 day appendix', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedShop(store);
    await store.upsertContact({ email: 'customer@example.com', name: 'Sam', phone: null });

    // Per-item shipping needs a resolvable product: seed a CN-warehoused item the
    // customer links by URL, so resolveItemShipping grounds confidently (CN->US).
    await store.putLink({ cjPid: 'P1', state: 'imported', handle: 'dog-bed' });
    await store.putWarehouseProduct({
      cjPid: 'P1', category: 'pet-accessories', title: 'Dog Bed',
      detailJson: JSON.stringify({ origins: { CN: 500 }, variants: [{ vid: 'v1', stock: 500 }] }),
      priceUsd: 20, listedNum: 100, stock: 500
    });

    const tid = await store.createThread({
      contactEmail: 'customer@example.com',
      subject: 'Delivery question',
      subjectNorm: 'delivery question',
      receivedAt: '2026-06-24T09:00:00Z',
      initialStatus: 'new'
    });
    await store.insertInboundMessageIfNew({
      threadId: tid,
      messageId: '<ship1@x>',
      inReplyTo: null,
      references: [],
      from: 'customer@example.com',
      to: 'support@activepaw.co.uk',
      subject: 'Delivery question',
      bodyText: 'How long will delivery take to Texas for activepaw.co.uk/products/dog-bed?',
      bodyHtml: null,
      headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}',
      receivedAt: '2026-06-24T09:00:00Z'
    });

    // Classify thread as shipping-returns / needs_reply
    await store.setThreadClassification(tid, {
      status: 'needs_reply',
      primaryCategory: 'shipping-returns',
      intentScore: 60,
      summary: 'Asks about delivery time to Texas',
      classifiedAt: '2026-06-24T09:01:00Z'
    });

    // Seed a fresh CN->US logistics route (transit 5-11 days).
    // doorToDoorBand: min=2+5=7, max=5+11+5+2=23 => "estimated 7-23 days"
    await store.upsertLogisticsRoute({
      from: 'CN', to: 'US', channel: 'CJPacket',
      transitMin: 5, transitMax: 11,
      agingRaw: '5-11', repVid: 'v1'
    });

    const cfg = await store.getConfig();
    const got = await store.getThreadWithMessages(tid);
    const thread = got!.thread;

    // Fake fetch: return a clean draft LLM response for the openrouter call
    const fakeFetch = (async (_url: string) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ bodyText: 'Happy to help with delivery.', confidence: 90, quotesPriceOrOrder: false }) } }],
          usage: { cost: 0.0001 }
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const result = await composeDraftForThread(
      { ...env, OPENROUTER_API_KEY: 'k' } as any,
      store, cfg!, thread, fakeFetch
    );

    expect(result).not.toBeNull();
    const draft = await store.getDraft(result!.draftId);
    expect(draft?.body_text).toContain('estimated 7-23 days');
    expect(draft?.status).toBe('pending');
  });

  it('Case B: other-category thread gets a plain draft with no delivery appendix', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedShop(store);
    await store.upsertContact({ email: 'other@example.com', name: 'Alex', phone: null });

    const tid = await store.createThread({
      contactEmail: 'other@example.com',
      subject: 'General enquiry',
      subjectNorm: 'general enquiry',
      receivedAt: '2026-06-24T09:10:00Z',
      initialStatus: 'new'
    });
    await store.insertInboundMessageIfNew({
      threadId: tid,
      messageId: '<other1@x>',
      inReplyTo: null,
      references: [],
      from: 'other@example.com',
      to: 'support@activepaw.co.uk',
      subject: 'General enquiry',
      bodyText: 'Do you have gift wrapping available?',
      bodyHtml: null,
      headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}',
      receivedAt: '2026-06-24T09:10:00Z'
    });

    await store.setThreadClassification(tid, {
      status: 'needs_reply',
      primaryCategory: 'other',
      intentScore: 20,
      summary: 'Asks about gift wrapping',
      classifiedAt: '2026-06-24T09:11:00Z'
    });

    const cfg = await store.getConfig();
    const got = await store.getThreadWithMessages(tid);
    const thread = got!.thread;

    const fakeFetch = (async (_url: string) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ bodyText: 'We do not currently offer gift wrapping.', confidence: 88, quotesPriceOrOrder: false }) } }],
          usage: { cost: 0.0001 }
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    const result = await composeDraftForThread(
      { ...env, OPENROUTER_API_KEY: 'k' } as any,
      store, cfg!, thread, fakeFetch
    );

    expect(result).not.toBeNull();
    const draft = await store.getDraft(result!.draftId);
    expect(draft?.body_text).toContain('gift wrapping');
    expect(draft?.body_text).not.toContain('Delivery to');
    expect(draft?.body_text).not.toContain('estimated');
    expect(draft?.status).toBe('pending');
  });
});
