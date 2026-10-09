import type { TenantStore, OrderRow } from './tenant-store';
import { alertState, type TrailEvent } from './order-alert';

// Decides what happens to our order row when Shopify reports a cancel or a
// refund, and whether the owner needs to be told about it. Pure decision
// logic against the store - no network and no email here, the caller sends
// the alert.

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

const CANCEL_RECEIVED_STATUS_PREFIX = 'was ';

/** Read the status a cancel-received event recorded at the time of the first
 *  delivery. A cancel-received written before this detail existed has no
 *  prefix to find, and that absence itself means "no alert was due" - it
 *  is treated the same as a row whose first-read status never carried an
 *  alert. */
function statusFromCancelReceived(detail: string | null): OrderRow['status'] | null {
  if (!detail || !detail.startsWith(CANCEL_RECEIVED_STATUS_PREFIX)) return null;
  return detail.slice(CANCEL_RECEIVED_STATUS_PREFIX.length) as OrderRow['status'];
}

/** The alert a cancel raises for a row whose FIRST-read status was
 *  `firstStatus`, reading the supplier order id / tracking number off
 *  `order` (the row as it stands once the cancel's own write has landed).
 *  'awaiting-payment', 'submitted' and 'fulfilled' each get their own
 *  wording; an already-cancelled row raises nothing, because there is
 *  nothing new to tell that the row's own earlier cancellation did not
 *  already cover; every other status (held, queued, received, error, or a
 *  future one) raises the generic warning only when a supplier order
 *  exists on the row - closing the gap where a race with the pipeline
 *  created one between our two reads. */
function cancelAlertFor(firstStatus: OrderRow['status'], order: OrderRow): OwnerAlert | null {
  const name = displayName(order);
  if (firstStatus === 'awaiting-payment') {
    // 'awaiting-payment' means WE have not paid it. When the owner pays the
    // supplier by hand we never learn of it (the row only moves on when a
    // tracking number arrives), so the text must not claim the supplier order
    // is unpaid or that nothing has been spent: it says what to do either way.
    const cj = order.cj_order_id ?? NOT_RECORDED;
    if (order.owner_paid_at) {
      // The owner told PawScout they paid it by hand ("I paid this"), so the
      // money is out: the refund is the ask. Still never "PawScout paid it".
      return {
        subject: `Order ${name} was cancelled after you paid its supplier order`,
        text: `Order ${name} was cancelled in Shopify. Supplier order ${cj} was created for it, and on ${order.owner_paid_at.slice(0, 10)} you marked it as paid by you at the supplier. Ask the supplier to cancel and refund it, and treat it as a return if it has shipped. If it was not paid after all, do NOT pay it now: cancel it at the supplier.`
      };
    }
    return {
      subject: `Order ${name} was cancelled: do NOT pay the supplier`,
      text: `Order ${name} was cancelled in Shopify. Supplier order ${cj} was created for it and PawScout has not paid it. Do NOT pay it. If it is still unpaid, remove it at the supplier: Delete at CJ next to this order in PawScout's Orders list does that while CJ shows it as CREATED or IN_CART, otherwise cancel it in CJ's dashboard. If you have already paid it by hand, PawScout cannot see that: ask the supplier to cancel and refund it, and treat it as a return if it has shipped.`
    };
  }
  if (firstStatus === 'submitted') {
    const cj = order.cj_order_id ?? NOT_RECORDED;
    return {
      subject: `Order ${name} was cancelled after it was paid at the supplier`,
      text: `Order ${name} was cancelled in Shopify after supplier order ${cj} was paid. Ask the supplier to cancel it if it has not shipped. If it has shipped, this is a return.`
    };
  }
  if (firstStatus === 'fulfilled') {
    const tracking = order.tracking_number ?? NOT_RECORDED;
    return {
      subject: `Order ${name} was cancelled after it shipped`,
      text: `Order ${name} was cancelled in Shopify after it shipped (tracking ${tracking}). Treat it as a return.`
    };
  }
  if (firstStatus === 'cancelled') return null;
  if (order.cj_order_id) {
    return {
      subject: `Order ${name} was cancelled and a supplier order exists for it`,
      text: `Order ${name} was cancelled in Shopify. Supplier order ${order.cj_order_id} exists for it. Do NOT pay it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.`
    };
  }
  return null;
}

/**
 * Decide the effect of a Shopify order/cancelled webhook on our row.
 * No row: nothing happens. Otherwise dedupe on the trail, not on status: a
 * redelivered webhook never repeats the status write once the order's trail
 * already holds a cancel-received event (this is what lets a 'fulfilled'
 * row, which never changes status, still get exactly one status write across
 * any number of deliveries).
 *
 * On the first delivery the MARKER is written before the status: the row's
 * status is read once, at the top, into `firstStatus`; the cancel-received
 * event is written recording that status; only once that write is confirmed
 * does the status write itself happen (every status becomes 'cancelled'
 * except 'fulfilled' and 'cancelled' themselves, left as-is - a shipped
 * order is a return, not an undo; an already-cancelled row has nothing left
 * to change); the row is read again, and the alert is decided from the
 * status it had before our write and the supplier order id it holds after.
 * This order is still safe against the pipeline race even though the marker
 * now comes first: `firstStatus` is still the one unconditional read at the
 * top, our status write is still one unconditional write, and the second
 * read still follows it - so a supplier order id the pipeline writes in
 * between our read and our write is still seen by that second read and still
 * raises the generic warning. If the cancel-received write itself is
 * refused, we throw rather than continue: the row is left exactly as it was
 * (no status write, no trail entry), so the caller's 500 makes Shopify
 * redeliver into what is, from our side, a clean first delivery again - the
 * pull check's own per-row guard gets the same treatment on its next tick.
 *
 * On a repeat delivery (the trail already holds cancel-received), the
 * recorded status is read back from that event's own detail. When the row's
 * CURRENT status is still neither 'cancelled' nor 'fulfilled' and the
 * recorded status is not 'fulfilled' either, the status write is RE-APPLIED
 * (this is what heals a crash that landed the marker but never reached the
 * status write, including a marker with no detail at all - a status a
 * pre-detail marker cannot even name still gets re-cancelled, just with no
 * alert to reconstruct from it). Otherwise nothing is written again -
 * instead the alert that was due on the first delivery is reconstructed from
 * the recorded status and the row's current supplier order id, and handed
 * back to the caller again unless the trail shows the alert was actually
 * delivered, or is still within its own retry budget (alertState, which
 * treats an abandoned or aged-out failure as nobody having been told, unlike
 * the old rule that treated any failure marker as permanent).
 */
export async function applyCancel(store: TenantStore, shopifyOrderId: string): Promise<CancelOutcome> {
  const order = await store.getOrder(shopifyOrderId);
  if (!order) return { changed: false, alert: null };

  const trail = await store.listOrderEvents(shopifyOrderId);
  const cancelReceived = trail.find((e) => e.kind === 'cancel-received');
  if (cancelReceived) {
    const recordedStatus = statusFromCancelReceived(cancelReceived.detail);
    let current = order;
    let changed = false;
    if (order.status !== 'cancelled' && order.status !== 'fulfilled' && recordedStatus !== 'fulfilled') {
      await store.updateOrder(shopifyOrderId, { status: 'cancelled', hold_reasons: JSON.stringify(['shopify-cancelled']) });
      changed = true;
      current = (await store.getOrder(shopifyOrderId)) ?? order;
    }
    if (!recordedStatus) return { changed, alert: null };
    const alert = cancelAlertFor(recordedStatus, current);
    if (!alert || alertState(trail, alert.subject) !== 'untold') return { changed, alert: null };
    return { changed, alert };
  }

  const firstStatus = order.status;
  const markerWritten = await store.addOrderEvent(shopifyOrderId, 'cancel-received', `${CANCEL_RECEIVED_STATUS_PREFIX}${firstStatus}`);
  if (!markerWritten) throw new Error('cancel-received could not be recorded');

  if (firstStatus !== 'fulfilled' && firstStatus !== 'cancelled') {
    await store.updateOrder(shopifyOrderId, { status: 'cancelled', hold_reasons: JSON.stringify(['shopify-cancelled']) });
  }

  const settled = await store.getOrder(shopifyOrderId);
  const alert = cancelAlertFor(firstStatus, settled ?? order);

  return { changed: true, alert };
}

/** The refund-received event's detail: 'refund <id>: <currency> <amount>',
 *  using the word 'unknown' in place of the id when Shopify sent none. */
function refundReceivedDetail(refundId: string, currency: string, amount: number): string {
  return `refund ${refundId || 'unknown'}: ${currency} ${amount.toFixed(2)}`;
}

/** The alert a refund raises for a row that already carries a supplier
 *  order, using the row's CURRENT status and supplier order id - null when
 *  no supplier order exists (no alert is ever due in that case, whatever
 *  the status). Shared by the first delivery and by a repeat delivery's
 *  heal check, so both compute the identical subject/text. The subject
 *  names the refund id when Shopify sent one, so two refunds of the same
 *  amount and currency get different retry identities instead of one
 *  delivery clearing the other's pending state; the text is unchanged
 *  either way. */
function refundAlertFor(order: OrderRow, currency: string, amount: number, refundId: string): OwnerAlert | null {
  if (!order.cj_order_id) return null;
  const name = displayName(order);
  const amountStr = amount.toFixed(2);
  const subject = refundId
    ? `Order ${name} was refunded ${currency} ${amountStr} (refund ${refundId})`
    : `Order ${name} was refunded ${currency} ${amountStr}`;
  return {
    subject,
    text: `Order ${name} was refunded ${currency} ${amountStr} in Shopify. Supplier order ${order.cj_order_id} exists for it (status here: ${order.status}). Decide whether the supplier order should still go ahead.`
  };
}

/**
 * Decide the effect of a Shopify refunds/create webhook on our row.
 * No row: nothing happens. Otherwise dedupe on the trail: read from the
 * WHOLE trail rather than just the last event, so a third or later
 * redelivery is still caught (unlike a tail-only check, which a row's own
 * unconditional refund-received write would otherwise defeat on the very
 * next delivery). When the payload carried no refund id, fall back to an
 * exact match on the detail about to be written, since there is no better
 * identity to key on. On a genuine duplicate, nothing is written again -
 * instead the alert this refund would raise is recomputed from the row as
 * it stands now (a supplier order on it, status not cancelled) and handed
 * back to the caller again UNLESS a marker already shows somebody was told
 * (this heals an alert lost between the dedupe write and delivery, the same
 * way applyCancel does).
 * Past the dedupe check on a genuinely new delivery, a refund-received event
 * is ALWAYS written for a row that exists, so the trail never has a silent
 * gap - even a row with nothing else to do (already cancelled, or no
 * supplier order and an unlisted status) still records that Shopify
 * reported the refund. Then: a cancelled row is left alone with no alert
 * (the cancel already told the owner what to do); a row with no supplier
 * order yet, in a pre-spend status, is put on hold, no alert needed (no
 * money has left our side); a row with a supplier order already created
 * (any other status) is left alone but raises an owner alert.
 *
 * The heal check on a duplicate reads alertState only over the events AFTER
 * this refund's own refund-received (the trail is in seq order, so a slice
 * from there on is still chronological) - never the whole trail. Two refunds
 * of the same amount and currency produce the identical subject text; without
 * this scoping, an EARLIER refund's own owner-alerted marker would read as
 * "this one was told too" and mask a genuinely lost alert for the later one.
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
  const matchIndex = trail.findIndex((e) =>
    e.kind === 'refund-received' && (
      info.refundId
        ? typeof e.detail === 'string' && e.detail.startsWith(`refund ${info.refundId}:`)
        : e.detail === detail
    )
  );
  if (matchIndex !== -1) {
    const alert = order.status === 'cancelled' ? null : refundAlertFor(order, info.currency, amount, info.refundId);
    const afterThisRefund: TrailEvent[] = trail.slice(matchIndex + 1);
    if (!alert || alertState(afterThisRefund, alert.subject) !== 'untold') return { changed: false, alert: null };
    return { changed: false, alert };
  }

  await store.addOrderEvent(info.orderId, 'refund-received', detail);

  if (order.status === 'cancelled') return { changed: false, alert: null };

  const alert = refundAlertFor(order, info.currency, amount, info.refundId);
  if (alert) return { changed: true, alert };

  if (order.status === 'held' || order.status === 'queued' || order.status === 'received') {
    await store.updateOrder(info.orderId, { status: 'held', hold_reasons: JSON.stringify(['refunded']) });
    return { changed: true, alert: null };
  }

  return { changed: false, alert: null };
}
