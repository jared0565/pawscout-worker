import type { TenantStore } from './tenant-store';
import type { OwnerAlert } from './order-cancel';

// Before this module existed, the three order webhook routes answered 200
// even when their own processing threw. Shopify only redelivers a delivery
// that did NOT get a 2xx, so a database blip while a handler ran could lose a
// paid order, a cancel or a refund for good, even though every handler is
// idempotent and a redelivery would have healed it.
//
// This module counts failures PER DELIVERY - the X-Shopify-Webhook-Id header
// stays the same across Shopify's own retries of one event - and decides when
// to stop asking for a retry. Shopify itself gives up and removes the
// subscription after 8 failed deliveries in 4 hours, so this gives up sooner
// and tells the owner once when it does, rather than riding it out to 8.

/** How many failed deliveries still ask Shopify to retry (1, 2 and 3). The
 *  next failure (4) stops asking and alerts the owner instead, well short of
 *  the 8 that make Shopify remove the subscription. */
export const MAX_WEBHOOK_FAILURES = 3;

/** Shopify's own order id reads as '(unknown)' in the alert when the payload
 *  carried none - there is no better identity to show the owner. */
function orderIdForAlert(orderId: string): string {
  return orderId || '(unknown)';
}

/**
 * Record one failed processing attempt for a single Shopify webhook delivery
 * and decide how the route should answer it. Counts under `whfail:<webhookId>`
 * in the shop's search cache (the value is the count as a string, kept for a
 * day - comfortably longer than Shopify's own 4-hour retry window for one
 * delivery). Never throws: a cache read or write failure is itself treated as
 * a passing fault, on the same reasoning as the count 1-3 case - a store that
 * cannot even hold the counter cannot be trusted to have processed the event
 * either, so Shopify should still be asked to try again.
 */
export async function onWebhookFailure(
  store: Pick<TenantStore, 'getSearchCache' | 'putSearchCache'>,
  input: { webhookId: string | null; topic: string; orderId: string }
): Promise<{ status: 200 | 500; alert: OwnerAlert | null }> {
  const webhookId = input.webhookId;
  if (!webhookId) return { status: 500, alert: null };

  const cacheKey = `whfail:${webhookId}`;
  let count: number;
  try {
    const raw = await store.getSearchCache(cacheKey);
    const previous = raw ? parseInt(raw, 10) : 0;
    count = (Number.isFinite(previous) ? previous : 0) + 1;
    await store.putSearchCache(cacheKey, String(count), 1);
  } catch {
    return { status: 500, alert: null };
  }

  if (count <= MAX_WEBHOOK_FAILURES) return { status: 500, alert: null };
  if (count !== MAX_WEBHOOK_FAILURES + 1) return { status: 200, alert: null }; // already alerted once for this delivery

  return {
    status: 200,
    alert: {
      subject: 'An order event from Shopify could not be processed',
      text: `PawScout failed ${count} times to process a Shopify ${input.topic} event (order ${orderIdForAlert(input.orderId)}). It has stopped asking Shopify to resend it, because repeated failures make Shopify remove the subscription. Check this order in Shopify and in the PawScout console.`
    }
  };
}
