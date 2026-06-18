/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { proposeInvoiceOne } from '../src/inbox/sweep';
import { runInboxClassifySweep } from '../src/inbox/sweep';
import { DEFAULT_INBOX } from '../src/inbox/types';
import { ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig } from '../src/types';
import { Vault } from '../src/vault';
import type { Env } from '../src/types';
import type { InvoiceRow } from '../src/inbox/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const E = env as unknown as Env;
const VARIANT_ID = 'gid://shopify/ProductVariant/10';
const DRAFT_ORDER_ID = 'gid://shopify/DraftOrder/99';
const INVOICE_URL = 'https://a.myshopify.com/draft_orders/99/invoice';

/** Helper: get all invoices for a thread directly from D1 */
async function getInvoicesForThread(threadId: string): Promise<InvoiceRow[]> {
  const rs = await env.DB.prepare(`SELECT * FROM inbox_invoices WHERE shop = ?1 AND thread_id = ?2 ORDER BY created_at ASC`)
    .bind(SHOP, threadId).all<InvoiceRow>();
  return rs.results ?? [];
}

/** Build a TenantConfig with optional inbox overrides */
function cfg(inboxOverrides: Partial<typeof DEFAULT_INBOX> = {}): TenantConfig {
  return {
    collectionMap: ACTIVE_PAW_COLLECTION_MAP,
    gates: { popularityFloor: 1, priceMin: 1, priceMax: 9, relevance: 'title' },
    pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM,
    addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL,
    inbox: { ...DEFAULT_INBOX, ...inboxOverrides },
    target: 12
  };
}

/** Seal a real vault token so adminForShop can decrypt it */
async function sealToken(): Promise<{ accessTokenEnc: string; dekWrapped: string }> {
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  const dekWrapped = await vault.newTenantDek();
  const accessTokenEnc = await vault.seal(dekWrapped, 'shpat_test');
  return { accessTokenEnc, dekWrapped };
}

/** Seed a thread with one inbound buying-intent message, pre-classified needs_reply */
async function seedBuyingThread(store: TenantStore, subject = 'I want to order', category = 'lead'): Promise<string> {
  await store.upsertContact({ email: 'buyer@x.com', name: 'Buyer', phone: null });
  const tid = await store.createThread({
    contactEmail: 'buyer@x.com', subject, subjectNorm: subject.toLowerCase(),
    receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'needs_reply'
  });
  await store.insertInboundMessageIfNew({
    threadId: tid, messageId: '<buy@x>', inReplyTo: null, references: [],
    from: 'buyer@x.com', to: 'support@activepaw.co.uk', subject,
    bodyText: 'I want to buy 2 dog collars please.',
    bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-18T10:00:00Z'
  });
  await store.setThreadClassification(tid, {
    status: 'needs_reply', primaryCategory: category,
    intentScore: 90, summary: 'Wants to buy', classifiedAt: '2026-06-18T10:05:00Z'
  });
  return tid;
}

/** Build a fetchImpl that handles OpenRouter, Shopify Admin, and Resend calls */
function makeMockFetch(opts: {
  proposeResponse: object;
  spy?: { draftOrderHit: boolean; resendHit: boolean };
  /** When true, the catalog returns zero products (all lineRequests resolve to 'none') */
  emptyCatalog?: boolean;
}): typeof fetch {
  const productPayload = {
    products: {
      edges: [{
        node: {
          id: 'gid://shopify/Product/1', title: 'Dog Collar',
          variants: { edges: [{ node: { id: VARIANT_ID, title: 'Standard', sku: 'C-STD', price: '12.50', availableForSale: true } }] }
        }
      }]
    }
  };

  const emptyProductPayload = { products: { edges: [] } };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url));
    const body = (init?.body ? String(init.body) : '');

    if (url.includes('openrouter')) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(opts.proposeResponse) } }], usage: { cost: 0.0001 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.includes('resend.com')) {
      if (opts.spy) opts.spy.resendHit = true;
      return new Response(JSON.stringify({ id: 'resend-msg-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    // Shopify Admin GraphQL — discriminate by body
    if (url.includes('myshopify.com')) {
      if (body.includes('draftOrderCreate')) {
        if (opts.spy) opts.spy.draftOrderHit = true;
        return new Response(JSON.stringify({ data: { draftOrderCreate: { draftOrder: { id: DRAFT_ORDER_ID, invoiceUrl: INVOICE_URL }, userErrors: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // product search (pawscoutCatalog)
      return new Response(JSON.stringify({ data: opts.emptyCatalog ? emptyProductPayload : productPayload }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

// ─── Case 1: autoInvoice:false → holdReason auto_invoice_off, no reply draft ──
describe('proposeInvoiceOne — HITL hold (autoInvoice:false)', () => {
  it('creates proposed invoice with auto_invoice_off + no reply draft (mutual exclusion)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const { accessTokenEnc, dekWrapped } = await sealToken();
    await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: 'write_draft_orders,read_products' });
    await store.seedConfig(cfg());
    await store.saveInbox({ ...DEFAULT_INBOX }); // autoInvoice: false

    const tid = await seedBuyingThread(store);

    const proposePayload = {
      isInvoiceMoment: true,
      lineRequests: [{ query: 'dog collar', qty: 2 }],
      coverText: 'Here are the items you requested.',
      confidence: 97  // above threshold but autoInvoice:false → still held
    };

    const testEnv = { ...E, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'test-resend-key' } as unknown as Env;
    const threadRow = (await store.getThreadWithMessages(tid))!.thread;

    const handled = await proposeInvoiceOne(testEnv, store, cfg(), threadRow, makeMockFetch({ proposeResponse: proposePayload }));

    // Must handle the thread (returns true)
    expect(handled).toBe(true);

    // Invoice row must exist with status proposed and auto_invoice_off holdReason
    const invoiceRows = await getInvoicesForThread(tid);
    expect(invoiceRows).toHaveLength(1);
    const inv = invoiceRows[0];
    expect(inv.status).toBe('proposed');
    const holdReasons: string[] = JSON.parse(inv.hold_reasons ?? '[]');
    expect(holdReasons).toContain('auto_invoice_off');

    // No reply draft should exist (mutual exclusion)
    const draft = await store.getPendingDraft(tid);
    expect(draft).toBeNull();
  });
});

// ─── Case 2: autoInvoice:true + all floor conditions pass → sent ───────────
describe('proposeInvoiceOne — Auto-send (autoInvoice:true, all pass)', () => {
  it('creates draft order, sends invoice email, invoice ends sent', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const { accessTokenEnc, dekWrapped } = await sealToken();
    await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: 'write_draft_orders,read_products' });

    const inboxCfg = {
      ...DEFAULT_INBOX,
      autoInvoice: true,
      invoiceConfidenceThreshold: 80,  // proposal confidence 97 ≥ 80
      invoiceValueCeiling: 250,         // 2 × £12.50 = £25 ≤ 250
      invoiceRateLimit: 2
    };
    await store.seedConfig(cfg(inboxCfg));
    await store.saveInbox(inboxCfg);

    // category 'lead' is in ALLOWED_CATEGORIES
    const tid = await seedBuyingThread(store, 'I want to order dog collars', 'lead');

    const proposePayload = {
      isInvoiceMoment: true,
      lineRequests: [{ query: 'dog collar', qty: 2 }],
      coverText: 'Here are the items you requested.',
      confidence: 97
    };

    const spy = { draftOrderHit: false, resendHit: false };
    const testEnv = { ...E, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'test-resend-key' } as unknown as Env;
    const threadRow = (await store.getThreadWithMessages(tid))!.thread;

    const handled = await proposeInvoiceOne(testEnv, store, cfg(inboxCfg), threadRow, makeMockFetch({ proposeResponse: proposePayload, spy }));

    expect(handled).toBe(true);

    // Draft order must have been called
    expect(spy.draftOrderHit).toBe(true);
    // Resend must have been called
    expect(spy.resendHit).toBe(true);

    // Invoice ends in sent status
    const invoiceRows = await getInvoicesForThread(tid);
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0].status).toBe('sent');
    expect(invoiceRows[0].invoice_url).toBe(INVOICE_URL);

    // Thread moved to awaiting_customer
    const got = await store.getThreadWithMessages(tid);
    expect(got?.thread.status).toBe('awaiting_customer');
  });
});

// ─── Case 2b: autoInvoice:true but catalog resolves nothing → proposed (held), no Shopify/Resend ──
describe('proposeInvoiceOne — empty catalog (all lineRequests resolve to none)', () => {
  it('stores proposed invoice with no_resolved_items hold, createDraftOrder and Resend NOT called', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const { accessTokenEnc, dekWrapped } = await sealToken();
    await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: 'write_draft_orders,read_products' });

    const inboxCfg = {
      ...DEFAULT_INBOX,
      autoInvoice: true,
      invoiceConfidenceThreshold: 80,
      invoiceValueCeiling: 250,
      invoiceRateLimit: 2
    };
    await store.seedConfig(cfg(inboxCfg));
    await store.saveInbox(inboxCfg);

    const tid = await seedBuyingThread(store, 'I want to order something rare', 'lead');

    // LLM says isInvoiceMoment:true with a lineRequest, but catalog returns no products
    const proposePayload = {
      isInvoiceMoment: true,
      lineRequests: [{ query: 'rare unobtainium widget', qty: 1 }],
      coverText: 'Found it for you.',
      confidence: 97
    };

    const spy = { draftOrderHit: false, resendHit: false };
    const testEnv = { ...E, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'test-resend-key' } as unknown as Env;
    const threadRow = (await store.getThreadWithMessages(tid))!.thread;

    const handled = await proposeInvoiceOne(
      testEnv, store, cfg(inboxCfg), threadRow,
      makeMockFetch({ proposeResponse: proposePayload, spy, emptyCatalog: true })
    );

    expect(handled).toBe(true);

    // Must NOT have called createDraftOrder or Resend
    expect(spy.draftOrderHit).toBe(false);
    expect(spy.resendHit).toBe(false);

    // Invoice must be proposed (held), not sent
    const invoiceRows = await getInvoicesForThread(tid);
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0].status).toBe('proposed');
    const holdReasons: string[] = JSON.parse(invoiceRows[0].hold_reasons ?? '[]');
    expect(holdReasons).toContain('no_resolved_items');
  });
});

// ─── Case 3: existing active invoice → idempotency (no second invoice, no LLM/Shopify call) ──
describe('proposeInvoiceOne — idempotency', () => {
  it('returns true and creates NO second invoice when a sent invoice already exists', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const { accessTokenEnc, dekWrapped } = await sealToken();
    await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: 'write_draft_orders,read_products' });
    await store.seedConfig(cfg());
    await store.saveInbox({ ...DEFAULT_INBOX });

    const tid = await seedBuyingThread(store);

    // Pre-seed a sent invoice on the thread
    await store.insertInvoice({
      threadId: tid,
      lineItems: [{ variantId: VARIANT_ID, sku: 'C-STD', title: 'Dog Collar', qty: 1, priceGbp: 12.50 }],
      total: 12.50, currency: 'GBP', coverText: 'Previous invoice', confidence: 97,
      holdReasons: [], status: 'sent'
    });

    const testEnv = { ...E, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'test-resend-key' } as unknown as Env;
    const threadRow = (await store.getThreadWithMessages(tid))!.thread;

    // fetchImpl should never be called since we short-circuit on active invoice
    const fetchImpl = (async () => { throw new Error('fetchImpl should not be called during idempotency check'); }) as unknown as typeof fetch;

    const handled = await proposeInvoiceOne(testEnv, store, cfg(), threadRow, fetchImpl);

    // Returns true (thread is "handled" — don't fall through to draftOne)
    expect(handled).toBe(true);

    // Still only one invoice row
    const invoiceRows = await getInvoicesForThread(tid);
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0].status).toBe('sent'); // unchanged
  });

  it('returns true and creates NO second invoice when a proposed invoice already exists (HITL re-sweep)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const { accessTokenEnc, dekWrapped } = await sealToken();
    await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: 'write_draft_orders,read_products' });
    await store.seedConfig(cfg());
    await store.saveInbox({ ...DEFAULT_INBOX });

    const tid = await seedBuyingThread(store);

    // Pre-seed a proposed invoice (HITL: floor held last sweep)
    await store.insertInvoice({
      threadId: tid,
      lineItems: [{ variantId: VARIANT_ID, sku: 'C-STD', title: 'Dog Collar', qty: 1, priceGbp: 12.50 }],
      total: 12.50, currency: 'GBP', coverText: 'Pending invoice', confidence: 97,
      holdReasons: ['auto_invoice_off'], status: 'proposed'
    });

    const testEnv = { ...E, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'test-resend-key' } as unknown as Env;
    const threadRow = (await store.getThreadWithMessages(tid))!.thread;

    // fetchImpl must NOT be called — no LLM or Shopify call should happen
    const fetchImpl = (async () => { throw new Error('fetchImpl should not be called: proposed invoice is active'); }) as unknown as typeof fetch;

    const handled = await proposeInvoiceOne(testEnv, store, cfg(), threadRow, fetchImpl);

    // Returns true (thread is handled — no fallthrough to draftOne)
    expect(handled).toBe(true);

    // Still exactly one invoice row, unchanged
    const invoiceRows = await getInvoicesForThread(tid);
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0].status).toBe('proposed'); // unchanged
  });
});

// ─── Case 4: mutual-exclusion end-to-end via runInboxClassifySweep ───────────
describe('runInboxClassifySweep — invoice path skips draftOne', () => {
  it('when proposeInvoiceOne handles the thread, no reply draft is created', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const { accessTokenEnc, dekWrapped } = await sealToken();
    await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: 'write_draft_orders,read_products' });
    await store.seedConfig(cfg());
    await store.saveInbox({ ...DEFAULT_INBOX }); // autoInvoice:false → HITL hold

    const tid = await seedBuyingThread(store, 'I want to buy', 'lead');

    const proposePayload = {
      isInvoiceMoment: true,
      lineRequests: [{ query: 'dog collar', qty: 2 }],
      coverText: 'Here are your items.',
      confidence: 97
    };

    const fetchImpl = makeMockFetch({ proposeResponse: proposePayload });
    const testEnv = { ...E, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'test-resend-key' } as unknown as Env;

    await runInboxClassifySweep(testEnv, fetchImpl);

    // Invoice row exists
    const invoiceRows = await getInvoicesForThread(tid);
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0].status).toBe('proposed');

    // No reply draft was created for this thread
    const draft = await store.getPendingDraft(tid);
    expect(draft).toBeNull();
  });
});
