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

  it('Case C: lead thread carries the search-bar P.S. after the footer on the FIRST reply only', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedShop(store);
    await store.upsertContact({ email: 'buyer@example.com', name: 'Ann', phone: null });

    const tid = await store.createThread({
      contactEmail: 'buyer@example.com', subject: 'Interested in a bed', subjectNorm: 'interested in a bed',
      receivedAt: '2026-07-03T09:00:00Z', initialStatus: 'new'
    });
    await store.insertInboundMessageIfNew({
      threadId: tid, messageId: '<lead1@x>', inReplyTo: null, references: [],
      from: 'buyer@example.com', to: 'support@activepaw.co.uk', subject: 'Interested in a bed',
      bodyText: 'Do you have beds for large dogs?', bodyHtml: null,
      headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}',
      receivedAt: '2026-07-03T09:00:00Z'
    });
    await store.setThreadClassification(tid, {
      status: 'needs_reply', primaryCategory: 'lead', intentScore: 85,
      summary: 'Buyer asking about large dog beds', classifiedAt: '2026-07-03T09:01:00Z'
    });

    const cfg = await store.getConfig();
    const fakeFetch = (async (_url: string) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ bodyText: 'Yes, we stock several beds suited to large dogs on the website.', confidence: 90, quotesPriceOrOrder: false }) } }],
          usage: { cost: 0.0001 }
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    // FIRST reply: P.S. present, AFTER the Sales Team footer.
    const thread1 = (await store.getThreadWithMessages(tid))!.thread;
    const r1 = await composeDraftForThread({ ...env, OPENROUTER_API_KEY: 'k' } as any, store, cfg!, thread1, fakeFetch);
    expect(r1).not.toBeNull();
    const d1 = (await store.getDraft(r1!.draftId))!;
    expect(d1.body_text).toContain('P.S. 🔍');
    expect(d1.body_text).toContain('search bar');
    expect(d1.body_text.indexOf('Active Paw Sales Team')).toBeLessThan(d1.body_text.indexOf('P.S.'));

    // We reply (outbound recorded) and the customer writes again: NO P.S. on the follow-up.
    await store.insertOutboundMessage({ threadId: tid, messageId: '<out1@ap>', from: 'support@activepaw.co.uk', to: 'buyer@example.com', subject: 'Re: Interested in a bed', bodyText: 'sent reply', bodyHtml: '<p>sent reply</p>', sentAt: '2026-07-03T10:00:00Z' });
    await store.insertInboundMessageIfNew({
      threadId: tid, messageId: '<lead2@x>', inReplyTo: '<out1@ap>', references: [],
      from: 'buyer@example.com', to: 'support@activepaw.co.uk', subject: 'Re: Interested in a bed',
      bodyText: 'Great, which colours do they come in?', bodyHtml: null,
      headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}',
      receivedAt: '2026-07-03T11:00:00Z'
    });
    const thread2 = (await store.getThreadWithMessages(tid))!.thread;
    const r2 = await composeDraftForThread({ ...env, OPENROUTER_API_KEY: 'k' } as any, store, cfg!, thread2, fakeFetch);
    expect(r2).not.toBeNull();
    const d2 = (await store.getDraft(r2!.draftId))!;
    expect(d2.body_text).not.toContain('P.S.');
    expect(d2.body_text).toContain('Active Paw Sales Team'); // footer still there
  });
});

// ---------------------------------------------------------------------------
// Rose thread (2026-09-05/06). Two inbound messages, no outbound: a pasted
// product link plus "do the products arrive exactly as shown and described?",
// then a bump: "still open to recommending your store, but I wanted to make
// sure I can reach you directly". The classifier called the bump 'affiliate'
// and the category alone opened the partnership funnel, which drafted the full
// signup invite (model partnership-screen) to someone who never asked to
// partner. Owner: "make sure that all responses are properly grounded to the
// context of the thread and not draft random replies". The funnel must stay
// closed without an ask in the sender's own words, and the LLM path must not
// then hand the thread to the affiliate agent (whose prompt sets out the
// programme unasked): a category with no ask behind it is handled as a general
// enquiry, whose prompt answers the question asked and raises the programme
// only if the sender does.
// ---------------------------------------------------------------------------
describe('composeDraftForThread grounds an affiliate-classified thread in the message text', () => {
  const ROSE_1 = 'https://activepaw.co.uk/products/portable-dog-water-bowl-bottle-attachment\n\nI came across your store and I am considering recommending it to a few people who are looking for products in this category. Before I do, I wanted to ask do the products normally arrive exactly as shown and described on the website?';
  const ROSE_2 = 'just checking back in. I think our conversation got a little buried. I am still open to recommending your store, but I wanted to make sure I can reach you directly if anyone has questions before ordering. Whenever you get a chance, I would love to hear back from you';

  it('no partnership ask in the thread: general agent, no signup invite, no applicant row', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedShop(store);
    await store.saveInbox({ ...DEFAULT_INBOX, alertEmail: 'owner@example.com', affiliateMode: 'signup_page' });
    await store.upsertContact({ email: 'rose@example.com', name: 'Rose', phone: null });
    const tid = await store.createThread({ contactEmail: 'rose@example.com', subject: 'Quick question', subjectNorm: 'quick question', receivedAt: '2026-09-05T14:44:00Z', initialStatus: 'new' });
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<rose1@x>', inReplyTo: null, references: [], from: 'rose@example.com', to: 'contact@activepaw.co.uk', subject: 'Quick question', bodyText: ROSE_1, bodyHtml: null, headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}', receivedAt: '2026-09-05T14:44:00Z' });
    await store.insertInboundMessageIfNew({ threadId: tid, messageId: '<rose2@x>', inReplyTo: '<rose1@x>', references: [], from: 'rose@example.com', to: 'contact@activepaw.co.uk', subject: 'Re: Quick question', bodyText: ROSE_2, bodyHtml: null, headersJson: '{"authentication-results":"mx; spf=pass dkim=pass dmarc=pass"}', receivedAt: '2026-09-06T04:07:00Z' });
    await store.setThreadClassification(tid, { status: 'needs_reply', primaryCategory: 'affiliate', intentScore: 20, summary: 'Wants to recommend the store; asks if products arrive as described', classifiedAt: '2026-09-06T04:15:00Z' });

    const systems: string[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const sys = (body.messages ?? []).find((m: { role: string }) => m.role === 'system');
      if (sys) systems.push(String(sys.content));
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ customerAsks: ['reach you directly'], bodyText: 'Yes, you can reach us directly at contact@activepaw.co.uk and we reply within one working day.', confidence: 90, quotesPriceOrOrder: false, commercialIntent: false }) } }],
        usage: { cost: 0.0001 }
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const cfg = await store.getConfig();
    const got = await store.getThreadWithMessages(tid);
    const result = await composeDraftForThread({ ...env, OPENROUTER_API_KEY: 'k' } as any, store, cfg!, got!.thread, fakeFetch);
    expect(result).not.toBeNull();
    const draft = await store.getDraft(result!.draftId);
    expect(draft?.model).not.toBe('partnership-screen');
    expect(draft?.body_text).not.toContain('apply');
    expect(draft?.body_text).toContain('Active Paw Customer Support');
    expect(await store.getApplicantByThread(tid)).toBeNull();
    expect(systems.length).toBeGreaterThan(0);
    // The general agent's prompt, not the affiliate agent's programme-first one.
    for (const s of systems) {
      expect(s).not.toContain('This is an affiliate, influencer, or partnership enquiry');
      expect(s).toContain('Judge the message by what the MESSAGE TEXT actually says');
    }
  });
});
