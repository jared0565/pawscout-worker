import type { AdminGraphql } from './shopify-admin';
import type { TenantStore } from './tenant-store';
import { EVENT_TEMPLATES, templateByKey, type EventTemplate, type EventWindow } from './event-catalogue';
import { buildEventCampaign, publicEventPayload } from './storewide-event';
import { fetchActiveOrderPromos } from './affiliate-discounts';

// Recurring-event rotation (2026-07-06): enabled catalogue events keep
// themselves scheduled in Shopify year after year. The flow is UPSERT, not
// create: each template's code is stable across years, so next year's
// occurrence re-dates the same discount instead of colliding with it.
// The nightly rotation also stages the announcement campaign draft when an
// occurrence is close (HITL send, never automatic), using armed_for on the
// recurring_events row as the once-per-occurrence cursor.

/** How close an occurrence must be before the announcement draft is staged. */
export const CAMPAIGN_ARM_DAYS = 14;

const LOOKUP_QUERY = `query pawscoutEventByCode($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    codeDiscount { ... on DiscountCodeBasic { status startsAt endsAt } }
  }
}`;

const UPDATE_MUTATION = `mutation pawscoutEventUpdate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
    userErrors { message }
  }
}`;

const ACTIVATE_MUTATION = `mutation pawscoutEventActivate($id: ID!) {
  discountCodeActivate(id: $id) { userErrors { message } }
}`;

const CREATE_MUTATION = `mutation pawscoutEventCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

function discountInput(t: EventTemplate, pct: number, w: EventWindow) {
  return {
    title: t.code,
    code: t.code,
    startsAt: w.startsAt,
    endsAt: w.endsAt,
    appliesOncePerCustomer: true,
    customerSelection: { all: true },
    customerGets: { value: { percentage: pct / 100 }, items: { all: true } },
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false }
  };
}

/** Ensure the template's next occurrence exists in Shopify with the right
 * window and percentage. Returns what was done (for logs/console messages). */
export async function ensureRecurringDiscount(
  admin: AdminGraphql, t: EventTemplate, pct: number, nowMs = Date.now()
): Promise<{ ok: true; action: 'created' | 'updated' | 'unchanged'; window: EventWindow } | { ok: false; error: string }> {
  const w = t.nextWindow(nowMs);
  try {
    const found = await admin(LOOKUP_QUERY, { code: t.code });
    const node = found.codeDiscountNodeByCode as { id?: string; codeDiscount?: { status?: string; startsAt?: string; endsAt?: string } } | null;
    if (!node?.id) {
      const created = await admin(CREATE_MUTATION, { basicCodeDiscount: discountInput(t, pct, w) });
      const res = created.discountCodeBasicCreate as { codeDiscountNode?: { id?: string } | null; userErrors?: { message?: string }[] } | undefined;
      const errs = res?.userErrors ?? [];
      if (errs.length) return { ok: false, error: errs.map((u) => u.message).join('; ') };
      if (!res?.codeDiscountNode?.id) return { ok: false, error: 'Shopify returned no discount id' };
      return { ok: true, action: 'created', window: w };
    }
    // Same window already scheduled (date-only comparison tolerates second drift).
    const same = (node.codeDiscount?.startsAt ?? '').slice(0, 10) === w.startsAt.slice(0, 10)
      && (node.codeDiscount?.endsAt ?? '').slice(0, 10) === w.endsAt.slice(0, 10);
    if (same && node.codeDiscount?.status !== 'EXPIRED') return { ok: true, action: 'unchanged', window: w };
    const updated = await admin(UPDATE_MUTATION, { id: node.id, basicCodeDiscount: discountInput(t, pct, w) });
    const uerrs = (updated.discountCodeBasicUpdate as { userErrors?: { message?: string }[] } | undefined)?.userErrors ?? [];
    if (uerrs.length) return { ok: false, error: uerrs.map((u) => u.message).join('; ') };
    // A previously deactivated discount needs explicit re-activation; harmless otherwise.
    await admin(ACTIVATE_MUTATION, { id: node.id }).catch(() => undefined);
    return { ok: true, action: 'updated', window: w };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Take an enabled event OUT of Shopify: deactivate its discount (running or
 * scheduled). Ledger-free by design - nothing else to clean up. */
export async function retireRecurringDiscount(admin: AdminGraphql, t: EventTemplate): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const found = await admin(LOOKUP_QUERY, { code: t.code });
    const node = found.codeDiscountNodeByCode as { id?: string } | null;
    if (!node?.id) return { ok: true }; // nothing scheduled: already retired
    const res = await admin(
      `mutation pawscoutEventDeactivate($id: ID!) { discountCodeDeactivate(id: $id) { userErrors { message } } }`,
      { id: node.id }
    );
    const errs = (res.discountCodeDeactivate as { userErrors?: { message?: string }[] } | undefined)?.userErrors ?? [];
    if (errs.length) return { ok: false, error: errs.map((u) => u.message).join('; ') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Refresh the storefront modal feed from a fresh probe (post-change). */
export async function refreshPublicEventFeed(store: TenantStore, admin: AdminGraphql): Promise<void> {
  const probe = await fetchActiveOrderPromos(admin);
  if (probe.ok) await store.putSearchCache('public:event', JSON.stringify(publicEventPayload(probe.promos)), 10 / 1440);
}

/**
 * Nightly rotation: for every ENABLED recurring event, (a) keep its next
 * occurrence scheduled in Shopify (this is what rolls an event over to next
 * year after it ends), and (b) stage the announcement campaign draft once per
 * occurrence when it is within CAMPAIGN_ARM_DAYS. Failures are per-event and
 * reported, never thrown - one broken template must not stop the rest.
 */
export async function rotateRecurringEvents(
  store: TenantStore, admin: AdminGraphql, nowMs = Date.now()
): Promise<{ ensured: number; staged: number; errors: string[] }> {
  const rows = await store.listRecurringEvents();
  const out = { ensured: 0, staged: 0, errors: [] as string[] };
  let changed = false;
  for (const row of rows) {
    if (row.enabled !== 1) continue;
    const t = templateByKey(row.key);
    if (!t) { out.errors.push(`unknown template ${row.key}`); continue; }
    const pct = row.pct_off ?? t.defaultPct;
    const r = await ensureRecurringDiscount(admin, t, pct, nowMs);
    if (!r.ok) { out.errors.push(`${t.key}: ${r.error}`); continue; }
    if (r.action !== 'unchanged') { out.ensured++; changed = true; }
    const startMs = Date.parse(r.window.startsAt);
    if (startMs - nowMs <= CAMPAIGN_ARM_DAYS * 86_400_000 && row.armed_for !== r.window.startsAt) {
      const d = buildEventCampaign({ code: t.code, pctOff: pct, startsAt: r.window.startsAt, endsAt: r.window.endsAt });
      await store.insertCampaign({ audience: 'buyers', subject: d.subject, bodyText: d.bodyText });
      await store.setRecurringArmedFor(t.key, r.window.startsAt);
      out.staged++;
    }
  }
  if (changed) await refreshPublicEventFeed(store, admin);
  return out;
}

/** Console list: catalogue joined with the owner's enable flags + computed
 * next windows. Everything here is derived live - nothing stored but the flag. */
export async function listRecurringForConsole(store: TenantStore, nowMs = Date.now()) {
  const rows = new Map((await store.listRecurringEvents()).map((r) => [r.key, r]));
  return EVENT_TEMPLATES.map((t) => {
    const row = rows.get(t.key);
    const w = t.nextWindow(nowMs);
    return {
      key: t.key, name: t.name, code: t.code,
      defaultPct: t.defaultPct,
      pctOff: row?.pct_off ?? t.defaultPct,
      enabled: row?.enabled === 1,
      headline: t.headline, subline: t.subline, chips: t.chips,
      nextStartsAt: w.startsAt, nextEndsAt: w.endsAt,
      running: Date.parse(w.startsAt) <= nowMs && nowMs < Date.parse(w.endsAt) && row?.enabled === 1
    };
  });
}
