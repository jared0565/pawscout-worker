import type { TenantStore } from '../tenant-store';
import type { OrderRecord } from '../fulfil';

/** Best-effort: link a paid order to its inbox invoice/thread. Idempotent, never throws. */
export async function attributePaidOrder(store: TenantStore, order: OrderRecord): Promise<{ converted: boolean }> {
  try {
    let invoice = null as Awaited<ReturnType<TenantStore['getInvoice']>>;
    const pid = order.noteAttributes?.pawscout_invoice_id;
    if (pid) invoice = await store.getInvoiceByPawscoutId(pid);
    if (!invoice && order.customerEmail) {
      const normalizedEmail = order.customerEmail.trim().toLowerCase();
      const contact = await store.getContactByEmail(normalizedEmail);
      if (contact) {
        // most-recent open ('sent') invoice on any of this contact's threads
        invoice = await store.getOpenInvoiceForContact(normalizedEmail);
      }
    }
    if (!invoice) return { converted: false };
    if (invoice.status === 'paid') return { converted: true };          // idempotent
    await store.setInvoiceStatus(invoice.id, 'paid', { paidAt: new Date().toISOString(), shopifyOrderId: order.shopifyOrderId });
    await store.setThreadStatus(invoice.thread_id, 'converted');
    return { converted: true };
  } catch (e) {
    console.warn(`inbox attribution failed: ${(e as Error).message}`);
    return { converted: false };
  }
}
