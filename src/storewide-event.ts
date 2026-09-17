import type { AdminGraphql } from './shopify-admin';
import { type PromoWindow } from './affiliate-discounts';
import { templateByCode, renderHeadline, type EventTemplate } from './event-catalogue';

// Storewide events (2026-07-06, owner request after the WELCOME10 date drift):
// create and end storewide percentage events from the console, with the
// SHOPIFY DISCOUNT AS THE ONLY RECORD. There is deliberately no events table:
// a second copy of the dates is exactly what drifted last time ("3 August"
// everywhere while the discount ended 19 July). Everything downstream reads
// the discount live: the Partners banner, voucher deferral, the /public/event
// endpoint the storefront modal polls, and the campaign draft this module
// stages at creation with the real dates baked in.

export interface EventRequest {
  code: string;
  pctOff: number;
  startsAt: string; // ISO instant
  endsAt: string;   // ISO instant
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'Sunday 19 July' - deterministic UTC label for customer-facing event copy. */
export function eventDayLabel(iso: string): string {
  const d = new Date(iso);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

/** Validate the console form. Dates arrive as YYYY-MM-DD; the event runs from
 * 00:00 UTC on the start day through 23:59:59 UTC on the end day. */
export function validateEventRequest(body: unknown): { ok: true; value: EventRequest } | { ok: false; error: string } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9-]{2,29}$/.test(code)) return { ok: false, error: 'Code must be 3-30 letters, digits or dashes' };
  const pctOff = typeof b.pctOff === 'number' ? b.pctOff : NaN;
  if (!Number.isFinite(pctOff) || pctOff < 1 || pctOff > 90) return { ok: false, error: 'Discount must be 1-90 percent' };
  const startDay = typeof b.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.startDate) ? b.startDate : '';
  const endDay = typeof b.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.endDate) ? b.endDate : '';
  if (!startDay || !endDay) return { ok: false, error: 'Start and end dates are required (YYYY-MM-DD)' };
  const startsAt = `${startDay}T00:00:00.000Z`;
  const endsAt = `${endDay}T23:59:59.000Z`;
  if (Date.parse(startsAt) >= Date.parse(endsAt)) return { ok: false, error: 'The end date must be after the start date' };
  if (Date.parse(endsAt) <= Date.now()) return { ok: false, error: 'The end date is already in the past' };
  return { ok: true, value: { code, pctOff, startsAt, endsAt } };
}

/** An event may never overlap another storewide promotion (double-discount
 * chaos and a meaningless modal). Partner trials are already excluded from the
 * probe, so every remaining promo is a genuine storewide rival. */
export function findOverlappingPromo(promos: PromoWindow[], startsAt: string, endsAt: string): PromoWindow | null {
  const s = Date.parse(startsAt);
  const e = Date.parse(endsAt);
  for (const p of promos) {
    const ps = p.startsAt ? Date.parse(p.startsAt) : -Infinity;
    const pe = p.endsAt ? Date.parse(p.endsAt) : Infinity;
    if (ps < e && pe > s) return p;
  }
  return null;
}

const EVENT_CREATE_MUTATION = `mutation pawscoutEventCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

/** Create the storewide event discount: percentage off everything, once per
 * customer, combines with nothing, no usage cap (an event is for everyone),
 * explicit start and end - the schedule lives INSIDE the discount, so the code
 * is simply refused at checkout outside its window. Title = code, matching how
 * WELCOME10 was set up (and what the Partners banner shows). */
export async function createEventDiscount(
  admin: AdminGraphql, ev: EventRequest
): Promise<{ ok: true; discountId: string } | { ok: false; error: string }> {
  try {
    const data = await admin(EVENT_CREATE_MUTATION, {
      basicCodeDiscount: {
        title: ev.code,
        code: ev.code,
        startsAt: ev.startsAt,
        endsAt: ev.endsAt,
        appliesOncePerCustomer: true,
        customerSelection: { all: true },
        customerGets: { value: { percentage: ev.pctOff / 100 }, items: { all: true } },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false }
      }
    });
    const res = data.discountCodeBasicCreate as { codeDiscountNode?: { id?: string } | null; userErrors?: { message?: string }[] } | undefined;
    const errs = res?.userErrors ?? [];
    if (errs.length) return { ok: false, error: errs.map((u) => u.message).join('; ') };
    const id = res?.codeDiscountNode?.id;
    if (!id) return { ok: false, error: 'Shopify returned no discount id' };
    return { ok: true, discountId: id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Announcement campaign draft staged at event creation: the dates are baked
 * in from the SAME values the discount was created with, so the copy cannot
 * drift from the discount. Deterministic, no LLM, stays a draft (HITL send). */
export function buildEventCampaign(ev: EventRequest): { subject: string; bodyText: string } {
  const endLabel = eventDayLabel(ev.endsAt);
  const startsFuture = Date.parse(ev.startsAt) > Date.now();
  const window = startsFuture
    ? `from ${eventDayLabel(ev.startsAt)} until ${endLabel}`
    : `until ${endLabel}`;
  const pct = Math.round(ev.pctOff * 10) / 10;
  return {
    subject: `${pct}% off everything until ${endLabel.replace(/^\w+ /, '')}`,
    bodyText:
`Hello,

A quick note from Active Paw: our storewide event takes ${pct}% off every product in the store ${window}. Use the code ${ev.code} at checkout and the discount comes straight off your order.

If your dog or cat is due a grooming refresh, a new toy or an everyday restock, this is the moment the whole range costs less. UK orders come with free delivery, as always.`
  };
}

/** The next planned catalogue event, for the idle storefront and the inbox:
 * NAME and DATES only. Its code and percentage are deliberately absent, since
 * they are not announced ahead (the owner may still change the percentage). */
export interface NextEventTease {
  key: string;
  name: string;
  startsAt: string;
  endsAt: string;
  startsLabel: string; // 'Friday 28 August'
  endsLabel: string;   // 'Monday 31 August'
}

export interface PublicEventPayload {
  active: boolean;
  /** Display name: the catalogue event's name, else the code itself (2026-09-17,
   * for the announcement bar, hero badge and inbox agents). */
  name?: string;
  code?: string;
  pctOff?: number;
  endsAt?: string | null;
  endsLabel?: string | null; // '19 July' - what the storefront modal prints after "Ends"
  // Catalogue events repaint the modal completely - no theme edit per event.
  // Absent for codes without a template (WELCOME10, one-off customs): the
  // modal keeps its theme-settings wording for those.
  headline?: string;
  subline?: string;
  chips?: string[];
  /** Earliest ENABLED catalogue window that has not started yet, if any. */
  next?: NextEventTease;
}

/** The earliest window among `upcoming` whose start is still ahead of `nowMs`.
 * A window that has already started (the running event, or one that ended
 * this year with the next occurrence a year away) is never "next". */
export function nextEventTease(upcoming: EventTemplate[], nowMs: number): NextEventTease | undefined {
  let best: NextEventTease | undefined;
  for (const t of upcoming) {
    const w = t.nextWindow(nowMs);
    if (Date.parse(w.startsAt) <= nowMs) continue;
    if (best && Date.parse(w.startsAt) >= Date.parse(best.startsAt)) continue;
    best = { key: t.key, name: t.name, startsAt: w.startsAt, endsAt: w.endsAt, startsLabel: eventDayLabel(w.startsAt), endsLabel: eventDayLabel(w.endsAt) };
  }
  return best;
}

/** What the storefront modal is allowed to advertise RIGHT NOW: the running
 * storewide CODE event (largest percentage if several). Scheduled events,
 * automatic discounts (no code to advertise) and code-less rows are not shown.
 * active:false tears the modal down. Catalogue codes carry their pre-written
 * wording, with the headline percentage interpolated from the LIVE discount
 * so an owner-edited percentage can never disagree with the storefront.
 * `upcoming` (2026-09-17) is the owner's ENABLED catalogue templates: the feed
 * then also teases the next planned event by name and dates so the storefront
 * and the inbox can say what is coming without ever leaking its code. */
export function publicEventPayload(promos: PromoWindow[], nowMs = Date.now(), upcoming: EventTemplate[] = []): PublicEventPayload {
  const next = nextEventTease(upcoming, nowMs);
  const live = promos.filter((p) =>
    p.source === 'code' && p.code && p.status === 'ACTIVE'
    && (!p.startsAt || Date.parse(p.startsAt) <= nowMs)
    && (!p.endsAt || Date.parse(p.endsAt) > nowMs));
  if (!live.length) return next ? { active: false, next } : { active: false };
  const best = live.slice().sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0];
  const endsLabel = best.endsAt ? eventDayLabel(best.endsAt).replace(/^\w+ /, '') : null;
  const t = templateByCode(best.code!);
  const base: PublicEventPayload = { active: true, name: t?.name ?? best.code!, code: best.code!, pctOff: best.percentage ?? undefined, endsAt: best.endsAt, endsLabel };
  if (t) {
    base.headline = renderHeadline(t, best.percentage);
    base.subline = t.subline;
    base.chips = t.chips;
  }
  if (next) base.next = next;
  return base;
}
