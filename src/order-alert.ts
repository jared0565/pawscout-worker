import type { TenantStore } from './tenant-store';
import type { OwnerAlert } from './order-cancel';

// Every owner alert about money in flight goes through this one door. The
// hole this closes: a send that failed used to look, in the trail, exactly
// like the owner had been told. From here the marker that stops retrying is
// written only after delivery is confirmed, and a failed send gets picked up
// again later instead of being lost for good.

export type AlertResult = 'sent' | 'failed' | 'unconfigured';
export type AlertSend = (subject: string, text: string) => Promise<AlertResult>;

/** How many times one alert (identified by its subject, on one order) is
 *  retried before it is given up on and written to the trail as abandoned. */
export const MAX_ALERT_ATTEMPTS = 12;

/** How far back the retry sweep looks for a failed alert's first failure. */
export const ALERT_RETRY_WINDOW_HOURS = 24;

/** How many pending alerts one sweep will re-send before it stops for this
 *  tick. The rest wait for the next tick, comfortably inside the 12 attempt
 *  budget, so the sweep cannot starve the money work that runs after it. */
export const MAX_ALERT_RESENDS_PER_TICK = 10;

/** The production `send` ends in a fetch with no timeout of its own. At the
 *  webhook door the send and its marker write both live inside `waitUntil`,
 *  which the platform ends shortly after the response, so a provider that
 *  hangs would lose the alert with no marker at all. A send that has not
 *  answered by this deadline counts as `failed` instead. */
export const ALERT_SEND_TIMEOUT_MS = 10_000;

const NOT_RECORDED = '(not recorded)';

/** One pending alert's retry state while walking a trail: firstAt is when it
 *  FIRST failed (an owner-alerted for the same subject clears the entry, so
 *  a later failure of the same wording starts a fresh count), failures is
 *  how many times it has failed since. */
export interface PendingAlert { firstAt: string; failures: number }

/**
 * Walks a trail once and answers what is still pending: an owner-alert-failed
 * row sets or increments its subject's count (firstAt pinned to the first
 * one seen), an owner-alerted row clears its subject. deliverOrderAlert and
 * retryOrderAlerts both call this so they can never disagree about what
 * "still pending" means for a given subject.
 */
export function pendingAlerts(
  trail: { kind: string; detail: string | null; at: string }[]
): Map<string, PendingAlert> {
  const pending = new Map<string, PendingAlert>();
  for (const e of trail) {
    if (e.kind === 'owner-alert-failed' && e.detail != null) {
      const existing = pending.get(e.detail);
      if (existing) existing.failures++;
      else pending.set(e.detail, { firstAt: e.at, failures: 1 });
    } else if (e.kind === 'owner-alerted' && e.detail != null) {
      pending.delete(e.detail);
    }
  }
  return pending;
}

/** Races `send` against a timer: whichever settles first (a resolve, a
 *  throw - including a SYNCHRONOUS one, since `send` is invoked inside a
 *  `.then` callback rather than directly in the executor - or the timeout)
 *  decides the outcome, and `finally` clears the timer on every one of
 *  those paths. A send that has not answered by `timeoutMs` settles as
 *  `'failed'`; the send, if it eventually does answer, is ignored (a late
 *  success costs one duplicate email on the next retry, never a lost
 *  alert). */
function sendWithTimeout(send: AlertSend, subject: string, text: string, timeoutMs: number): Promise<AlertResult> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<AlertResult>((resolve) => {
    timer = setTimeout(() => resolve('failed'), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => send(subject, text)), timeout]).finally(() => clearTimeout(timer));
}

/** Writes one trail marker; if the database refuses it, writes it once more;
 *  if it is still refused, logs loudly so a lost marker is at least visible
 *  instead of silently dropping the alert from the retry sweep (a failed
 *  marker) or duplicating sends forever (a sent one). The log line carries
 *  the order id, the marker kind and the alert's SUBJECT only - never its
 *  text, never a thrown error's message. */
async function writeAlertMarker(
  store: TenantStore, shopifyOrderId: string, kind: 'owner-alerted' | 'owner-alert-failed', subject: string
): Promise<void> {
  if (await store.addOrderEvent(shopifyOrderId, kind, subject)) return;
  if (await store.addOrderEvent(shopifyOrderId, kind, subject)) return;
  console.error(`owner alert marker not recorded for order ${shopifyOrderId} (${kind}): ${subject}`);
}

/**
 * Send one owner alert and record what happened in the order's trail: a
 * delivered send writes owner-alerted, a failed one writes owner-alert-failed
 * (picked up later by retryOrderAlerts, and turned into an abandoned error
 * line once it has failed MAX_ALERT_ATTEMPTS times since its last delivery),
 * and no address or key configured writes an error line that is never
 * retried - there is nobody to tell. Never throws: a `send` that throws or
 * does not answer within the timeout is treated the same as one that answers
 * 'failed'. Every trail write's detail is the alert's SUBJECT, never its
 * text - order_events.detail must never hold customer data, and the text
 * can.
 */
export async function deliverOrderAlert(
  store: TenantStore, shopifyOrderId: string, alert: OwnerAlert, send: AlertSend,
  opts?: { timeoutMs?: number }
): Promise<AlertResult> {
  let result: AlertResult;
  try {
    result = await sendWithTimeout(send, alert.subject, alert.text, opts?.timeoutMs ?? ALERT_SEND_TIMEOUT_MS);
  } catch (e) {
    console.warn(`owner alert send failed for ${shopifyOrderId}: ${e instanceof Error ? e.message : String(e)}`);
    result = 'failed';
  }
  try {
    if (result === 'sent') {
      await writeAlertMarker(store, shopifyOrderId, 'owner-alerted', alert.subject);
    } else if (result === 'unconfigured') {
      await store.addOrderEvent(shopifyOrderId, 'error', `owner alert not configured: ${alert.subject}`);
    } else {
      await writeAlertMarker(store, shopifyOrderId, 'owner-alert-failed', alert.subject);
      const trail = await store.listOrderEvents(shopifyOrderId);
      const failures = pendingAlerts(trail).get(alert.subject)?.failures;
      if (failures === MAX_ALERT_ATTEMPTS) {
        await store.addOrderEvent(shopifyOrderId, 'error', `owner alert abandoned after ${MAX_ALERT_ATTEMPTS} attempts: ${alert.subject}`);
      }
    }
  } catch (e) {
    console.warn(`order alert trail write failed for ${shopifyOrderId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}

/**
 * Re-send every owner alert that failed and has not since been delivered,
 * fewer than MAX_ALERT_ATTEMPTS times and first raised within
 * ALERT_RETRY_WINDOW_HOURS of `now`. Scans every order with a recent failure
 * for this shop; one order failing never stops the sweep, it is best-effort
 * and reports what it managed rather than throwing. Stops sending once it
 * has re-sent MAX_ALERT_RESENDS_PER_TICK alerts this tick - the remainder
 * waits for the next one.
 */
export async function retryOrderAlerts(
  store: TenantStore, send: AlertSend, now: Date = new Date()
): Promise<{ retried: number; delivered: number }> {
  const sinceIso = new Date(now.getTime() - ALERT_RETRY_WINDOW_HOURS * 3_600_000).toISOString();
  const orderIds = await store.listOrderIdsWithPendingAlerts(sinceIso, MAX_ALERT_ATTEMPTS);
  let retried = 0;
  let delivered = 0;

  for (const orderId of orderIds) {
    try {
      const order = await store.getOrder(orderId);
      if (!order) continue; // no row for this id - nothing left to retry against

      const trail = await store.listOrderEvents(orderId);
      const pending = pendingAlerts(trail);

      for (const [subject, info] of pending) {
        if (retried >= MAX_ALERT_RESENDS_PER_TICK) return { retried, delivered };
        if (info.failures >= MAX_ALERT_ATTEMPTS) continue;
        if (info.firstAt < sinceIso) continue;
        const text = `This alert was first raised at ${info.firstAt} and could not be delivered then.\n\n${subject}.\n\nSupplier order: ${order.cj_order_id ?? NOT_RECORDED}. Tracking: ${order.tracking_number ?? NOT_RECORDED}. Status here: ${order.status}.\n\nDo not pay or settle anything for this order at the supplier until you have read its trail: open the PawScout console, Orders, and open this order's trail for the full history.`;
        retried++;
        const result = await deliverOrderAlert(store, orderId, { subject, text }, send);
        if (result === 'sent') delivered++;
      }
    } catch (e) {
      console.warn(`owner alert retry failed for order ${orderId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { retried, delivered };
}
