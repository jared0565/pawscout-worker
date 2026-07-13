import type { AdminGraphql } from './shopify-admin';
import type { TenantStore } from './tenant-store';

// Voucher issuance (2026-07-05, owner's performance-test policy): the trial
// code IS the evaluation, so creating it must cost the owner nothing. This
// module mints the Shopify discount and registers the ledger row in one move,
// with EVENT-AWARE TIMING: a partner code must never go live while a bigger
// storewide promotion is running (a 5% code during a 10% event is worse than
// useless - the customer already has more, and entering the code could cost
// them). New vouchers are scheduled to start right after the last conflicting
// promotion ends. A conflicting promotion with NO end date blocks automatic
// scheduling and falls back to the owner (HITL), never a guess.
//
// Invariant upheld by ALL callers: a code is only minted when its invite is
// actually going out (auto-issue send) or the owner explicitly clicked Issue -
// never speculatively at draft time.

export const TRIAL_DAYS_DEFAULT = 30;
export const TRIAL_USAGE_LIMIT_DEFAULT = 100; // hard ceiling per code: bounds a leak the same way revoke does, but automatically
const DEFER_GAP_MS = 5 * 60_000; // start a deferred voucher a beat after the event ends, never at the same instant
const TRIAL_PCT_OFF_FALLBACK = 5; // window sizing when the caller gives no pct (mirrors partnership.TRIAL_PCT_OFF_DEFAULT without a circular import)

export interface PromoWindow {
  title: string;
  kind: string;              // Basic | Bxgy (order-level money promos; free shipping is ignored - it does not compete with a percentage code)
  source: 'automatic' | 'code'; // storewide events can be EITHER (WELCOME10 is a code discount - the 2026-07-05 gap)
  percentage: number | null; // 0-100 for percentage discounts; null = fixed-amount/unknown (treated conservatively)
  status: string;            // ACTIVE | SCHEDULED
  startsAt: string | null;
  endsAt: string | null;     // null = open-ended
  code: string | null;       // the redeemable code string for code discounts (storefront modal needs it); null for automatic
}

/** Our own minted trials carry this title prefix - they are never conflicts. */
export const PARTNER_TRIAL_TITLE_PREFIX = 'Partner trial ';

const PROMOS_QUERY = `query pawscoutActivePromos {
  automaticDiscountNodes(first: 25) {
    nodes {
      automaticDiscount {
        __typename
        ... on DiscountAutomaticBasic { title status startsAt endsAt customerGets { value { __typename ... on DiscountPercentage { percentage } } } }
        ... on DiscountAutomaticBxgy { title status startsAt endsAt }
      }
    }
  }
  codeDiscountNodes(first: 50, query: "status:active OR status:scheduled") {
    nodes {
      codeDiscount {
        __typename
        ... on DiscountCodeBasic { title status startsAt endsAt codes(first: 1) { nodes { code } } customerGets { value { __typename ... on DiscountPercentage { percentage } } } }
        ... on DiscountCodeBxgy { title status startsAt endsAt codes(first: 1) { nodes { code } } }
      }
    }
  }
}`;

interface RawPromo {
  __typename?: string; title?: string; status?: string; startsAt?: string | null; endsAt?: string | null;
  codes?: { nodes?: { code?: string }[] } | null;
  customerGets?: { value?: { __typename?: string; percentage?: number } | null } | null;
}

function toPromo(d: RawPromo, source: 'automatic' | 'code'): PromoWindow | null {
  if (!d.__typename || !/(Basic|Bxgy)$/.test(d.__typename)) return null;
  if (d.status !== 'ACTIVE' && d.status !== 'SCHEDULED') return null;
  const title = d.title ?? '(untitled promotion)';
  if (title.startsWith(PARTNER_TRIAL_TITLE_PREFIX)) return null; // our own trials never conflict with each other
  const pct = d.customerGets?.value?.__typename === 'DiscountPercentage' && typeof d.customerGets.value.percentage === 'number'
    ? d.customerGets.value.percentage * 100
    : null;
  return {
    title, source,
    kind: d.__typename.replace(/^DiscountAutomatic|^DiscountCode/, ''),
    percentage: pct,
    status: d.status,
    startsAt: d.startsAt ?? null,
    endsAt: d.endsAt ?? null,
    code: source === 'code' ? (d.codes?.nodes?.[0]?.code ?? null) : null
  };
}

/** Storewide order-level promotions that are running or scheduled - AUTOMATIC
 * discounts and CODE discounts both (the live 10% event is a code, WELCOME10).
 * The probe doubles as the write_discounts scope check: ACCESS_DENIED surfaces
 * as reconnectRequired so the console can tell the owner to re-approve the app. */
export async function fetchActiveOrderPromos(
  admin: AdminGraphql
): Promise<{ ok: true; promos: PromoWindow[] } | { ok: false; error: string; reconnectRequired: boolean }> {
  try {
    const data = await admin(PROMOS_QUERY);
    const promos: PromoWindow[] = [];
    for (const n of (data.automaticDiscountNodes as { nodes?: { automaticDiscount?: RawPromo }[] } | undefined)?.nodes ?? []) {
      const p = n.automaticDiscount && toPromo(n.automaticDiscount, 'automatic');
      if (p) promos.push(p);
    }
    for (const n of (data.codeDiscountNodes as { nodes?: { codeDiscount?: RawPromo }[] } | undefined)?.nodes ?? []) {
      const p = n.codeDiscount && toPromo(n.codeDiscount, 'code');
      if (p) promos.push(p);
    }
    return { ok: true, promos };
  } catch (e) {
    const msg = (e as Error).message ?? '';
    return { ok: false, error: msg, reconnectRequired: /access ?denied|required access|not approved|403/i.test(msg) };
  }
}

/** Overlap test on [aStart, aEnd) windows where null start = already started and null end = forever. */
function overlaps(promo: PromoWindow, startMs: number, endMs: number): boolean {
  const pStart = promo.startsAt ? Date.parse(promo.startsAt) : -Infinity;
  const pEnd = promo.endsAt ? Date.parse(promo.endsAt) : Infinity;
  return pStart < endMs && pEnd > startMs;
}

/** Does this promotion outcompete a pctOff voucher? Automatic discounts always
 * do (they apply without a code, so the voucher adds nothing while they run).
 * Code events conflict when they give MORE than the voucher (a customer with
 * WELCOME10 at 10% loses money entering a 5% partner code) or when their value
 * is unknown/fixed-amount (conservative). A smaller or equal code promo leaves
 * the voucher meaningful, so it does not defer it. */
function outcompetes(promo: PromoWindow, pctOff: number): boolean {
  if (promo.source === 'automatic') return true;
  return promo.percentage === null || promo.percentage > pctOff;
}

export type VoucherWindow =
  | { ok: true; startsAt: string; endsAt: string; deferredBehind: string | null }
  | { ok: false; blockedBy: string };

/**
 * Pick the voucher's live window around the store's promotions. No conflict →
 * starts now. Conflicting promos with end dates → starts just after the LAST
 * one ends (chained events push it further). Any conflicting promo without an
 * end date → blocked (the owner decides; we never launch a code into an
 * open-ended event and never guess when one ends).
 */
export function resolveVoucherWindow(
  promos: PromoWindow[],
  opts: { now: number; trialDays?: number; pctOff?: number }
): VoucherWindow {
  const trialMs = (opts.trialDays ?? TRIAL_DAYS_DEFAULT) * 86_400_000;
  const pctOff = opts.pctOff ?? TRIAL_PCT_OFF_FALLBACK;
  const rivals = promos.filter((p) => outcompetes(p, pctOff));
  let startMs = opts.now;
  let deferredBehind: string | null = null;
  // Iterate to a fixed point: deferring past one event can land inside the next.
  for (let pass = 0; pass < rivals.length + 1; pass++) {
    const hit = rivals.find((p) => overlaps(p, startMs, startMs + trialMs));
    if (!hit) break;
    if (!hit.endsAt) return { ok: false, blockedBy: hit.title };
    startMs = Date.parse(hit.endsAt) + DEFER_GAP_MS;
    deferredBehind = hit.title;
  }
  return {
    ok: true,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + trialMs).toISOString(),
    deferredBehind
  };
}

/** ACTIVEPAW-<NAME><PCT>, e.g. ACTIVEPAW-SAMLARRY5. Salt suffixes a collision retry. */
export function genVoucherCode(name: string | null, email: string, pctOff: number, salt = ''): string {
  const base = (name ?? email.split('@')[0]).replace(/[^a-z]/gi, '').toUpperCase().slice(0, 12) || 'PARTNER';
  return `ACTIVEPAW-${base}${Math.round(pctOff)}${salt}`;
}

const CREATE_MUTATION = `mutation pawscoutVoucherCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

/** Create the code discount in Shopify: percentage off everything, once per
 * customer, combines with NOTHING (a partner code never stacks on an event),
 * hard usage ceiling, explicit start and end. */
export async function createVoucherDiscount(
  admin: AdminGraphql,
  v: { code: string; pctOff: number; startsAt: string; endsAt: string; usageLimit: number }
): Promise<{ ok: true; discountId: string } | { ok: false; error: string; reconnectRequired: boolean }> {
  try {
    const data = await admin(CREATE_MUTATION, {
      basicCodeDiscount: {
        title: `Partner trial ${v.code}`,
        code: v.code,
        startsAt: v.startsAt,
        endsAt: v.endsAt,
        usageLimit: v.usageLimit,
        appliesOncePerCustomer: true,
        customerSelection: { all: true },
        customerGets: { value: { percentage: v.pctOff / 100 }, items: { all: true } },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false }
      }
    });
    const res = data.discountCodeBasicCreate as { codeDiscountNode?: { id?: string } | null; userErrors?: { message?: string }[] } | undefined;
    const errs = res?.userErrors ?? [];
    if (errs.length) return { ok: false, error: errs.map((u) => u.message).join('; '), reconnectRequired: false };
    const id = res?.codeDiscountNode?.id;
    if (!id) return { ok: false, error: 'Shopify returned no discount id', reconnectRequired: false };
    return { ok: true, discountId: id };
  } catch (e) {
    const msg = (e as Error).message ?? '';
    return { ok: false, error: msg, reconnectRequired: /access ?denied|required access|not approved|403/i.test(msg) };
  }
}

export interface VoucherLookupResult {
  found: boolean;
  discountId?: string;
  startsAt?: string;
  endsAt?: string;
  pctOff?: number;
  usageLimit?: number | null;
}

const VOUCHER_LOOKUP_QUERY = `query pawscoutVoucherLookup($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    codeDiscount {
      __typename
      ... on DiscountCodeBasic {
        startsAt
        endsAt
        usageLimit
        customerGets { value { __typename ... on DiscountPercentage { percentage } } }
      }
    }
  }
}`;

/**
 * Read-only lookup: does a code discount with this EXACT code already exist
 * in Shopify? Used by the screen lane's double-mint recovery guard (Task 4
 * follow-up) - a prior tick's `createVoucherDiscount` can succeed in Shopify
 * while the D1 write that follows it throws, leaving a live, untracked code.
 * Retrying with the same deterministic `genVoucherCode` output would collide
 * and fall through to a SALTED second mint (two live codes for one
 * applicant, the first untracked forever). The caller looks this up BEFORE
 * issuing and reconciles the missing D1 row instead. Best-effort: any lookup
 * failure (network, scope) reports not-found so the caller falls through to
 * its normal issuance path rather than blocking on this.
 */
export async function findVoucherDiscountByCode(admin: AdminGraphql, code: string): Promise<VoucherLookupResult> {
  try {
    const data = await admin(VOUCHER_LOOKUP_QUERY, { code });
    const node = data.codeDiscountNodeByCode as { id?: string; codeDiscount?: RawPromo | null } | null;
    if (!node?.id || !node.codeDiscount) return { found: false };
    const cd = node.codeDiscount;
    const pctOff = cd.customerGets?.value?.__typename === 'DiscountPercentage' && typeof cd.customerGets.value.percentage === 'number'
      ? cd.customerGets.value.percentage * 100
      : undefined;
    return {
      found: true,
      discountId: node.id,
      startsAt: cd.startsAt ?? undefined,
      endsAt: cd.endsAt ?? undefined,
      usageLimit: (cd as { usageLimit?: number | null }).usageLimit ?? null,
      pctOff
    };
  } catch {
    return { found: false };
  }
}

export interface IssueResult {
  ok: true;
  code: string;
  pctOff: number;
  commissionPct: number;
  startsAt: string;
  endsAt: string;
  deferredBehind: string | null;
  partnerId: string;
  voucherId: string;
}

/**
 * The one-move issue: conflict-aware window → Shopify discount → partner +
 * voucher ledger rows. One code-collision retry with a numeric salt. Callers
 * only invoke this at genuine issue moments (owner click / auto-issue send).
 */
export async function issueVoucher(
  store: TenantStore,
  admin: AdminGraphql,
  req: { email: string; name?: string | null; pctOff: number; commissionPct: number; trialDays?: number; usageLimit?: number; now?: number }
): Promise<IssueResult | { ok: false; error: string; reconnectRequired?: boolean }> {
  const now = req.now ?? Date.now();
  const probe = await fetchActiveOrderPromos(admin);
  if (!probe.ok) return { ok: false, error: probe.error, reconnectRequired: probe.reconnectRequired };
  const win = resolveVoucherWindow(probe.promos, { now, trialDays: req.trialDays, pctOff: req.pctOff });
  if (!win.ok) return { ok: false, error: `Cannot schedule around "${win.blockedBy}" - it has no end date. End or date-limit that promotion first.` };

  const usageLimit = req.usageLimit ?? TRIAL_USAGE_LIMIT_DEFAULT;
  let code = genVoucherCode(req.name ?? null, req.email, req.pctOff);
  let created = await createVoucherDiscount(admin, { code, pctOff: req.pctOff, startsAt: win.startsAt, endsAt: win.endsAt, usageLimit });
  if (!created.ok && /already|taken|exists/i.test(created.error)) {
    code = genVoucherCode(req.name ?? null, req.email, req.pctOff, String(now % 97));
    created = await createVoucherDiscount(admin, { code, pctOff: req.pctOff, startsAt: win.startsAt, endsAt: win.endsAt, usageLimit });
  }
  if (!created.ok) return created;

  const partnerId = await store.upsertAffiliatePartner({ contactEmail: req.email, name: req.name ?? null });
  const voucherId = await store.createAffiliateVoucher({
    partnerId, code, pctOff: req.pctOff, commissionPct: req.commissionPct,
    startsAt: win.startsAt, endsAt: win.endsAt, usageLimit
  });
  return {
    ok: true, code, pctOff: req.pctOff, commissionPct: req.commissionPct,
    startsAt: win.startsAt, endsAt: win.endsAt, deferredBehind: win.deferredBehind,
    partnerId, voucherId
  };
}

/** Deactivate a code discount in Shopify by its code (used when the owner
 * revokes a trial - now that write_discounts is granted, revoke really turns
 * the code off instead of reminding the owner to do it by hand). Best-effort:
 * a lookup/mutation failure is reported, never thrown. */
export async function deactivateVoucherDiscount(
  admin: AdminGraphql, code: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const found = await admin(
      `query pawscoutVoucherByCode($code: String!) { codeDiscountNodeByCode(code: $code) { id } }`,
      { code }
    );
    const id = (found.codeDiscountNodeByCode as { id?: string } | null)?.id;
    if (!id) return { ok: false, error: `No Shopify discount found for code ${code}` };
    const res = await admin(
      `mutation pawscoutVoucherDeactivate($id: ID!) { discountCodeDeactivate(id: $id) { userErrors { message } } }`,
      { id }
    );
    const errs = (res.discountCodeDeactivate as { userErrors?: { message?: string }[] } | undefined)?.userErrors ?? [];
    if (errs.length) return { ok: false, error: errs.map((u) => u.message).join('; ') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** '8 August 2026' - deterministic UTC date for customer-facing copy. */
export function voucherDateLabel(iso: string): string {
  const d = new Date(iso);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
