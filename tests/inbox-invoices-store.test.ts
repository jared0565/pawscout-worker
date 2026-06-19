/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

describe('inbox_invoices store', () => {
  it('inserts, reads, finds open, attributes by order, counts recent', async () => {
    const s = new TenantStore(env.DB, 'a.myshopify.com');
    await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    const id = await s.insertInvoice({ threadId: 'th1', lineItems: [{ variantId: 'gid://shopify/ProductVariant/1', sku: 'X', title: 'Collar', qty: 2, priceGbp: 9.99 }], total: 19.98, currency: 'GBP', coverText: 'Here you go', confidence: 90, holdReasons: [], status: 'sent' });
    const got = await s.getInvoice(id);
    expect(got?.thread_id).toBe('th1');
    expect(JSON.parse(got!.line_items_json)[0].qty).toBe(2);
    expect((await s.getOpenInvoiceForThread('th1'))?.id).toBe(id);

    await s.setInvoiceStatus(id, 'paid', { paidAt: '2026-06-18T00:00:00Z', shopifyOrderId: 'gid://shopify/Order/55' });
    expect(await s.getOpenInvoiceForThread('th1')).toBeNull();          // no longer 'sent'
    expect((await s.getInvoiceByOrderId('gid://shopify/Order/55'))?.id).toBe(id);

    const since = new Date(Date.now() - 86400_000).toISOString();
    expect(await s.recentInvoiceCount('th1', since)).toBeGreaterThanOrEqual(1);
  });

  it('scopes invoices to shop', async () => {
    const a = new TenantStore(env.DB, 'a.myshopify.com');
    await a.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    await a.insertInvoice({ threadId: 'th9', lineItems: [], total: 5, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'proposed' });
    const b = new TenantStore(env.DB, 'b.myshopify.com');
    expect(await b.getOpenInvoiceForThread('th9')).toBeNull();
  });

  it('hasRecentFailedInvoice: true within window, false outside, false for non-failed', async () => {
    const s = new TenantStore(env.DB, 'a.myshopify.com');
    await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    await s.insertInvoice({ threadId: 'thF', lineItems: [], total: 5, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'failed' });
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(await s.hasRecentFailedInvoice('thF', past)).toBe(true);     // failed row created after `past`
    expect(await s.hasRecentFailedInvoice('thF', future)).toBe(false);  // created before `future` → outside backoff window
    // a non-failed invoice is never a backoff signal
    await s.insertInvoice({ threadId: 'thS', lineItems: [], total: 5, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'sent' });
    expect(await s.hasRecentFailedInvoice('thS', past)).toBe(false);
  });
});
