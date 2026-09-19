import type { TenantStore, OrderRow } from './tenant-store';

// Task 4 (Phase 2 part 1, "close the holes"): decide what happens to our
// order row when Shopify reports a cancel or a refund, and whether the
// owner needs to be told about it. Pure decision logic against the store -
// no network and no email here, the caller (a later task) sends the alert.

export interface OwnerAlert { subject: string; text: string }

export interface CancelOutcome { changed: boolean; alert: OwnerAlert | null }

/** Order id from an orders/cancelled payload ('' when absent). */
export function cancelledOrderId(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const id = (raw as Record<string, unknown>).id;
  if (typeof id === 'number') return String(id);
  if (typeof id === 'string') return id;
  return '';
}

/** Order id, refund id and refunded amount from a refunds/create payload. */
export function refundInfo(raw: unknown): { orderId: string; refundId: string; amount: number; currency: string } {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawOrderId = body.order_id;
  const orderId = typeof rawOrderId === 'number' ? String(rawOrderId) : typeof rawOrderId === 'string' ? rawOrderId : '';
  const rawRefundId = body.id;
  const refundId = rawRefundId === undefined || rawRefundId === null ? '' : String(rawRefundId);
  const transactions = Array.isArray(body.transactions) ? body.transactions : [];
  let amount = 0;
  let currency = '';
  for (const t of transactions) {
    if (!t || typeof t !== 'object') continue;
    const tx = t as Record<string, unknown>;
    if (tx.kind !== 'refund') continue;
    const rawAmount = tx.amount;
    const n = typeof rawAmount === 'string' ? parseFloat(rawAmount) : typeof rawAmount === 'number' ? rawAmount : 0;
    if (Number.isFinite(n)) amount += n;
    if (currency === '' && typeof tx.currency === 'string') currency = tx.currency;
  }
  return { orderId, refundId, amount, currency };
}

function displayName(order: OrderRow): string {
  return order.order_name ?? order.shopify_order_id;
}

const NOT_RECORDED = '(not recorded)';

/**
 * Decide the effect of a Shopify order/cancelled webhook on our row.
 * No row: nothing happens. Otherwise dedupe on the trail, not on status: a
 * redelivered webhook is a no-op once the order's trail already holds a
 * cancel-received event (this is what lets a 'fulfilled' row, which never
 * changes status, still get exactly one alert across any number of
 * deliveries). On the first delivery, every status becomes 'cancelled'
 * except 'fulfilled' and 'cancelled' itself, which are left as-is (a
 * shipped order is a return, not an undo; an already-cancelled row has
 * nothing left to change). 'awaiting-payment', 'submitted' and 'fulfilled'
 * also raise an owner alert on that first delivery; the rest do not.
 */
export async function applyCancel(store: TenantStore, shopifyOrderId: string): Promise<CancelOutcome> {
  const order = await store.getOrder(shopifyOrderId);
  if (!order) return { changed: false, alert: null };

  const trail = await store.listOrderEvents(shopifyOrderId);
  if (trail.some((e) => e.kind === 'cancel-received')) return { changed: false, alert: null };

  const name = displayName(order);
  let alert: OwnerAlert | null = null;

  if (order.status === 'awaiting-payment') {
    const cj = order.cj_order_id ?? NOT_RECORDED;
    alert = {
      subject: `Order ${name} was cancelled: do NOT pay the supplier`,
      text: `Order ${name} was cancelled in Shopify. Supplier order ${cj} was created for it and is still unpaid. Do NOT pay it. Cancel it at the supplier. Nothing has been spent.`
    };
  } else if (order.status === 'submitted') {
    const cj = order.cj_order_id ?? NOT_RECORDED;
    alert = {
      subject: `Order ${name} was cancelled after it was paid at the supplier`,
      text: `Order ${name} was cancelled in Shopify after supplier order ${cj} was paid. Ask the supplier to cancel it if it has not shipped. If it has shipped, this is a return.`
    };
  } else if (order.status === 'fulfilled') {
    const tracking = order.tracking_number ?? NOT_RECORDED;
    alert = {
      subject: `Order ${name} was cancelled after it shipped`,
      text: `Order ${name} was cancelled in Shopify after it shipped (tracking ${tracking}). Treat it as a return.`
    };
  }

  if (order.status !== 'fulfilled' && order.status !== 'cancelled') {
    await store.updateOrder(shopifyOrderId, { status: 'cancelled', hold_reasons: JSON.stringify(['shopify-cancelled']) });
  }
  await store.addOrderEvent(shopifyOrderId, 'cancel-received');
  if (alert) await store.addOrderEvent(shopifyOrderId, 'owner-alerted');

  return { changed: true, alert };
}

/** The refund-received event's detail: 'refund <id>: <currency> <amount>',
 *  using the word 'unknown' in place of the id when Shopify sent none. */
function refundReceivedDetail(refundId: string, currency: string, amount: number): string {
  return `refund ${refundId || 'unknown'}: ${currency} ${amount.toFixed(2)}`;
}

/**
 * Decide the effect of a Shopify refunds/create webhook on our row.
 * No row: nothing happens. Otherwise dedupe on the trail: skip (write
 * nothing, alert nothing) when the trail already holds a refund-received
 * event for this refund's id, read from the WHOLE trail rather than just
 * the last event, so a third or later redelivery is still caught (unlike a
 * tail-only check, which a row's own unconditional refund-received write
 * would otherwise defeat on the very next delivery). When the payload carried
 * no refund id, fall back to an exact match on the detail about to be
 * written, since there is no better identity to key on.
 * Once past the dedupe check, a refund-received event is ALWAYS written for
 * a row that exists, so the trail never has a silent gap - even a row with
 * nothing else to do (already cancelled, or no supplier order and an
 * unlisted status) still records that Shopify reported the refund. Then:
 * a cancelled row is left alone with no alert (the cancel already told the
 * owner what to do); a row with no supplier order yet, in a pre-spend
 * status, is put on hold, no alert needed (no money has left our side); a
 * row with a supplier order already created (any other status) is left
 * alone but raises an owner alert.
 */
export async function applyRefund(
  store: TenantStore,
  info: { orderId: string; refundId: string; amount: number; currency: string }
): Promise<CancelOutcome> {
  const order = await store.getOrder(info.orderId);
  if (!order) return { changed: false, alert: null };

  const amount = Number.isFinite(info.amount) && info.amount >= 0 ? info.amount : 0;
  const detail = refundReceivedDetail(info.refundId, info.currency, amount);

  const trail = await store.listOrderEvents(info.orderId);
  const isDuplicate = info.refundId
    ? trail.some((e) => e.kind === 'refund-received' && typeof e.detail === 'string' && e.detail.startsWith(`refund ${info.refundId}:`))
    : trail.some((e) => e.kind === 'refund-received' && e.detail === detail);
  if (isDuplicate) return { changed: false, alert: null };

  await store.addOrderEvent(info.orderId, 'refund-received', detail);

  if (order.status === 'cancelled') return { changed: false, alert: null };

  if (order.cj_order_id) {
    const name = displayName(order);
    const amountStr = amount.toFixed(2);
    await store.addOrderEvent(info.orderId, 'owner-alerted');
    return {
      changed: true,
      alert: {
        subject: `Order ${name} was refunded ${info.currency} ${amountStr}`,
        text: `Order ${name} was refunded ${info.currency} ${amountStr} in Shopify. Supplier order ${order.cj_order_id} exists for it (status here: ${order.status}). Decide whether the supplier order should still go ahead.`
      }
    };
  }

  if (order.status === 'held' || order.status === 'queued' || order.status === 'received') {
    await store.updateOrder(info.orderId, { status: 'held', hold_reasons: JSON.stringify(['refunded']) });
    return { changed: true, alert: null };
  }

  return { changed: false, alert: null };
}
