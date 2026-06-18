/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { buildInvoiceForThread, discardInvoice, searchCatalog } from '../src/inbox/invoice-routes';
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
    // Install tenant without write_draft_orders — scope gate must short-circuit
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
