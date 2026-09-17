import type { AdminGraphql } from '../shopify-admin';
import type { TenantStore } from '../tenant-store';
import type { PublicEventPayload } from '../storewide-event';
import { eventDayLabel } from '../storewide-event';
import { refreshPublicEventFeed } from '../recurring-events';

/**
 * Storewide event facts for every inbox draft (owner design 2026-09-17).
 *
 * "Is there a running event?" is answered from the SAME feed the storefront's
 * announcement bar, hero badge and welcome modal read (search cache key
 * 'public:event', ten-minute TTL, built from the live Shopify discount), so an
 * email and the site can never disagree. Three honest states:
 *   - active: the running event by name, code, percentage and end date;
 *   - idle: no event runs, and the NEXT enabled calendar event by name and
 *     dates only (its code and percentage are not announced ahead);
 *   - unknown: the feed is cold and Shopify is unreachable, so the drafter
 *     neither claims nor denies an event and never invents a code.
 * The feed is warmed from Shopify when it is cold and a client is available,
 * exactly as the /public/event route does; a failed probe leaves it unknown.
 */
export async function eventFacts(store: TenantStore, admin: AdminGraphql | null): Promise<string> {
  let payload = await readFeed(store);
  if (!payload && admin) {
    try {
      await refreshPublicEventFeed(store, admin);
      payload = await readFeed(store);
    } catch (e) {
      console.warn(`event facts: feed refresh failed: ${(e as Error).message}`);
    }
  }
  return renderEventFacts(payload);
}

/** The cached feed, or null when it is cold, malformed, or unreadable. A
 * failing cache read (a D1 hiccup) degrades to "unknown"; it never aborts the
 * draft that asked. */
async function readFeed(store: TenantStore): Promise<PublicEventPayload | null> {
  try {
    const cached = await store.getSearchCache('public:event');
    if (!cached) return null;
    const p = JSON.parse(cached) as PublicEventPayload;
    return typeof p === 'object' && p !== null && typeof p.active === 'boolean' ? p : null;
  } catch (e) {
    console.warn(`event facts: feed read failed: ${(e as Error).message}`);
    return null;
  }
}

/** The sentence(s) injected into the system prompt. Pure; exported for tests. */
export function renderEventFacts(p: PublicEventPayload | null): string {
  if (!p) {
    return 'STOREWIDE EVENTS: whether a storewide event or sale is running right now is not known to you. Do not claim one is running and do not say there is none; do not invent a code or a percentage. If asked, say that any current offer is shown on https://activepaw.co.uk and applied at checkout.';
  }
  if (p.active && p.code) {
    const name = p.name && p.name !== p.code ? p.name : p.code;
    const pct = typeof p.pctOff === 'number' ? `${Math.round(p.pctOff * 10) / 10}% off everything` : 'a storewide discount';
    const until = p.endsAt ? ` It runs until the end of ${eventDayLabel(p.endsAt)} (UK time).` : '';
    return `STOREWIDE EVENTS: a storewide event is running right now: ${name}, ${pct} with the code ${p.code} at checkout.${until} You MAY state these facts exactly as given (name, code, percentage, end date) when the customer asks about a sale, an event, a discount or a code; never change or round them differently, and never promise any other code or discount.`;
  }
  const idle = 'STOREWIDE EVENTS: no storewide event or sale is running right now, so do not offer or imply any discount code or percentage.';
  if (p.next) {
    return `${idle} The next planned event is ${p.next.name}, from ${p.next.startsLabel} to ${p.next.endsLabel}; if asked, you may mention its name and dates, but never a code or percentage, because those are not announced ahead.`;
  }
  return idle;
}
