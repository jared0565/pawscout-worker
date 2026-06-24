/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../../src/tenant-store';
import { proposeInvoiceOne } from '../../src/inbox/sweep';
import { leadAgent } from '../../src/inbox/agents/lead';
import { DEFAULT_INBOX } from '../../src/inbox/types';
import {
  ACTIVE_PAW_COLLECTION_MAP, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM,
  DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantConfig
} from '../../src/types';
import { Vault } from '../../src/vault';
import type { Env } from '../../src/types';
import type { InvoiceRow } from '../../src/inbox/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const E = env as unknown as Env;
const VARIANT_ID = 'gid://shopify/ProductVariant/10';
const DRAFT_ORDER_ID = 'gid://shopify/DraftOrder/99';
const INVOICE_URL = 'https://a.myshopify.com/draft_orders/99/invoice';

async function getInvoicesForThread(threadId: string): Promise<InvoiceRow[]> {
  const rs = await env.DB.prepare(
    `SELECT * FROM inbox_invoices WHERE shop = ?1 AND thread_id = ?2 ORDER BY created_at ASC`
  ).bind(SHOP, threadId).all<InvoiceRow>();
  return rs.results ?? [];
}

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

async function sealToken(): Promise<{ accessTokenEnc: string; dekWrapped: string }> {
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  const dekWrapped = await vault.newTenantDek();
  const accessTokenEnc = await vault.seal(dekWrapped, 'shpat_test');
  return { accessTokenEnc, dekWrapped };
}

async function seedLeadThread(store: TenantStore): Promise<string> {
  await store.upsertContact({ email: 'buyer@x.com', name: 'Buyer', phone: null });
  const tid = await store.createThread({
    contactEmail: 'buyer@x.com',
    subject: 'I want to buy now',
    subjectNorm: 'i want to buy now',
    receivedAt: '2026-06-24T10:00:00Z',
    initialStatus: 'needs_reply'
  });
  await store.insertInboundMessageIfNew({
    threadId: tid, messageId: '<lead@x>', inReplyTo: null, references: [],
    from: 'buyer@x.com', to: 'support@activepaw.co.uk',
    subject: 'I want to buy now',
    bodyText: 'I would like to purchase 2 dog collars please, how do I order?',
    bodyHtml: null, headersJson: '{}', receivedAt: '2026-06-24T10:00:00Z'
  });
  await store.setThreadClassification(tid, {
    status: 'needs_reply', primaryCategory: 'lead',
    intentScore: 92, summary: 'Wants to buy dog collars', classifiedAt: '2026-06-24T10:05:00Z'
  });
  return tid;
}

function makeMockFetch(opts: {
  proposeResponse: object;
  spy: { draftOrderHit: boolean; resendHit: boolean };
}): typeof fetch {
  const productPayload = {
    products: {
      edges: [{
        node: {
          id: 'gid://shopify/Product/1', title: 'Dog Collar',
          variants: {
            edges: [{
              node: {
                id: VARIANT_ID, title: 'Standard', sku: 'C-STD',
                price: '12.50', availableForSale: true, inventoryQuantity: 100
              }
            }]
          }
        }
      }]
    }
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === 'string' ? input
        : (input instanceof URL ? input.href : (input as Request).url)
    );
    const body = init?.body ? String(init.body) : '';

    if (url.includes('openrouter')) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(opts.proposeResponse) } }],
          usage: { cost: 0.0001 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (url.includes('resend.com')) {
      opts.spy.resendHit = true;
      return new Response(JSON.stringify({ id: 'resend-msg-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (url.includes('myshopify.com')) {
      if (body.includes('draftOrderCreate')) {
        opts.spy.draftOrderHit = true;
        return new Response(JSON.stringify({
          data: {
            draftOrderCreate: {
              draftOrder: { id: DRAFT_ORDER_ID, invoiceUrl: INVOICE_URL },
              userErrors: []
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: productPayload }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

/**
 * Regression guard: a buy-now lead with write_draft_orders scope and a
 * resolvable line item must reach the checkout/invoice path, NOT the chat
 * drafter. This ties the leadAgent.commercial contract to the sweep's mutual-
 * exclusion: proposeInvoiceOne returns true (handled) so draftOne is skipped.
 */
describe('lead -> invoice checkout handoff', () => {
  it('leadAgent is commercial and a buy-now lead is handled by the invoice path (draftOne skipped)', async () => {
    // Lead agent declares commercial intent - the invoice path is its CTA.
    expect(leadAgent.commercial).toBe(true);

    const store = new TenantStore(env.DB, SHOP);
    const { accessTokenEnc, dekWrapped } = await sealToken();
    await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: 'write_draft_orders,read_products' });

    const inboxCfg = {
      ...DEFAULT_INBOX,
      autoInvoice: true,
      invoiceConfidenceThreshold: 80,  // proposal confidence 97 >= 80
      invoiceValueCeiling: 250,         // 2 x 12.50 = 25.00 <= 250
      invoiceRateLimit: 2
    };
    await store.seedConfig(cfg(inboxCfg));
    await store.saveInbox(inboxCfg);

    const tid = await seedLeadThread(store);

    const proposePayload = {
      isInvoiceMoment: true,
      lineRequests: [{ query: 'dog collar', qty: 2 }],
      coverText: 'Here are the items you requested.',
      confidence: 97
    };

    const spy = { draftOrderHit: false, resendHit: false };
    const testEnv = { ...E, OPENROUTER_API_KEY: 'k', RESEND_API_KEY: 'test-resend-key' } as unknown as Env;
    const threadRow = (await store.getThreadWithMessages(tid))!.thread;

    // proposeInvoiceOne must return true: the thread is "handled" and draftOne
    // would be skipped in the sweep's if (!handled) draftOne(...) branch.
    const handled = await proposeInvoiceOne(testEnv, store, cfg(inboxCfg), threadRow, makeMockFetch({ proposeResponse: proposePayload, spy }));

    expect(handled).toBe(true);

    // Checkout path: a draft order and invoice email must have been sent.
    expect(spy.draftOrderHit).toBe(true);
    expect(spy.resendHit).toBe(true);

    // An invoice row must exist and be in sent status.
    const invoiceRows = await getInvoicesForThread(tid);
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0].status).toBe('sent');
    expect(invoiceRows[0].invoice_url).toBe(INVOICE_URL);

    // No pending reply draft - the drafter was skipped (mutual exclusion).
    const draft = await store.getPendingDraft(tid);
    expect(draft).toBeNull();
  });
});
