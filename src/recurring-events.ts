import type { AdminGraphql } from './shopify-admin';
import type { TenantStore } from './tenant-store';
import { EVENT_TEMPLATES, templateByKey, type EventTemplate, type EventWindow } from './event-catalogue';
import { buildEventCampaign, publicEventPayload, type PublicEventPayload } from './storewide-event';
import { fetchActiveOrderPromos, type PromoWindow } from './affiliate-discounts';

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
    // NO activation here (removed 2026-09-05). This used to call
    // discountCodeActivate "in case the discount had been retired", believing
    // it harmless. Shopify documents the opposite: activating a discount set to
    // start in the future sets its startsAt to NOW. The first real rollover
    // (SUMMERSALE, window ended 31 Aug 2026) therefore went live for a whole
    // year and the storefront pop-up advertised a Summer bank holiday in
    // September. A retired discount needs no activation either: deactivate
    // only expires it (endsAt = now), and an update to a future window is
    // SCHEDULED by itself. Instead the window is VERIFIED against Shopify, so a
    // rollover that did not land is reported, never assumed.
    const check = await admin(LOOKUP_QUERY, { code: t.code });
    const after = (check.codeDiscountNodeByCode as { codeDiscount?: { status?: string; startsAt?: string } } | null)?.codeDiscount;
    const landed = (after?.startsAt ?? '').slice(0, 10) === w.startsAt.slice(0, 10);
    const expected = Date.parse(w.startsAt) <= nowMs ? 'ACTIVE' : 'SCHEDULED';
    if (!landed || after?.status !== expected) {
      return {
        ok: false,
        error: `${t.code}: re-dated to ${w.startsAt} but Shopify reports ${after?.status ?? 'unknown'} from ${after?.startsAt ?? 'unknown'} (expected ${expected}); left as is, not activated`,
      };
    }
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

/** The catalogue templates the owner has ENABLED (the only ones that can run,
 * so the only ones the storefront may tease as "next"). */
export async function enabledEventTemplates(store: TenantStore): Promise<EventTemplate[]> {
  const rows = await store.listRecurringEvents();
  return rows.filter((r) => r.enabled === 1).map((r) => templateByKey(r.key)).filter((t): t is EventTemplate => t !== null);
}

/** The single builder of the public feed: the live promos plus the next enabled
 * calendar event. Every writer of 'public:event' goes through here so the
 * storefront and the inbox never see a feed missing the tease. */
export async function buildPublicEventFeed(store: TenantStore, promos: PromoWindow[], nowMs = Date.now()): Promise<PublicEventPayload> {
  return publicEventPayload(promos, nowMs, await enabledEventTemplates(store));
}

/** Refresh the storefront feed from a fresh probe (post-change). */
export async function refreshPublicEventFeed(store: TenantStore, admin: AdminGraphql): Promise<void> {
  const probe = await fetchActiveOrderPromos(admin);
  if (probe.ok) await store.putSearchCache('public:event', JSON.stringify(await buildPublicEventFeed(store, probe.promos)), 10 / 1440);
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

/** Memory of the last failure set the owner was told about (search_cache
 * key/value row; 30-day TTL so a failure nobody fixed is repeated monthly). */
const ROTATION_ALERT_KEY = 'recurring-events:alerted';
const ROTATION_ALERT_TTL_DAYS = 30;

/** Turn a rotation's errors into ONE owner email per distinct failure set.
 * The nightly stage runs every day, so "same failure again" must not mean
 * "same email again": the sorted error list is the signature; a run that
 * matches the remembered signature is silent, a different one alerts, and a
 * clean run clears the memory so the original failure returning is news.
 * `send` is the delivery (the stage wires alertOwner); returns whether it
 * was called. */
export async function alertRotationErrors(
  store: TenantStore, errors: string[], send: (subject: string, text: string) => Promise<void>
): Promise<boolean> {
  const signature = [...errors].sort().join('\n');
  const remembered = (await store.getSearchCache(ROTATION_ALERT_KEY)) ?? '';
  if (!signature) {
    if (remembered) await store.putSearchCache(ROTATION_ALERT_KEY, '', ROTATION_ALERT_TTL_DAYS);
    return false;
  }
  if (signature === remembered) return false;
  await store.putSearchCache(ROTATION_ALERT_KEY, signature, ROTATION_ALERT_TTL_DAYS);
  const n = errors.length;
  await send(
    `Event rotation needs attention: ${n} event${n === 1 ? '' : 's'} not scheduled as expected`,
    `The nightly event rotation could not keep every enabled event scheduled in Shopify:\n\n`
      + errors.map((e) => `- ${e}`).join('\n')
      + `\n\nOpen the Events view in PawScout to check the affected discount; disabling and re-enabling the event re-runs the schedule under the current rules. This email repeats only if the failure set changes.`
  );
  return true;
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
