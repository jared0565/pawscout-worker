/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { buildInvoiceForThread, discardInvoice, searchCatalog } from '../src/inbox/invoice-routes';
import { Vault } from '../src/vault';
import type { Env } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
// env from cloudflare:test is ProvidedEnv (a subset); cast to Env for function signatures.
// Tests only exercise code paths that use env.DB and env.PAWSCOUT_MASTER_KEY,
// so missing Shopify API keys don't matter here.
const E = env as unknown as Env;

async function seedThread(store: TenantStore): Promise<string> {
  await store.upsertContact({ email: 'buyer@x.com', name: 'Buyer', phone: null });
  return store.createThread({ contactEmail: 'buyer@x.com', subject: 'Order enquiry', subjectNorm: 'order enquiry', receivedAt: '2026-06-18T10:00:00Z', initialStatus: 'needs_reply' });
}

// ─── (a) Scope-gate: missing write_draft_orders → reconnect_required ──────────
describe('buildInvoiceForThread', () => {
  it('returns reconnect_required when write_draft_orders scope is absent', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // Install tenant without write_draft_orders - scope gate must short-circuit
    // before any vault/admin call, so no real access token is needed.
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 'read_products,read_customers' });
    const tid = await seedThread(store);
    const r = await buildInvoiceForThread(
      E,
      store,
      tid,
      [{ variantId: 'gid://shopify/ProductVariant/1', qty: 1 }],
      'Here are your items'
    );
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toBe('reconnect_required');
  });
});

// ─── (b) discardInvoice sets status to discarded ──────────────────────────────
describe('discardInvoice', () => {
  it('sets invoice status to discarded', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    const tid = await seedThread(store);
    const invoiceId = await store.insertInvoice({
      threadId: tid,
      lineItems: [{ variantId: 'gid://shopify/ProductVariant/1', sku: 'X', title: 'Collar', qty: 1, priceGbp: 9.99 }],
      total: 9.99,
      currency: 'GBP',
      coverText: 'Enjoy!',
      confidence: null,
      holdReasons: [],
      status: 'proposed'
    });
    const r = await discardInvoice(E, store, invoiceId);
    expect(r.ok).toBe(true);
    expect((await store.getInvoice(invoiceId))?.status).toBe('discarded');
  });

  it('is idempotent when already discarded', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    const tid = await seedThread(store);
    const invoiceId = await store.insertInvoice({
      threadId: tid, lineItems: [], total: 0, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'discarded'
    });
    const r = await discardInvoice(E, store, invoiceId);
    expect(r.ok).toBe(true);
  });

  it('returns invoice_not_found for unknown id', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const r = await discardInvoice(E, store, 'no-such-id');
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toBe('invoice_not_found');
  });

  it('refuses to discard a paid invoice', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    const tid = await seedThread(store);
    const invoiceId = await store.insertInvoice({
      threadId: tid, lineItems: [], total: 0, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'paid'
    });
    const r = await discardInvoice(E, store, invoiceId);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toBe('cannot_discard_paid_invoice');
  });
});

// ─── (c) searchCatalog scope gate ────────────────────────────────────────────
describe('searchCatalog', () => {
  it('returns reconnect_required when read_products scope is absent', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 'tok', dekWrapped: 'd', scopes: 'write_draft_orders' });
    const r = await searchCatalog(E, store, 'collar');
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toBe('reconnect_required');
  });
});

// ─── (c2) searchCatalog happy path: fetchImpl flows through to Shopify ────────
describe('searchCatalog fetchImpl seam', () => {
  it('passes fetchImpl through to makeAdminGraphql and returns catalog variants', async () => {
    const store = new TenantStore(env.DB, SHOP);
    // Seal a real access token so adminForShop can decrypt it
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    const dekWrapped = await vault.newTenantDek();
    const accessTokenEnc = await vault.seal(dekWrapped, 'shpat_test');
    await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: 'read_products,write_draft_orders' });

    const SEARCH_PAYLOAD = {
      products: {
        edges: [{
          node: {
            id: 'gid://shopify/Product/1', title: 'Dog Collar',
            variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/10', title: 'Red / M', sku: 'C-RED-M', price: '12.50', availableForSale: true } }] }
          }
        }]
      }
    };

    let fetchedUrl = '';
    const mockFetch = (async (url: string | Request | URL) => {
      fetchedUrl = String(url);
      return new Response(JSON.stringify({ data: SEARCH_PAYLOAD }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const r = await searchCatalog(E, store, 'collar', mockFetch);
    expect(r.ok).toBe(true);
    expect((r as { ok: true; variants: unknown[] }).variants).toHaveLength(1);
    // fetchImpl was actually invoked with the Shopify Admin GraphQL URL
    expect(fetchedUrl).toContain('myshopify.com/admin/api');
  });
});

// ─── (e) buildInvoiceForThread happy path ─────────────────────────────────────
describe('buildInvoiceForThread happy path', () => {
  it('sends invoice, ends sent, thread awaiting_customer, total rounded', async () => {
    const store = new TenantStore(env.DB, SHOP);

    // Seal a real access token (vault uses WebCrypto - available in workers test env)
    const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
    const dekWrapped = await vault.newTenantDek();
    const accessTokenEnc = await vault.seal(dekWrapped, 'shpat_test');
    // Intentionally omit read_customers so the customer-lookup branch is skipped
    await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: 'write_draft_orders,read_products' });
    const tid = await seedThread(store);

    // priceGbp 0.1 × qty 3 → rawTotal 0.30000000000000004 before rounding
    const VARIANT_ID = 'gid://shopify/ProductVariant/10';
    const DRAFT_ORDER_ID = 'gid://shopify/DraftOrder/99';
    const INVOICE_URL = 'https://a.myshopify.com/draft_orders/99/invoice';

    const mockFetch = (async (input: string | Request | URL, _init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url));
      if (url.includes('resend.com')) {
        return new Response(JSON.stringify({ id: 'resend-msg-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // Shopify Admin GraphQL - discriminate by query in body
      const body = typeof input !== 'string' && !(input instanceof URL) && (input as Request).body
        ? await (input as Request).clone().text()
        : (_init?.body ? String(_init.body) : '');
      if (body.includes('draftOrderCreate')) {
        return new Response(JSON.stringify({ data: { draftOrderCreate: { draftOrder: { id: DRAFT_ORDER_ID, invoiceUrl: INVOICE_URL }, userErrors: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // nodes query (variantsByIds)
      return new Response(JSON.stringify({ data: { nodes: [{ id: VARIANT_ID, title: 'Red / M', sku: 'C-RED-M', price: '0.10', product: { id: 'gid://shopify/Product/1', title: 'Dog Collar' } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    // RESEND_API_KEY is not bound in the test miniflare env - add it to the cast
    const testEnv = { ...E, RESEND_API_KEY: 'test-resend-key' } as unknown as Env;

    const r = await buildInvoiceForThread(
      testEnv, store, tid,
      [{ variantId: VARIANT_ID, qty: 3 }],
      'Here are your items',
      mockFetch
    );

    expect(r.ok).toBe(true);
    const invoiceId = (r as { ok: true; invoiceId: string }).invoiceId;

    const invoice = await store.getInvoice(invoiceId);
    expect(invoice?.status).toBe('sent');
    // Float drift: 0.1 * 3 = 0.30000000000000004 - rounding must yield 0.3
    expect(invoice?.total).toBe(0.3);

    const got = await store.getThreadWithMessages(tid);
    expect(got?.thread.status).toBe('awaiting_customer');
  });
});

// ─── (d) getInboxThread includes open invoice ─────────────────────────────────
describe('getInboxThread invoice field', () => {
  it('includes open invoice when one exists', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    const tid = await seedThread(store);
    const invoiceId = await store.insertInvoice({
      threadId: tid,
      lineItems: [{ variantId: 'gid://shopify/ProductVariant/1', sku: 'X', title: 'Collar', qty: 1, priceGbp: 9.99 }],
      total: 9.99, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'sent'
    });
    const { getInboxThread } = await import('../src/inbox/routes');
    const r = await getInboxThread(env.DB, SHOP, tid);
    expect(r.ok).toBe(true);
    expect((r as { ok: true; invoice: { id: string } | null }).invoice?.id).toBe(invoiceId);
  });

  it('invoice is null when no open invoice', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const tid = await seedThread(store);
    const { getInboxThread } = await import('../src/inbox/routes');
    const r = await getInboxThread(env.DB, SHOP, tid);
    expect(r.ok).toBe(true);
    expect((r as { ok: true; invoice: unknown }).invoice).toBeNull();
  });
});
