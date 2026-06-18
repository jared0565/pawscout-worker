import { Vault } from '../vault';
import { TenantStore } from '../tenant-store';
import { makeAdminGraphql, type AdminGraphql } from '../shopify-admin';
import { hasScope } from './scopes';
import { searchShopifyProducts, variantsByIds, findCustomerByEmail } from '../shopify-catalog';
import { createDraftOrder } from '../shopify-drafts';
import { sendInvoice } from './send-invoice';
import type { Env } from '../types';
import type { InvoiceLineItem } from './types';

export type { AdminGraphql };

/**
 * Build and return an authenticated Admin GraphQL client for the shop stored in
 * `store`. Returns null when the tenant row is missing or has no token.
 */
export async function adminForShop(env: Env, store: TenantStore): Promise<AdminGraphql | null> {
  const tenant = await store.getTenant();
  if (!tenant?.access_token_enc || !tenant.dek_wrapped) return null;
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  return makeAdminGraphql(store.shop, accessToken);
}

/**
 * Search the Shopify catalog (products + variants) for the given query.
 * Requires the tenant to have the `read_products` scope; returns
 * `{ ok:false, error:'reconnect_required' }` when missing.
 */
export async function searchCatalog(
  env: Env,
  store: TenantStore,
  query: string
): Promise<{ ok: true; variants: Awaited<ReturnType<typeof searchShopifyProducts>> } | { ok: false; error: string }> {
  const tenant = await store.getTenant();
  if (!hasScope(tenant?.scopes, 'read_products')) return { ok: false, error: 'reconnect_required' };
  const admin = await adminForShop(env, store);
  if (!admin) return { ok: false, error: 'not_installed' };
  try {
    const variants = await searchShopifyProducts(admin, query);
    return { ok: true, variants };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Build a draft invoice for the given thread from owner-picked variant+qty items:
 * 1. Scope-check `write_draft_orders` — return `reconnect_required` if absent.
 * 2. Resolve variant ids → titles/prices via `variantsByIds`.
 * 3. Insert `inbox_invoices` row (status `proposed`).
 * 4. Create a Shopify draft order (gets `invoiceUrl`).
 * 5. Update the invoice row with `draftOrderId` + `invoiceUrl`.
 * 6. Send the invoice email (which flips status to `sent`).
 * On any Shopify failure after insert → mark the invoice `failed` and surface the error.
 */
export async function buildInvoiceForThread(
  env: Env,
  store: TenantStore,
  threadId: string,
  items: { variantId: string; qty: number }[],
  coverText: string
): Promise<{ ok: true; invoiceId: string } | { ok: false; error: string }> {
  // Scope gate — must check before any vault call
  const tenant = await store.getTenant();
  if (!hasScope(tenant?.scopes, 'write_draft_orders')) {
    return { ok: false, error: 'reconnect_required' };
  }

  const admin = await adminForShop(env, store);
  if (!admin) return { ok: false, error: 'not_installed' };

  // Resolve variant ids to full catalog data
  const uniqueIds = [...new Set(items.map((i) => i.variantId))];
  let resolved: Awaited<ReturnType<typeof variantsByIds>>;
  try {
    resolved = await variantsByIds(admin, uniqueIds);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const byId = new Map(resolved.map((v) => [v.variantId, v]));
  for (const item of items) {
    if (!byId.has(item.variantId)) {
      return { ok: false, error: `unknown_variant:${item.variantId}` };
    }
  }

  // Build line items and total
  const lineItems: InvoiceLineItem[] = items.map((item) => {
    const v = byId.get(item.variantId)!;
    return { variantId: item.variantId, sku: v.sku, title: v.title || v.variantTitle, qty: item.qty, priceGbp: v.priceGbp };
  });
  const total = lineItems.reduce((sum, li) => sum + li.priceGbp * li.qty, 0);

  // Insert invoice row in proposed state
  const invoiceId = await store.insertInvoice({
    threadId, lineItems, total, currency: 'GBP', coverText, confidence: null, holdReasons: [], status: 'proposed'
  });

  // Resolve the thread + customer email
  const got = await store.getThreadWithMessages(threadId);
  if (!got) {
    await store.setInvoiceStatus(invoiceId, 'failed');
    return { ok: false, error: 'thread_not_found' };
  }
  const email = got.thread.contact_email;

  // Optionally link Shopify customer (skip silently when read_customers is missing)
  let customerId: string | undefined;
  if (hasScope(tenant?.scopes, 'read_customers')) {
    try {
      const contact = await store.getContactByEmail(email);
      if (contact?.shopify_customer_id) {
        customerId = contact.shopify_customer_id;
      } else {
        const found = await findCustomerByEmail(admin, email);
        if (found) {
          await store.linkContactToShopifyCustomer(email, found.customerId);
          customerId = found.customerId;
        }
      }
    } catch {
      // customer linking is best-effort; never fail the invoice over it
    }
  }

  // Create Shopify draft order
  let draftOrderId: string;
  let invoiceUrl: string;
  try {
    const draft = await createDraftOrder(admin, {
      email,
      customerId,
      lineItems: lineItems.map((li) => ({ variantId: li.variantId, quantity: li.qty })),
      pawscoutInvoiceId: invoiceId
    });
    draftOrderId = draft.draftOrderId;
    invoiceUrl = draft.invoiceUrl;
  } catch (e) {
    await store.setInvoiceStatus(invoiceId, 'failed');
    return { ok: false, error: (e as Error).message };
  }

  // Update invoice with draft order info
  await store.setInvoiceStatus(invoiceId, 'proposed', { draftOrderId, invoiceUrl });

  // Send the invoice email (also flips status to 'sent')
  const invoice = await store.getInvoice(invoiceId);
  if (!invoice) {
    await store.setInvoiceStatus(invoiceId, 'failed');
    return { ok: false, error: 'invoice_not_found_after_insert' };
  }

  try {
    const sendResult = await sendInvoice(env, store, got.thread, invoice);
    if (!sendResult.ok) {
      await store.setInvoiceStatus(invoiceId, 'failed');
      return { ok: false, error: sendResult.error ?? 'send_failed' };
    }
  } catch (e) {
    await store.setInvoiceStatus(invoiceId, 'failed');
    return { ok: false, error: (e as Error).message };
  }

  return { ok: true, invoiceId };
}

/**
 * Discard a proposed or sent invoice — marks it `discarded`.
 * Does NOT close the thread (the thread may still have ongoing conversation).
 */
export async function discardInvoice(
  env: Env,
  store: TenantStore,
  invoiceId: string
): Promise<{ ok: boolean; error?: string }> {
  void env; // not used — kept in signature for symmetry and future auth checks
  const invoice = await store.getInvoice(invoiceId);
  if (!invoice) return { ok: false, error: 'invoice_not_found' };
  if (invoice.status === 'discarded') return { ok: true }; // idempotent
  if (invoice.status === 'paid') return { ok: false, error: 'cannot_discard_paid_invoice' };
  await store.setInvoiceStatus(invoiceId, 'discarded');
  return { ok: true };
}
