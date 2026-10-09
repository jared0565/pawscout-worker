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
//
// CJ accepting the delete is not taken as proof it took. The order is read
// back, and the trail says supplier-order-deleted only when CJ shows this same
// order as TRASH or CANCELLED; anything else is recorded as unconfirmed. An
// order CJ already shows that way is recorded as supplier-order-gone. Either
// record takes the button off the order's row in the console.

export type SupplierOrderDeleter = Pick<CjClient, 'findOrderByNumber' | 'deleteOrder'>;

export type SupplierDeleteResult =
  | { ok: true; cjOrderId: string; before: string; after: string }
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
  if (GONE.has(status)) {
    // Nothing is sent, but the trail records what CJ showed, so the console
    // stops offering the button. #1001 was put in TRASH by hand at CJ, and a
    // press after an unconfirmed delete can find it gone by then.
    await store.addOrderEvent(number, 'supplier-order-gone', `${found.cjOrderId} ${status}`);
    return { ok: false, code: 409, error: `CJ already shows this order as ${status}, so there is nothing to delete.` };
  }
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

  // What CJ shows now. At first use (2026-10-09) both deleted orders still
  // answered under every id, as TRASH, so an order CJ no longer finds is not
  // what a delete looks like either. The trail gets the reason in fixed words,
  // never CJ's own text; the owner sees CJ's text in the answer.
  const deleted = found.cjOrderId;
  const unconfirmed = async (note: string, seen: string): Promise<SupplierDeleteResult> => {
    await store.addOrderEvent(number, 'supplier-delete-unconfirmed', `${deleted} ${note}`);
    return { ok: false, code: 502, error: `CJ accepted the delete of ${deleted}, but ${seen}, so PawScout has not recorded it as deleted. Check it in CJ's dashboard.` };
  };
  let after: Awaited<ReturnType<SupplierOrderDeleter['findOrderByNumber']>>;
  try {
    after = await cj.findOrderByNumber(number);
  } catch (e) {
    return unconfirmed('read-back failed', `reading it back failed (${(e as Error).message})`);
  }
  if (!after) return unconfirmed('not found', `reading it back found no order under order number ${number}`);
  if (after.orderNum !== number || after.cjOrderId !== deleted) {
    return unconfirmed('answered as another order', `reading it back answered ${after.cjOrderId || 'no id'} under order number ${after.orderNum || 'none'}`);
  }
  const now = after.status.toUpperCase();
  if (!GONE.has(now)) return unconfirmed(`still ${now || 'no status'}`, `it still shows as ${now || 'no status'}`);
  await store.addOrderEvent(number, 'supplier-order-deleted', deleted);
  return { ok: true, cjOrderId: deleted, before: status, after: now };
}
