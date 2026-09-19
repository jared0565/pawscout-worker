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

/** A due row with no failure yet is left alone by the sweep for this long
 *  after it was recorded: the send it announces may still be genuinely in
 *  flight in the invocation that raised it, and re-sending now would only
 *  duplicate the email. Past this, that invocation is presumed dead and the
 *  sweep picks the alert up. */
export const ALERT_DUE_GRACE_MS = 60_000;

/** The production `send` ends in a fetch with no timeout of its own. At the
 *  webhook door the send and its marker write both live inside `waitUntil`,
 *  which the platform ends shortly after the response, so a provider that
 *  hangs would lose the alert with no marker at all. A send that has not
 *  answered by this deadline counts as `failed` instead. */
export const ALERT_SEND_TIMEOUT_MS = 10_000;

const NOT_RECORDED = '(not recorded)';

/** One trail event as the functions in this file need it: its kind, detail
 *  and timestamp. A structural subset of OrderEventRow, so a caller can pass
 *  either the real row shape or a hand-built one for testing. */
export interface TrailEvent { kind: string; detail: string | null; at: string }

/** One pending alert's retry state while walking a trail: firstAt is when it
 *  was FIRST raised as due, or (for a trail written before the due marker
 *  existed) first failed - an owner-alerted for the same subject clears the
 *  entry, so a later due or failure of the same wording starts a fresh
 *  count. failures is how many times it has failed since. */
export interface PendingAlert { firstAt: string; failures: number }

/**
 * Walks a trail once and answers what is still pending: an owner-alert-due
 * row creates its subject's entry (firstAt pinned to the first one seen,
 * failures 0) when it is not already pending, and changes nothing when it
 * is; an owner-alert-failed row sets or increments its subject's failure
 * count (firstAt still pinned to whichever row - due or failed - came
 * first); an owner-alerted row clears its subject, and so does an
 * owner-alert-unconfigured row for the same subject - nobody was ever able
 * to tell, so a due row with no failure attached to it must not sit here
 * forever and have the sweep re-send it, and the unconfigured marker it
 * would write, on every tick for the rest of the retry window. A LATER due
 * or failed row for the same subject (alerting was configured since) still
 * re-creates the entry, because the clear is not sticky - it only removes
 * whatever is pending at the moment it is walked. deliverOrderAlert and
 * retryOrderAlerts both call this so they can never disagree about what
 * "still pending" means for a given subject.
 */
export function pendingAlerts(trail: TrailEvent[]): Map<string, PendingAlert> {
  const pending = new Map<string, PendingAlert>();
  for (const e of trail) {
    if (e.kind === 'owner-alert-due' && e.detail != null) {
      if (!pending.has(e.detail)) pending.set(e.detail, { firstAt: e.at, failures: 0 });
    } else if (e.kind === 'owner-alert-failed' && e.detail != null) {
      const existing = pending.get(e.detail);
      if (existing) existing.failures++;
      else pending.set(e.detail, { firstAt: e.at, failures: 1 });
    } else if ((e.kind === 'owner-alerted' || e.kind === 'owner-alert-unconfigured') && e.detail != null) {
      pending.delete(e.detail);
    }
  }
  return pending;
}

/**
 * What a trail (or a slice of one) says about one alert subject - the answer
 * to "does a repeat delivery still need to hand this alert back". `delivered`:
 * an owner-alerted marker whose detail is exactly this subject - somebody was
 * actually told, for good. Else `nobody-to-tell`: an owner-alert-unconfigured
 * marker whose detail is exactly this subject - there was never anyone to
 * tell, so no future delivery should try again either. Else `retrying`: a due
 * or failed send is still within its retry budget (pendingAlerts has an entry
 * for this subject, its failures are under MAX_ALERT_ATTEMPTS, and its
 * firstAt is within ALERT_RETRY_WINDOW_HOURS of `now`) - the sweep will pick
 * it up, so a repeat delivery must not hand it back too and duplicate the
 * send. Else `untold`: nobody was told and nothing will retry - this covers
 * both an abandoned alert (failures reached MAX_ALERT_ATTEMPTS) and one whose
 * first due or failure aged out of the window, and a repeat delivery must
 * hand the alert back so it is not lost for good.
 */
export function alertState(trail: TrailEvent[], subject: string, now: Date = new Date()): 'delivered' | 'nobody-to-tell' | 'retrying' | 'untold' {
  if (trail.some((e) => e.kind === 'owner-alerted' && e.detail === subject)) return 'delivered';
  if (trail.some((e) => e.kind === 'owner-alert-unconfigured' && e.detail === subject)) return 'nobody-to-tell';
  const pending = pendingAlerts(trail).get(subject);
  if (pending) {
    const sinceIso = new Date(now.getTime() - ALERT_RETRY_WINDOW_HOURS * 3_600_000).toISOString();
    if (pending.failures < MAX_ALERT_ATTEMPTS && pending.firstAt >= sinceIso) return 'retrying';
  }
  return 'untold';
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
 *  marker), duplicating sends forever (a sent or an unconfigured one), or
 *  leaving nothing for the retry sweep to find at all (a due one). The log
 *  line carries the order id, the marker kind and the alert's SUBJECT only -
 *  never its text, never a thrown error's message. Answers whether the
 *  marker landed. */
async function writeAlertMarker(
  store: TenantStore, shopifyOrderId: string,
  kind: 'owner-alert-due' | 'owner-alerted' | 'owner-alert-unconfigured' | 'owner-alert-failed', subject: string
): Promise<boolean> {
  if (await store.addOrderEvent(shopifyOrderId, kind, subject)) return true;
  if (await store.addOrderEvent(shopifyOrderId, kind, subject)) return true;
  console.error(`owner alert marker not recorded for order ${shopifyOrderId} (${kind}): ${subject}`);
  return false;
}

/**
 * Records that this alert must reach the owner, before anything is even
 * attempted - the transactional-outbox half of an alert's lifecycle, so a
 * deferred send that is killed before it runs still leaves something for the
 * retry sweep to find. Writes through the same write-twice-then-loud-log
 * helper the other two markers use. Never throws; answers whether the row
 * landed.
 */
export async function recordAlertDue(store: TenantStore, shopifyOrderId: string, alert: OwnerAlert): Promise<boolean> {
  return writeAlertMarker(store, shopifyOrderId, 'owner-alert-due', alert.subject);
}

/**
 * Send one owner alert and record what happened in the order's trail: unless
 * `opts.dueRecorded` is true (the caller already recorded it, e.g. through
 * recordAlertDue before a webhook route answered, or a retry sweep re-using
 * the pending state that already exists) this FIRST writes owner-alert-due,
 * so the intent to alert survives even if the send that follows is killed
 * before it runs. Then it sends: a delivered send writes owner-alerted, a
 * failed one writes owner-alert-failed (picked up later by retryOrderAlerts,
 * and turned into an abandoned error line once it has failed
 * MAX_ALERT_ATTEMPTS times since its last delivery), and no address or key
 * configured writes owner-alert-unconfigured, which is never retried - there
 * is nobody to tell. Never throws: a `send` that throws or does not answer
 * within the timeout is treated the same as one that answers 'failed'. Every
 * trail write's detail is the alert's SUBJECT, never its text -
 * order_events.detail must never hold customer data, and the text can.
 */
export async function deliverOrderAlert(
  store: TenantStore, shopifyOrderId: string, alert: OwnerAlert, send: AlertSend,
  opts?: { timeoutMs?: number; dueRecorded?: boolean }
): Promise<AlertResult> {
  if (!opts?.dueRecorded) {
    await writeAlertMarker(store, shopifyOrderId, 'owner-alert-due', alert.subject);
  }
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
      await writeAlertMarker(store, shopifyOrderId, 'owner-alert-unconfigured', alert.subject);
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
 * Re-send every owner alert that is due or failed and has not since been
 * delivered, fewer than MAX_ALERT_ATTEMPTS FAILURES and first raised within
 * ALERT_RETRY_WINDOW_HOURS of `now`. Scans every order with a recent due or
 * failed row for this shop; one order failing never stops the sweep, it is
 * best-effort and reports what it managed rather than throwing. Stops
 * sending once it has re-sent MAX_ALERT_RESENDS_PER_TICK alerts this tick -
 * the remainder waits for the next one. Every resend passes
 * `dueRecorded: true` - the pending state this loop is walking already
 * proves the alert was recorded as due, so writing a second due row would
 * only be noise.
 */
export async function retryOrderAlerts(
  store: TenantStore, send: AlertSend, now: Date = new Date()
): Promise<{ retried: number; delivered: number }> {
  const sinceIso = new Date(now.getTime() - ALERT_RETRY_WINDOW_HOURS * 3_600_000).toISOString();
  const graceCutoffIso = new Date(now.getTime() - ALERT_DUE_GRACE_MS).toISOString();
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
        // No failure yet and still inside the grace window - this send is
        // probably still in flight in the invocation that recorded it as
        // due, and re-sending now would only duplicate the email.
        if (info.failures === 0 && info.firstAt > graceCutoffIso) continue;
        const text = `This alert was first raised at ${info.firstAt} and could not be delivered then.\n\n${subject}.\n\nSupplier order: ${order.cj_order_id ?? NOT_RECORDED}. Tracking: ${order.tracking_number ?? NOT_RECORDED}. Status here: ${order.status}.\n\nDo not pay or settle anything for this order at the supplier until you have read its trail: open the PawScout console, Orders, and open this order's trail for the full history.`;
        retried++;
        const result = await deliverOrderAlert(store, orderId, { subject, text }, send, { dueRecorded: true });
        if (result === 'sent') delivered++;
      }
    } catch (e) {
      console.warn(`owner alert retry failed for order ${orderId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { retried, delivered };
}
