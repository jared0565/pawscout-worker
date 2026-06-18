/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { TenantStore } from '../src/tenant-store';
import { attributePaidOrder } from '../src/inbox/attribution';
import type { OrderRecord } from '../src/fulfil';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const order = (over: Partial<OrderRecord>): OrderRecord => ({ shopifyOrderId: 'gid://shopify/Order/55', orderName: '#1', totalPrice: 9.99, currency: 'GBP', financialStatus: 'paid', riskLevel: null, address: null, lineItems: [], noteAttributes: {}, customerEmail: null, ...over });

it('attributes a paid order to its invoice via the custom attribute', async () => {
  const s = new TenantStore(env.DB, 'a.myshopify.com');
  await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
  const tid = await s.createThread({ contactEmail: 'c@x.com', subject: 'x', subjectNorm: 'x', receivedAt: new Date().toISOString(), initialStatus: 'awaiting_customer' });
  const invId = await s.insertInvoice({ threadId: tid, lineItems: [], total: 9.99, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'sent' });
  const r = await attributePaidOrder(s, order({ noteAttributes: { pawscout_invoice_id: invId } }));
  expect(r.converted).toBe(true);
  expect((await s.getInvoice(invId))?.status).toBe('paid');
  expect((await s.getThreadWithMessages(tid))?.thread.status).toBe('converted');
});

it('falls back to email match when no attribute', async () => {
  const s = new TenantStore(env.DB, 'a.myshopify.com');
  await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
  await s.upsertContact({ email: 'c@x.com' });
  const tid = await s.createThread({ contactEmail: 'c@x.com', subject: 'x', subjectNorm: 'x', receivedAt: new Date().toISOString(), initialStatus: 'awaiting_customer' });
  const invId = await s.insertInvoice({ threadId: tid, lineItems: [], total: 5, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'sent' });
  // email lives on the webhook payload, exposed via a customerEmail field — see impl note
  const r = await attributePaidOrder(s, { ...order({}), customerEmail: 'c@x.com' } as never);
  expect(r.converted).toBe(true);
  expect((await s.getInvoice(invId))?.status).toBe('paid');
});

it('no-ops when there is no match', async () => {
  const s = new TenantStore(env.DB, 'a.myshopify.com');
  await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
  expect((await attributePaidOrder(s, order({}))).converted).toBe(false);
});

it('normalises customerEmail to lowercase before email-fallback lookup', async () => {
  const s = new TenantStore(env.DB, 'a.myshopify.com');
  await s.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
  // Contact + invoice stored as lowercase
  await s.upsertContact({ email: 'buyer@x.com' });
  const tid = await s.createThread({ contactEmail: 'buyer@x.com', subject: 'x', subjectNorm: 'x', receivedAt: new Date().toISOString(), initialStatus: 'awaiting_customer' });
  const invId = await s.insertInvoice({ threadId: tid, lineItems: [], total: 10, currency: 'GBP', coverText: '', confidence: null, holdReasons: [], status: 'sent' });
  // Webhook delivers mixed-case email — attribution must normalise before lookup
  const r = await attributePaidOrder(s, { ...order({}), customerEmail: 'Buyer@X.com' } as never);
  expect(r.converted).toBe(true);
  expect((await s.getInvoice(invId))?.status).toBe('paid');
});
