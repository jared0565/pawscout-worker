/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { sendInvoice } from '../src/inbox/send-invoice';
import type { InvoiceRow, ThreadRow } from '../src/inbox/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

it('emails the invoice link, records outbound, flips invoice + thread', async () => {
  const s = new TenantStore(env.DB, 'a.myshopify.com');
  await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
  const tid = await s.createThread({ contactEmail: 'c@x.com', subject: 'Collars?', subjectNorm: 'collars', receivedAt: new Date().toISOString(), initialStatus: 'needs_reply' });
  const invId = await s.insertInvoice({ threadId: tid, lineItems: [{ variantId: 'v', sku: 'C1', title: 'Collar', qty: 1, priceGbp: 9.99 }], total: 9.99, currency: 'GBP', coverText: 'Your collar', confidence: 90, holdReasons: [], status: 'proposed' });
  await s.setInvoiceStatus(invId, 'proposed', { invoiceUrl: 'https://shop/invoice/abc', draftOrderId: 'gid://shopify/DraftOrder/9' });
  const thread = (await s.getThreadWithMessages(tid))!.thread as ThreadRow;
  const invoice = (await s.getInvoice(invId))! as InvoiceRow;

  const calls: string[] = [];
  const fetchMock = vi.fn(async (_u: string, init: RequestInit) => { calls.push(String(init.body)); return new Response(JSON.stringify({ id: 'rs_1' }), { status: 200 }); }) as unknown as typeof fetch;
  const r = await sendInvoice({ ...env, RESEND_API_KEY: 'k' } as never, s, thread, invoice, fetchMock);
  expect(r.ok).toBe(true);
  expect(calls[0]).toContain('https://shop/invoice/abc');           // link embedded
  expect((await s.getInvoice(invId))?.status).toBe('sent');
  expect((await s.getThreadWithMessages(tid))?.thread.status).toBe('awaiting_customer');
});
