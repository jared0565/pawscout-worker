import type { AdminGraphql } from './shopify-admin';

const CREATE = `mutation pawscoutDraft($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id invoiceUrl }
    userErrors { field message }
  }
}`;

export async function createDraftOrder(
  admin: AdminGraphql,
  input: { email: string; customerId?: string; lineItems: { variantId: string; quantity: number }[]; pawscoutInvoiceId: string }
): Promise<{ draftOrderId: string; invoiceUrl: string }> {
  const draftInput: Record<string, unknown> = {
    email: input.email,
    lineItems: input.lineItems.map((li) => ({ variantId: li.variantId, quantity: li.quantity })), // variant IDs only; Shopify prices
    customAttributes: [{ key: 'pawscout_invoice_id', value: input.pawscoutInvoiceId }]
  };
  if (input.customerId) draftInput.purchasingEntity = { customerId: input.customerId };
  const data = await admin(CREATE, { input: draftInput });
  const res = (data.draftOrderCreate ?? {}) as { draftOrder?: { id: string; invoiceUrl: string }; userErrors?: { message: string }[] };
  if (res.userErrors?.length) throw new Error(res.userErrors.map((e) => e.message).join('; '));
  if (!res.draftOrder?.id || !res.draftOrder.invoiceUrl) throw new Error('draftOrderCreate returned no draft order / invoice url');
  return { draftOrderId: res.draftOrder.id, invoiceUrl: res.draftOrder.invoiceUrl };
}
