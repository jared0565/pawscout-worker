import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { parseOrderWebhook, validateOrder } from '../src/fulfil';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const CFG: TenantConfig = {
  collectionMap: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' } },
  gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, target: 12
};

const RAW = {
  id: 12345, name: '#1001', total_price: '19.99', currency: 'GBP', financial_status: 'paid',
  shipping_address: { name: 'Jane Doe', address1: '1 High St', city: 'London', zip: 'E1 1AA', country_code: 'GB', phone: '07000000000' },
  line_items: [{ product_id: 100, variant_id: 200, sku: 'S1', quantity: 1, price: '19.99' }]
};

async function seedLink(store: TenantStore) {
  await store.putLink({ cjPid: 'CJ1', state: 'imported', shopifyProductId: 'gid://shopify/Product/100', handle: 'h', category: 'pet-toys' });
}

describe('parseOrderWebhook', () => {
  it('normalises ids, totals, address and line items', () => {
    const o = parseOrderWebhook(RAW);
    expect(o).toMatchObject({ shopifyOrderId: '12345', orderName: '#1001', totalPrice: 19.99, currency: 'GBP', financialStatus: 'paid', riskLevel: null });
    expect(o.address).toMatchObject({ name: 'Jane Doe', address1: '1 High St', city: 'London', zip: 'E1 1AA', countryCode: 'GB' });
    expect(o.lineItems[0]).toMatchObject({ productId: 'gid://shopify/Product/100', variantId: 'gid://shopify/ProductVariant/200', sku: 'S1', quantity: 1, price: 19.99, cjPid: null });
  });
  it('survives a missing address (protected data not granted)', () => {
    const o = parseOrderWebhook({ ...RAW, shipping_address: undefined });
    expect(o.address).toBeNull();
  });
});

describe('validateOrder guardrails', () => {
  it('clears a clean, mapped, paid order and resolves cjPid', async () => {
    const store = new TenantStore(env.DB, SHOP); await seedLink(store);
    const { holds, lineItems } = await validateOrder(parseOrderWebhook(RAW), store, CFG);
    expect(holds).toEqual([]);
    expect(lineItems[0].cjPid).toBe('CJ1');
  });
  it('holds an order with an unmapped line item', async () => {
    const store = new TenantStore(env.DB, SHOP); await seedLink(store);
    const raw = { ...RAW, line_items: [{ product_id: 999, sku: 'X', quantity: 1, price: '5' }] };
    const { holds } = await validateOrder(parseOrderWebhook(raw), store, CFG);
    expect(holds).toContain('unmapped-items');
  });
  it('holds an incomplete address', async () => {
    const store = new TenantStore(env.DB, SHOP); await seedLink(store);
    const raw = { ...RAW, shipping_address: { ...RAW.shipping_address, zip: '' } };
    const { holds } = await validateOrder(parseOrderWebhook(raw), store, CFG);
    expect(holds).toContain('incomplete-address');
  });
  it('holds a HIGH fraud-risk order and an over-threshold order', async () => {
    const store = new TenantStore(env.DB, SHOP); await seedLink(store);
    const raw = { ...RAW, risk_level: 'high', total_price: '150.00' };
    const { holds } = await validateOrder(parseOrderWebhook(raw), store, CFG);
    expect(holds).toContain('high-risk');
    expect(holds).toContain('over-threshold');
  });
  it('holds an unpaid order', async () => {
    const store = new TenantStore(env.DB, SHOP); await seedLink(store);
    const { holds } = await validateOrder(parseOrderWebhook({ ...RAW, financial_status: 'pending' }), store, CFG);
    expect(holds).toContain('not-paid');
  });
});

describe('order store', () => {
  it('insertOrderIfNew is idempotent (webhook retry safe)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const base = { shopifyOrderId: '1', orderName: '#1', totalPrice: 10, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'queued' as const, holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null };
    expect(await store.insertOrderIfNew(base)).toBe(true);
    expect(await store.insertOrderIfNew(base)).toBe(false); // already received
  });

  it('dueQueuedOrders returns only queued orders past the grace window', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await store.insertOrderIfNew({ shopifyOrderId: 'due', orderName: null, totalPrice: 10, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'queued', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: past });
    await store.insertOrderIfNew({ shopifyOrderId: 'waiting', orderName: null, totalPrice: 10, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'queued', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: future });
    await store.insertOrderIfNew({ shopifyOrderId: 'held', orderName: null, totalPrice: 10, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'held', holdReasons: ['x'], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    const due = await store.dueQueuedOrders(new Date().toISOString());
    expect(due.map((o) => o.shopify_order_id)).toEqual(['due']);
  });

  it('updateOrder transitions status and records the CJ order id', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.insertOrderIfNew({ shopifyOrderId: '1', orderName: null, totalPrice: 10, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'queued', holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null });
    await store.updateOrder('1', { status: 'submitted', cj_order_id: 'CJ-ORD-9' });
    const o = await store.getOrder('1');
    expect(o).toMatchObject({ status: 'submitted', cj_order_id: 'CJ-ORD-9' });
    expect((await store.listOrders('submitted')).length).toBe(1);
    expect((await store.listOrders('queued')).length).toBe(0);
  });
});
