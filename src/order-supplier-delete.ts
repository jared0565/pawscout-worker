import type { TenantStore, OrderRow } from './tenant-store';
import type { CjClient } from './cj';

// "Delete at CJ" (owner 2026-10-09): removes a cancelled order's supplier
// order at CJ, so it can never be paid by mistake. Before this the owner had
// to do it in CJ's dashboard, and an order left there stayed on a never-pay
// list (#1002 and #1003, 2026-10-08).
//
// CJ's Order Delete takes only an order that is CREATED or IN_CART and cannot
// be undone, so every check that can refuse runs before it: the row must be
// cancelled and not marked paid by the owner, and CJ must still hold a live,
// unpaid order under exactly this order number. The order is looked up by the
// number PawScout gave CJ, not by a recorded id, because a failed create can
// leave a supplier order PawScout never recorded (#1002).

export type SupplierOrderDeleter = Pick<CjClient, 'findOrderByNumber' | 'deleteOrder'>;

export type SupplierDeleteResult =
  | { ok: true; cjOrderId: string; before: string; after: string | null; readBack: boolean }
  | { ok: false; code: 409 | 502; error: string };

const DELETABLE: ReadonlySet<string> = new Set(['CREATED', 'IN_CART']);
const GONE: ReadonlySet<string> = new Set(['CANCELLED', 'TRASH']);

/** Why this row's supplier order may not be deleted, from the row alone; null
 *  when CJ may be asked. Checked before any call to CJ. */
export function supplierDeleteRefusal(order: OrderRow): string | null {
  if (order.status !== 'cancelled') return "Only a cancelled order's supplier order can be deleted at CJ. Cancel the order first.";
  if (order.owner_paid_at) return 'You marked this order as paid at the supplier, and CJ does not delete a paid order. Ask CJ to cancel and refund it.';
  return null;
}

export async function deleteSupplierOrder(store: TenantStore, cj: SupplierOrderDeleter, order: OrderRow): Promise<SupplierDeleteResult> {
  const refusal = supplierDeleteRefusal(order);
  if (refusal) return { ok: false, code: 409, error: refusal };
  const number = order.shopify_order_id;

  let found: Awaited<ReturnType<SupplierOrderDeleter['findOrderByNumber']>>;
  try {
    found = await cj.findOrderByNumber(number);
  } catch (e) {
    return { ok: false, code: 502, error: `Could not read the order at CJ (${(e as Error).message}), so nothing was deleted. Try again.` };
  }
  if (!found) return { ok: false, code: 409, error: `CJ holds no order under order number ${number}, so there is nothing to delete.` };
  if (found.orderNum !== number) return { ok: false, code: 409, error: `CJ answered with order number ${found.orderNum || 'none'}, not ${number}, so nothing was deleted.` };
  const status = found.status.toUpperCase();
  if (GONE.has(status)) return { ok: false, code: 409, error: `CJ already shows this order as ${status}, so there is nothing to delete.` };
  if (found.paymentDate) return { ok: false, code: 409, error: `CJ shows a payment on this order (${found.paymentDate}), so it cannot be deleted. Ask CJ to cancel and refund it.` };
  if (!DELETABLE.has(status)) {
    return { ok: false, code: 409, error: `CJ shows this order as ${status || 'no status'}, and CJ deletes only an order that is CREATED or IN_CART. Cancel it in CJ's dashboard instead.` };
  }
  if (!found.numericId) return { ok: false, code: 409, error: "CJ's answer carries no order id to delete it by, so nothing was deleted." };

  try {
    await cj.deleteOrder(found.numericId);
  } catch (e) {
    return { ok: false, code: 502, error: `CJ refused the delete: ${(e as Error).message}. Nothing changed in PawScout.` };
  }
  await store.addOrderEvent(number, 'supplier-order-deleted', found.cjOrderId);

  // What CJ shows now. CJ has already accepted the delete, so a read that
  // fails changes nothing; the console says it could not be confirmed.
  try {
    const after = await cj.findOrderByNumber(number);
    return { ok: true, cjOrderId: found.cjOrderId, before: status, after: after ? after.status.toUpperCase() : null, readBack: true };
  } catch {
    return { ok: true, cjOrderId: found.cjOrderId, before: status, after: null, readBack: false };
  }
}
