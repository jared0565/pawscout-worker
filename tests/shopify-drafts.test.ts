import { describe, it, expect } from 'vitest';
import { createDraftOrder } from '../src/shopify-drafts';
import { makeAdminGraphql } from '../src/shopify-admin';

function captureAdmin(payload: unknown) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ data: payload }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { admin: makeAdminGraphql('a.myshopify.com', 'tok', f), calls };
}

describe('createDraftOrder', () => {
  it('sends variant-ids-only line items + custom attribute and returns the invoice url', async () => {
    const { admin, calls } = captureAdmin({ draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/9', invoiceUrl: 'https://shop/invoice/abc' }, userErrors: [] } });
    const r = await createDraftOrder(admin, { email: 'c@x.com', customerId: 'gid://shopify/Customer/3', lineItems: [{ variantId: 'gid://shopify/ProductVariant/10', quantity: 2 }], pawscoutInvoiceId: 'inv-1' });
    expect(r).toEqual({ draftOrderId: 'gid://shopify/DraftOrder/9', invoiceUrl: 'https://shop/invoice/abc' });
    const vars = calls[0].variables.input as Record<string, unknown>;
    expect(vars.lineItems).toEqual([{ variantId: 'gid://shopify/ProductVariant/10', quantity: 2 }]); // no price/title fields
    expect(vars.customAttributes).toEqual([{ key: 'pawscout_invoice_id', value: 'inv-1' }]);
    expect(vars.purchasingEntity).toEqual({ customerId: 'gid://shopify/Customer/3' });
  });
  it('throws on a Shopify userError', async () => {
    const { admin } = captureAdmin({ draftOrderCreate: { draftOrder: null, userErrors: [{ field: ['input'], message: 'Variant unavailable' }] } });
    await expect(createDraftOrder(admin, { email: 'c@x.com', lineItems: [{ variantId: 'v', quantity: 1 }], pawscoutInvoiceId: 'inv-2' })).rejects.toThrow(/Variant unavailable/);
  });
});
