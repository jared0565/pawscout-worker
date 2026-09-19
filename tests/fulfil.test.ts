import { describe, it, expect, beforeEach } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { parseOrderWebhook, validateOrder, riskHold, MEDIUM_RISK_REVIEW_THRESHOLD_GBP } from '../src/fulfil';
import { TenantStore } from '../src/tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_INBOX, type TenantConfig } from '../src/types';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

const SHOP = 'a.myshopify.com';
const CFG: TenantConfig = {
  collectionMap: { 'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' } },
  gates: DEFAULT_GATES, pricing: DEFAULT_PRICING, floors: DEFAULT_FLOORS, llm: DEFAULT_LLM, addons: DEFAULT_ADDONS, fulfil: DEFAULT_FULFIL, inbox: DEFAULT_INBOX, target: 12
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
  it('captures note_attributes as a record and customerEmail from the payload', () => {
    const o = parseOrderWebhook({ ...RAW, note_attributes: [{ name: 'pawscout_invoice_id', value: 'inv-1' }], email: 'c@x.com' });
    expect(o.noteAttributes.pawscout_invoice_id).toBe('inv-1');
    expect(o.customerEmail).toBe('c@x.com');
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

  it('listUnsettledSupplierOrders and countUnsettledSupplierOrders read only awaiting-payment, held and error rows that carry a supplier order', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const base = { orderName: null, totalPrice: 10, currency: 'GBP', financialStatus: 'paid', riskLevel: null, holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null };
    await store.insertOrderIfNew({ ...base, shopifyOrderId: 'unpaid', status: 'queued' });
    await store.updateOrder('unpaid', { status: 'awaiting-payment', cj_order_id: 'CJ-1' });
    await store.insertOrderIfNew({ ...base, shopifyOrderId: 'stuck-held', status: 'queued' });
    await store.updateOrder('stuck-held', { status: 'held', cj_order_id: 'CJ-2' });
    await store.insertOrderIfNew({ ...base, shopifyOrderId: 'stuck-error', status: 'queued' });
    await store.updateOrder('stuck-error', { status: 'error', cj_order_id: 'CJ-3' });
    await store.insertOrderIfNew({ ...base, shopifyOrderId: 'no-supplier-order', status: 'awaiting-payment' });
    await store.insertOrderIfNew({ ...base, shopifyOrderId: 'done', status: 'queued' });
    await store.updateOrder('done', { status: 'fulfilled', cj_order_id: 'CJ-4' });
    await store.insertOrderIfNew({ ...base, shopifyOrderId: 'still-queued', status: 'queued' });

    const rows = await store.listUnsettledSupplierOrders(20, 0);
    expect(rows.map((r) => r.shopify_order_id).sort()).toEqual(['stuck-error', 'stuck-held', 'unpaid']);
    expect(await store.countUnsettledSupplierOrders()).toBe(3);
  });

  it('listUnsettledSupplierOrders orders oldest first by created_at, then by order id, and honours limit/offset', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const base = { orderName: null, totalPrice: 10, currency: 'GBP', financialStatus: 'paid', riskLevel: null, holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null };
    for (const id of ['b', 'a', 'c-later']) {
      await store.insertOrderIfNew({ ...base, shopifyOrderId: id, status: 'awaiting-payment' });
      await store.updateOrder(id, { cj_order_id: 'CJ-' + id });
    }
    // Pin created_at directly so the ordering is deterministic: 'a' and 'b' tie
    // (tie-break falls to shopify_order_id), 'c-later' is strictly newest.
    await env.DB.prepare(`UPDATE orders SET created_at = ?2 WHERE shop = ?1 AND shopify_order_id IN ('a', 'b')`).bind(SHOP, '2026-01-01T00:00:00.000Z').run();
    await env.DB.prepare(`UPDATE orders SET created_at = ?2 WHERE shop = ?1 AND shopify_order_id = 'c-later'`).bind(SHOP, '2026-01-02T00:00:00.000Z').run();

    const rows = await store.listUnsettledSupplierOrders(20, 0);
    expect(rows.map((r) => r.shopify_order_id)).toEqual(['a', 'b', 'c-later']);
    expect((await store.listUnsettledSupplierOrders(2, 0)).map((r) => r.shopify_order_id)).toEqual(['a', 'b']);
    expect((await store.listUnsettledSupplierOrders(2, 2)).map((r) => r.shopify_order_id)).toEqual(['c-later']);
  });

  it('listUnsettledSupplierOrders and countUnsettledSupplierOrders never return another shop\'s rows', async () => {
    const store = new TenantStore(env.DB, SHOP);
    const other = new TenantStore(env.DB, 'other-shop.myshopify.com');
    const base = { orderName: null, totalPrice: 10, currency: 'GBP', financialStatus: 'paid', riskLevel: null, holdReasons: [], addressJson: null, lineItemsJson: null, fulfilAfter: null };
    await store.insertOrderIfNew({ ...base, shopifyOrderId: 'mine', status: 'awaiting-payment' });
    await store.updateOrder('mine', { cj_order_id: 'CJ-MINE' });
    await other.insertOrderIfNew({ ...base, shopifyOrderId: 'theirs', status: 'awaiting-payment' });
    await other.updateOrder('theirs', { cj_order_id: 'CJ-THEIRS' });

    const rows = await store.listUnsettledSupplierOrders(20, 0);
    expect(rows.map((r) => r.shopify_order_id)).toEqual(['mine']);
    expect(await store.countUnsettledSupplierOrders()).toBe(1);
  });
});

describe('GDPR redaction', () => {
  async function seedOrder(store: TenantStore, id: string) {
    await store.insertOrderIfNew({ shopifyOrderId: id, orderName: '#' + id, totalPrice: 10, currency: 'GBP', financialStatus: 'paid', riskLevel: null, status: 'queued', holdReasons: [], addressJson: '{"name":"Jane"}', lineItemsJson: null, fulfilAfter: null });
  }

  it('customers/redact erases only the named orders', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await seedOrder(store, 'keep'); await seedOrder(store, 'gone1'); await seedOrder(store, 'gone2');
    const removed = await store.redactOrders(['gone1', 'gone2']);
    expect(removed).toBe(2);
    expect(await store.getOrder('gone1')).toBeNull();
    expect(await store.getOrder('keep')).not.toBeNull();
  });

  it('shop/redact purges all shop data (orders, links, config, tenant)', async () => {
    const store = new TenantStore(env.DB, SHOP);
    await store.upsertTenant({ accessTokenEnc: 't', dekWrapped: 'd', scopes: 's' });
    await store.putLink({ cjPid: 'P1', state: 'imported', shopifyProductId: 'gid://1', handle: 'h', category: 'pet-toys' });
    await seedOrder(store, 'o1');
    // GDPR: answer_memory stores customers' verbatim question text and must
    // be wiped along with everything else on a shop/redact.
    await store.upsertAnswerMemory({
      qhash: 'qh1', category: 'other', questionText: 'Do you ship worldwide?', questionNorm: 'ship worldwide',
      answerText: 'Yes.', threadId: 't1', at: '2026-06-18T11:05:00Z'
    });
    await store.redactShop();
    expect(await store.getOrder('o1')).toBeNull();
    expect(await store.getLink('P1')).toBeNull();
    expect(await store.getTenant()).toBeNull();
    expect((await store.listAnswerMemory()).total).toBe(0);
  });
});

describe('riskHold (Stage-B fraud gate policy, 2026-07-19)', () => {
  it('CANCEL recommendation always holds, regardless of value', () => {
    expect(riskHold('CANCEL', 5)).toBe('high-risk');
    expect(riskHold('CANCEL', 500)).toBe('high-risk');
  });
  it('INVESTIGATE holds only above the medium-risk value threshold', () => {
    expect(riskHold('INVESTIGATE', MEDIUM_RISK_REVIEW_THRESHOLD_GBP + 0.01)).toBe('medium-risk-value');
    expect(riskHold('INVESTIGATE', MEDIUM_RISK_REVIEW_THRESHOLD_GBP)).toBeNull(); // at the line = flows
    expect(riskHold('INVESTIGATE', 9.99)).toBeNull();
  });
  it('ACCEPT / NONE / unknown never hold (fail-open: the GBP100 cap still bounds worst case)', () => {
    expect(riskHold('ACCEPT', 500)).toBeNull();
    expect(riskHold('NONE', 500)).toBeNull();
    expect(riskHold(null, 500)).toBeNull();
  });
});
