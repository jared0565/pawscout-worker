import { Vault } from './vault';
import { TenantStore, listActiveShops } from './tenant-store';
import { makeAdminGraphql, type AdminGraphql } from './shopify-admin';
import { CjClient, CjTokenManager, cjFetchFromEnv, chooseOrigin, type CjDetail } from './cj';
import { getPrimaryLocationId, productInventoryItems, setInventoryQuantities } from './proxy/inventory';
import { resyncLowStockInventory, JOB_STAMP_PIPELINE, JOB_STAMP_TTL_DAYS } from './jobs';
import { attributeAffiliateOrders } from './affiliate-attribution';
import { sendEmail } from './email';
import type { Env, TenantConfig } from './types';
import type { OrderLineItem, OrderAddress } from './fulfil';
import { readOrderGate, decideGate, type RiskLevel } from './order-gate';
import { alertOwner } from './owner-alert';
import { deliverOrderAlert, retryOrderAlerts, type AlertSend } from './order-alert';
import { applyCancel } from './order-cancel';

// W-FULFIL Stage B: turn queued orders into paid CJ orders, then write tracking
// back to Shopify. The money leg (createOrder + payBalance) only runs when
// cfg.fulfil.mode is 'pawscout' - otherwise orders just sit queued ('manual') or
// are left to CJ's native Shopify app ('cj').

/** Match a line's sku to a CJ variant id (vid) + dispatch origin within one CjDetail. */
function matchVariant(detail: CjDetail, sku: string, stockFloor: number): { vid: string; origin: string } | null {
  const variants = detail.variants ?? [];
  // Match by sku; fall back to the sole variant when there's only one.
  const v = (sku && variants.find((x) => x.sku === sku)) || (variants.length === 1 ? variants[0] : undefined);
  if (!v?.vid || v.vid === 'default') return null;
  const origin = detail.origin ?? chooseOrigin(detail, stockFloor);
  return { vid: v.vid, origin };
}

/**
 * Resolve a line's CJ vid + origin. Tries the warehouse pool first (no API call),
 * then falls back to a live CJ product lookup - imported/live products are NOT
 * guaranteed to have a warehouse_products row (the pool is culled/refreshed), so
 * without this fallback ~half of live orders would fail to resolve.
 */
async function resolveLine(store: TenantStore, cj: CjClient, cjPid: string, sku: string, stockFloor: number): Promise<{ vid: string; origin: string } | null> {
  const wh = await store.getWarehouseProduct(cjPid);
  if (wh) {
    try {
      const m = matchVariant(JSON.parse(wh.detail) as CjDetail, sku, stockFloor);
      if (m) return m;
    } catch { /* fall through to a live CJ lookup */ }
  }
  const live = await cj.detail(cjPid).catch(() => null);
  return live ? matchVariant(live, sku, stockFloor) : null;
}

const FULFILLMENT_ORDERS = `query pawscoutFOs($id: ID!) {
  order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } }
}`;

/** True only when the order's PRIOR hold reasons include a FRAUD hold
 *  (high-risk or medium-risk-value): only then does an operator's release
 *  outrank the automated fraud check (fix round 1, M-7 - their decision was on
 *  THAT hold, not on every possible hold). A hold for any other reason
 *  (mixed-origin, not-paid, already-fulfilled, incomplete-address, on-hold,
 *  order-missing, refunded) never bypasses fraud. A corrupt hold_reasons value
 *  does NOT count as fraud history - err toward running the fraud check, not
 *  skipping it. Every OTHER gate check (cancelled/paid/fulfilled/address)
 *  always applies regardless - see decideGate's skipRisk parameter. */
function hasFraudHoldHistory(holdReasonsJson: string | null): boolean {
  if (!holdReasonsJson) return false;
  try {
    const reasons = JSON.parse(holdReasonsJson) as unknown[];
    return reasons.includes('high-risk') || reasons.includes('medium-risk-value');
  } catch { return false; }
}

/** Write a cancel/hold gate decision to the row + trail in one place, so the
 *  pre-create and pre-pay checks (points 2 and 5 below) stay identical. Uses
 *  updateOrderUnlessCancelled (fix round 1, I-3): a row that meanwhile became
 *  'cancelled' from a concurrent cancel is left alone - nothing more to do,
 *  the trail event is still written either way. `detail` overrides the trail
 *  text when it needs to carry more than the hold reason (mixed-origin).
 *  riskLevel is descriptive only - never gate on it here, just stamp it when
 *  known. `keepReasons`, when passed, keeps those reasons ahead of the new
 *  one (deduped) instead of replacing hold_reasons outright - the pull check
 *  is the only caller that passes it, because it reads rows that were
 *  already parked and whose existing reasons (an error row's failure text, an
 *  address-changed hold) are the only persisted record of why. The two
 *  processDueOrders stop branches call this with no such argument and keep
 *  replacing, because there the gate's decision IS the row's whole reason at
 *  that moment. The gate-held trail detail stays the new reason alone either
 *  way. */
async function writeGateStop(
  store: TenantStore, shopifyOrderId: string, status: 'cancelled' | 'held', reason: string, riskLevel: RiskLevel, detail: string = reason, keepReasons?: string[]
): Promise<void> {
  const reasons = keepReasons ? [...new Set([...keepReasons, reason])] : [reason];
  await store.updateOrderUnlessCancelled(shopifyOrderId, { status, hold_reasons: JSON.stringify(reasons), ...(riskLevel ? { risk_level: riskLevel } : {}) });
  await store.addOrderEvent(shopifyOrderId, 'gate-held', detail);
}

/** Fix round 1, I-1: a pre-create gate stop on a row that already has a
 *  supplier order must tell the owner. A release can put a row back to
 *  'queued' with cj_order_id still set (an unpaid awaiting-payment row, or a
 *  paid submitted row), and nothing else alerts for that case. Make no claim
 *  about payment either way - the owner must check at the supplier. */
async function alertIfSupplierOrderExists(
  store: TenantStore,
  o: { shopify_order_id: string; order_name: string | null; cj_order_id: string | null },
  reason: string,
  alert?: AlertSend
): Promise<void> {
  if (!o.cj_order_id || !alert) return;
  const name = o.order_name ?? o.shopify_order_id;
  await deliverOrderAlert(store, o.shopify_order_id, {
    subject: `Order ${name} was stopped and a supplier order exists for it`,
    text: `Order ${name} was stopped by the check against Shopify (${reason}). Supplier order ${o.cj_order_id} already exists for it. Do NOT pay it. Check its state at the supplier: cancel it there if it is unpaid, and treat it as a return if it has been paid.`
  }, alert);
}

/** A delivery address changed in Shopify after a supplier order already
 *  exists for this row. The caller has already saved the fresh address and
 *  recorded address-refreshed; this stops the row here rather than let it
 *  pay (or be paid by hand) against a supplier order that still carries the
 *  address it was created with. Shared by processDueOrders' pre-create and
 *  pre-pay positions, so both read the same hold reason, trail detail and
 *  alert text. The alert never repeats the address itself. */
async function holdForAddressChangeAfterSupplierOrder(
  store: TenantStore, o: { shopify_order_id: string; order_name: string | null }, cjOrderId: string, alert?: AlertSend
): Promise<void> {
  await writeGateStop(store, o.shopify_order_id, 'held', 'address-changed-after-supplier-order', null);
  if (!alert) return;
  const name = o.order_name ?? o.shopify_order_id;
  await deliverOrderAlert(store, o.shopify_order_id, {
    subject: `Order ${name}: the delivery address changed after the supplier order was created`,
    text: `The delivery address of order ${name} was changed in Shopify after supplier order ${cjOrderId} was created, so the supplier order still carries the old address. Do NOT pay it as it stands. Correct the address on the supplier order at the supplier, then release the order in the PawScout console. If the supplier cannot change it, cancel the supplier order there and handle this order by hand.`
  }, alert);
}

/** A gate read failure means "could not tell" - fail CLOSED (never proceed to
 *  spend). The row is left untouched so the next 15-minute tick retries it.
 *  On the 4th-or-later consecutive failure (>= 4, not === 4, so one swallowed
 *  addOrderEvent write can never permanently silence an order) tell the
 *  owner once. `cjOrderId` is the row's supplier order id when one exists -
 *  passed by the caller, since only the caller knows whether it is at the
 *  pre-create position (o.cj_order_id, set on a pay-retry) or the pre-pay
 *  position (always set by then) - and picks which of the two texts is
 *  actually true. `opts.ownerPays`, when true, swaps in the text that is
 *  true for the pull check's own callers: those rows are not ones PawScout is
 *  about to pay, the owner is, so the text says to check Shopify before
 *  paying or settling at the supplier rather than claiming PawScout will not
 *  pay it. Delivery (and the trail marker for it) goes through
 *  deliverOrderAlert, which never throws. */
async function handleGateUnreadable(
  store: TenantStore,
  o: { shopify_order_id: string; order_name: string | null },
  error: string,
  cjOrderId: string | null,
  alert?: AlertSend,
  opts?: { ownerPays?: boolean }
): Promise<void> {
  await store.addOrderEvent(o.shopify_order_id, 'gate-unreadable', error);
  if ((await store.countTrailingOrderEvents(o.shopify_order_id, 'gate-unreadable')) < 4) return;
  const name = o.order_name ?? o.shopify_order_id;
  if (!alert) return;
  const text = cjOrderId
    ? (opts?.ownerPays
        ? `Order ${name} could not be checked against Shopify on the last 4 checks (${error}). Supplier order ${cjOrderId} exists for it. Check the order in Shopify before you pay or settle anything for it at the supplier. It is retried every 15 minutes.`
        : `Order ${name} could not be checked against Shopify on the last 4 checks (${error}). Supplier order ${cjOrderId} exists for it, and PawScout will not pay it until the check succeeds. It is retried every 15 minutes.`)
    : `Order ${name} is due, but its state in Shopify could not be read on the last 4 checks (${error}). Nothing has been sent to the supplier. It is retried every 15 minutes.`;
  await deliverOrderAlert(store, o.shopify_order_id, { subject: `Order ${name} cannot be checked against Shopify`, text }, alert);
}

const FULFILL = `mutation pawscoutFulfill($f: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } }
}`;

/** Build the buyer-facing tracking URL: prefer CJ's own URL, else a universal
 * 17track lookup by number (CJ's carriers are rarely in Shopify's recognised list,
 * so without a url the buyer would see a bare, unclickable number). */
function trackingUrlFor(trackNumber: string, cjUrl: string): string {
  if (cjUrl && /^https?:\/\//i.test(cjUrl)) return cjUrl;
  return `https://t.17track.net/en#nums=${encodeURIComponent(trackNumber)}`;
}

/** Write a tracking number back to Shopify (fulfils the order's open fulfillment orders). */
async function writeTracking(admin: AdminGraphql, orderGid: string, trackNumber: string, company: string, url: string): Promise<void> {
  const data = await admin(FULFILLMENT_ORDERS, { id: orderGid }) as {
    order?: { fulfillmentOrders?: { nodes?: { id: string; status: string }[] } };
  };
  const fos = (data.order?.fulfillmentOrders?.nodes ?? []).filter(
    (n) => n.status === 'OPEN' || n.status === 'IN_PROGRESS' || n.status === 'SCHEDULED'
  );
  if (!fos.length) throw new Error('no open fulfillment order to fulfil');
  const r = await admin(FULFILL, {
    f: {
      lineItemsByFulfillmentOrder: fos.map((fo) => ({ fulfillmentOrderId: fo.id })),
      // url gives the buyer a working "Track your order" button; company is the
      // displayed carrier name (Shopify still uses our url for the link).
      trackingInfo: { number: trackNumber, ...(company ? { company } : {}), ...(url ? { url } : {}) },
      notifyCustomer: true
    }
  }) as { fulfillmentCreate?: { userErrors?: { message: string }[] } };
  const errs = r.fulfillmentCreate?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/** CJ error phrasings that mean "no source stock" - the backstop classifier for
 * createOrder failures (the deterministic pre-flight below catches most cases). */
export function isStockoutError(msg: string): boolean {
  return /out of stock|sold ?out|insufficient (?:stock|inventory)|not enough stock|stock (?:is )?not enough|no stock|inventory shortage|缺货|库存不足/i.test(msg);
}

/** Thrown by the pre-flight source-stock check: carries the failing line so the
 * error branch can zero exactly the right variant. */
class StockoutError extends Error {
  constructor(public cjPid: string, public sku: string, msg: string) { super(msg); }
}

export interface StockoutNotice {
  shopifyOrderId: string;
  orderName: string;
  item: string;    // sku or cjPid of the failing line
  detail: string;  // what happened
  zeroed: boolean; // whether the variant was hidden from sale
}

/** A payBalance failure that means "wallet has no/insufficient funds" - recoverable
 * by the owner topping up + paying in CJ, NOT a code/data bug. We downgrade these
 * to 'awaiting-payment' instead of 'error'. CJ phrases it a few ways. */
function looksLikeInsufficientBalance(msg: string): boolean {
  return /insufficient|not enough|balance|余额|recharge|top.?up|payment failed/i.test(msg);
}

/** Owner alert payload when an order is created in CJ and is awaiting manual payment. */
export interface AwaitingPaymentNotice {
  shopifyOrderId: string;
  orderName: string;
  cjOrderId: string;
  total: number | null;
  currency: string | null;
  reason: string;
}

/**
 * Submit queued orders to CJ and (optionally) pay them. GATED on
 * cfg.fulfil.mode==='pawscout' - a no-op in 'manual'/'cj' (orders stay queued /
 * left to CJ's app). createOrder is skipped when cj_order_id is already set (so a
 * pay-retry never duplicates the CJ order).
 *
 * Payment legs:
 *  - cfg.fulfil.createOnly === true → PS creates the CJ order and STOPS, leaving
 *    it 'awaiting-payment' (owner pays it manually in CJ; tracking poll picks it
 *    up afterwards). This is the interim path while the CJ wallet is unfunded.
 *  - otherwise PS calls payBalance. On success → 'submitted'. If payBalance fails
 *    for insufficient balance, the CJ order still exists, so we downgrade to
 *    'awaiting-payment' (owner pays it manually) rather than 'error'. Any other
 *    failure → 'error' (operator releases it to retry). One failure never aborts
 *    the batch.
 *
 * opts.notify fires once, at the transition into 'awaiting-payment' (best-effort;
 * a notify failure never fails the order). The order is not reprocessed once
 * awaiting-payment, so it's emailed exactly once.
 */
export async function processDueOrders(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  opts: {
    now?: () => number; max?: number;
    notify?: (n: AwaitingPaymentNotice) => Promise<void>; notifyStockout?: (n: StockoutNotice) => Promise<void>;
    alert?: AlertSend;
  } = {}
): Promise<{ submitted: number; awaiting: number; held: number; errored: number; skipped: boolean }> {
  if (cfg.fulfil.mode !== 'pawscout') return { submitted: 0, awaiting: 0, held: 0, errored: 0, skipped: true }; // 'manual'/'cj' → PawScout doesn't pay
  const createOnly = cfg.fulfil.createOnly === true;
  const nowIso = new Date(opts.now ? opts.now() : Date.now()).toISOString();
  const due = await store.dueQueuedOrders(nowIso, opts.max ?? 10);
  let submitted = 0;
  let awaiting = 0;
  let held = 0;
  let errored = 0;
  const markAwaiting = async (o: typeof due[number], cjOrderId: string, reason: string) => {
    // Fix round 1, I-3: a cancel can land in Shopify while createOrder (or an
    // insufficient-balance retry) is in flight. updateOrderUnlessCancelled is
    // the one atomic check-and-write; if it refuses, the row is already
    // 'cancelled' and must NOT be told to the owner as "pay it".
    const wrote = await store.updateOrderUnlessCancelled(o.shopify_order_id, { status: 'awaiting-payment', hold_reasons: JSON.stringify([reason]) });
    if (!wrote) {
      held++;
      const name = o.order_name ?? o.shopify_order_id;
      if (opts.alert) {
        await deliverOrderAlert(store, o.shopify_order_id, {
          subject: `Order ${name} was cancelled while its supplier order was being created`,
          text: `Order ${name} was cancelled in Shopify while supplier order ${cjOrderId} was being created. Do NOT pay it. Cancel it at the supplier.`
        }, opts.alert);
      }
      return;
    }
    await store.addOrderEvent(o.shopify_order_id, 'awaiting-payment');
    awaiting++;
    if (opts.notify) {
      try {
        await opts.notify({ shopifyOrderId: o.shopify_order_id, orderName: o.order_name ?? o.shopify_order_id, cjOrderId, total: o.total_price, currency: o.currency, reason });
      } catch (e) {
        console.warn(`awaiting-payment notify failed for ${o.order_name ?? o.shopify_order_id}: ${(e as Error).message}`);
      }
    }
  };
  for (const o of due) {
    let lineItems: OrderLineItem[] = [];
    // Fix round 1, I-4: tracks how far the order got, so a catch that is NOT a
    // classified stockout writes "failed at <step>" instead of ever copying a
    // supplier's raw error text (which can echo the address or phone we sent).
    // Fix round 2, NEW-3: starts at 'gate' (before the address/line-items JSON
    // parses below), not 'resolve' - a throw there has resolved nothing yet.
    // It becomes 'resolve' only once the line-resolution loop begins (below).
    let step: 'gate' | 'resolve' | 'stock' | 'freight' | 'create' | 'pay' | 'record' = 'gate';
    try {
      // Live-order gate (2026-09-19): a whitelist on Shopify's own state, read HERE,
      // just before money moves. Every check (cancelled/paid/fulfilled/address) always
      // applies; only the fraud-risk sub-check is skipped for a pay-retry (already has
      // a CJ order) or an operator-released order with FRAUD hold history (their call
      // outranks the automated fraud gate, but not a genuine cancellation, and not a
      // hold for any other reason - fix round 1, M-7).
      const skipRisk = !!o.cj_order_id || hasFraudHoldHistory(o.hold_reasons);
      const storedAddress = o.address_json ? (JSON.parse(o.address_json) as OrderAddress) : null;

      const gateRead = await readOrderGate(admin, o.shopify_order_id);
      if (!gateRead.ok) {
        await handleGateUnreadable(store, o, gateRead.error, o.cj_order_id ?? null, opts.alert);
        continue; // NOT an error status - stays queued, retried next tick
      }
      const decision = decideGate(gateRead.snapshot, { address: storedAddress, totalPrice: o.total_price ?? 0, skipRisk });
      if (decision.action !== 'proceed') {
        // Fix round 1, M-1: require 'proceed' rather than reach it by excluding
        // 'cancel'/'hold' - a future fourth variant fails the build below
        // instead of silently falling through to create or pay.
        if (decision.action === 'cancel') {
          await writeGateStop(store, o.shopify_order_id, 'cancelled', decision.reason, null);
          held++;
          await alertIfSupplierOrderExists(store, o, decision.reason, opts.alert); // fix round 1, I-1
        } else if (decision.action === 'hold') {
          await writeGateStop(store, o.shopify_order_id, 'held', decision.reason, decision.riskLevel);
          held++;
          await alertIfSupplierOrderExists(store, o, decision.reason, opts.alert); // fix round 1, I-1
        } else {
          const _exhaustive: never = decision;
        }
        continue;
      }

      // Written once, on first submission only: a pay-retry re-evaluates the
      // same milestones every tick, and repeating this on every retry would
      // both spam the trail and (fix round 1, I-2) make the pre-pay
      // gate-unreadable counter below unable to ever see a clean run of 4
      // consecutive failures, since this write would break the run every time.
      if (!o.cj_order_id) await store.addOrderEvent(o.shopify_order_id, 'gate-passed');
      const address: OrderAddress = decision.address;
      if (decision.addressChanged) {
        await store.updateOrder(o.shopify_order_id, { address_json: JSON.stringify(address) });
        await store.addOrderEvent(o.shopify_order_id, 'address-refreshed');
        if (o.cj_order_id) {
          // A pay-retry: a supplier order already exists and it still carries
          // the address that has just been replaced. Stop here rather than
          // carry it through to line resolution and a payment.
          await holdForAddressChangeAfterSupplierOrder(store, o, o.cj_order_id, opts.alert);
          held++;
          continue;
        }
      }
      if (decision.riskLevel) await store.updateOrder(o.shopify_order_id, { risk_level: decision.riskLevel }); // console visibility on clean flows too

      lineItems = JSON.parse(o.line_items_json ?? '[]') as OrderLineItem[];

      const products: { vid: string; quantity: number }[] = [];
      const origins: string[] = [];
      for (const li of lineItems) {
        step = 'resolve';
        const resolved = li.cjPid ? await resolveLine(store, cj, li.cjPid, li.sku ?? '', cfg.floors.stockFloor) : null;
        if (!resolved) throw new Error(`could not resolve vid for ${li.sku ?? li.cjPid}`);
        // Pre-flight source-stock check (deterministic): CJ stock is shared across
        // every CJ merchant, so this line may have been sniped since our last sync.
        // Catch it BEFORE creating the CJ order. Only on first submission (a pay-retry
        // already has a CJ order). An unreachable stock endpoint is UNKNOWN, not zero:
        // proceed and rely on the createOrder error backstop (isStockoutError).
        if (!o.cj_order_id) {
          step = 'stock';
          let avail: number | undefined;
          try {
            avail = (await cj.stockByPid(li.cjPid!)).get(resolved.vid);
          } catch { avail = undefined; }
          if (avail !== undefined && avail < li.quantity) {
            throw new StockoutError(li.cjPid!, li.sku ?? '', `source stock ${avail} is below the ordered ${li.quantity} for ${li.sku ?? li.cjPid}`);
          }
        }
        products.push({ vid: resolved.vid, quantity: li.quantity });
        origins.push(resolved.origin);
      }

      // A CJ order ships from ONE origin - if the lines resolved to more than one,
      // an operator has to split or choose, so hold instead of guessing.
      const uniqueOrigins = [...new Set(origins)];
      if (uniqueOrigins.length > 1) {
        const detail = `mixed-origin: ${uniqueOrigins.join(', ')}`;
        await writeGateStop(store, o.shopify_order_id, 'held', 'mixed-origin', null, detail);
        held++;
        // Fix round 2, NEW-1: reachable on a pay-retry (only the numeric stock
        // sub-check is skipped for one, not line resolution, and the resolved
        // origin is a function of live stock, so it can disagree with the
        // origin the existing supplier order was created against). Same alert
        // as the two pre-create stop branches (fix round 1, I-1), with the
        // hold's own detail text as the reason.
        await alertIfSupplierOrderExists(store, o, detail, opts.alert);
        continue;
      }
      const origin = uniqueOrigins[0] ?? 'CN';
      if (!o.cj_order_id) await store.addOrderEvent(o.shopify_order_id, 'stock-ok'); // see gate-passed comment above

      let cjOrderId = o.cj_order_id ?? '';
      if (!cjOrderId) {
        step = 'freight';
        const freight = await cj.freightEstimate(products[0].vid, origin).catch(() => null);
        step = 'create';
        const created = await cj.createOrder({
          orderNumber: o.shopify_order_id,
          address,
          products,
          fromCountryCode: origin,
          logisticName: freight?.name,
          remark: 'Active Paw'
        });
        cjOrderId = created.orderId;
        step = 'record';
        await store.updateOrder(o.shopify_order_id, { cj_order_id: cjOrderId }); // persist BEFORE paying (no re-create on retry)
        await store.addOrderEvent(o.shopify_order_id, 'supplier-order-created', cjOrderId);
      }

      if (createOnly) {
        // Interim: created but unpaid - owner pays it manually in CJ.
        await markAwaiting(o, cjOrderId, `awaiting-payment: pay CJ order ${cjOrderId} manually`);
        continue;
      }

      // Gate again, immediately before spending: the gap since the first check
      // (line resolution + CJ create) is exactly where a cancellation in the
      // interim would otherwise slip through un-caught. Risk is always skipped
      // here - it was already decided (or deliberately bypassed) above.
      const rePay = await readOrderGate(admin, o.shopify_order_id);
      if (!rePay.ok) {
        await handleGateUnreadable(store, o, rePay.error, cjOrderId, opts.alert);
        continue;
      }
      const payDecision = decideGate(rePay.snapshot, { address, totalPrice: o.total_price ?? 0, skipRisk: true });
      if (payDecision.action !== 'proceed') {
        if (payDecision.action === 'cancel' || payDecision.action === 'hold') {
          const status = payDecision.action === 'cancel' ? 'cancelled' : 'held';
          const riskLevel = payDecision.action === 'hold' ? payDecision.riskLevel : null;
          await writeGateStop(store, o.shopify_order_id, status, payDecision.reason, riskLevel);
          held++;
          const name = o.order_name ?? o.shopify_order_id;
          if (opts.alert) {
            await deliverOrderAlert(store, o.shopify_order_id, {
              subject: `Order ${name}: payment to the supplier was stopped`,
              text: `Order ${name} changed in Shopify (${payDecision.reason}) after supplier order ${cjOrderId} was created and before it was paid. It has NOT been paid. Cancel it at the supplier.`
            }, opts.alert);
          }
        } else {
          const _exhaustive: never = payDecision;
        }
        continue;
      }
      if (payDecision.addressChanged) {
        // The address changed in the gap between the two gate reads (line
        // resolution + CJ create) - the supplier order that now exists still
        // carries the OLD address. Stop before paying it.
        await store.updateOrder(o.shopify_order_id, { address_json: JSON.stringify(payDecision.address) });
        await store.addOrderEvent(o.shopify_order_id, 'address-refreshed');
        await holdForAddressChangeAfterSupplierOrder(store, o, cjOrderId, opts.alert);
        held++;
        continue;
      }

      step = 'pay';
      try {
        await cj.payBalance(cjOrderId);
      } catch (payErr) {
        const msg = (payErr as Error).message;
        if (looksLikeInsufficientBalance(msg)) {
          // The CJ order exists; the owner can top up + pay it manually. Don't error.
          await markAwaiting(o, cjOrderId, `awaiting-payment: fund CJ wallet, then pay CJ order ${cjOrderId}`);
          continue;
        }
        throw payErr; // genuine pay failure → error branch
      }
      step = 'record';
      // Fix round 1, I-3: money already moved - if the row became 'cancelled'
      // while payBalance was in flight, still record that it was paid (the
      // trail must say so), but count it as held (not submitted) and tell the
      // owner it needs handling as a return/cancellation at the supplier.
      const wrote = await store.updateOrderUnlessCancelled(o.shopify_order_id, { status: 'submitted' });
      await store.addOrderEvent(o.shopify_order_id, 'paid');
      if (!wrote) {
        held++;
        const name = o.order_name ?? o.shopify_order_id;
        if (opts.alert) {
          await deliverOrderAlert(store, o.shopify_order_id, {
            subject: `Order ${name} was cancelled while its supplier order was being paid`,
            text: `Order ${name} was cancelled in Shopify while supplier order ${cjOrderId} was being paid. The payment went through. Ask the supplier to cancel it if it has not shipped. If it has shipped, this is a return.`
          }, opts.alert);
        }
      } else {
        submitted++;
      }
    } catch (e) {
      const msg = (e as Error).message;
      // Classify a stock-caused failure: the pre-flight throws a typed StockoutError
      // (exact line known); a CJ createOrder rejection is matched by phrasing, and
      // pinpointed only when the order has a single line.
      let stockout: { cjPid: string | null; sku: string | null } | null = null;
      if (e instanceof StockoutError) stockout = { cjPid: e.cjPid, sku: e.sku };
      else if (isStockoutError(msg)) stockout = lineItems.length === 1 ? { cjPid: lineItems[0].cjPid, sku: lineItems[0].sku } : { cjPid: null, sku: null };

      console.warn(`fulfil failed for ${o.order_name ?? o.shopify_order_id}: ${msg}`);
      const reason = stockout ? `stockout: ${msg}` : `fulfil: ${msg}`;
      await store.updateOrderUnlessCancelled(o.shopify_order_id, { status: 'error', hold_reasons: JSON.stringify([reason.slice(0, 200)]) });

      // Fix round 1, I-4 (ruling: constraint beats brief point 4 - classify,
      // never copy): order_events.detail must never carry a supplier's or
      // Shopify's raw error text - a rejection can echo the address or phone
      // number sent with the order. The raw text still goes to console.warn
      // above; hold_reasons above is unchanged, existing behaviour, out of
      // this ruling's scope.
      let eventKind: 'stockout' | 'error';
      let eventDetail: string;
      if (e instanceof StockoutError) {
        eventKind = 'stockout';
        eventDetail = msg.slice(0, 200); // our own message: sku/pid only
      } else if (isStockoutError(msg)) {
        eventKind = 'stockout';
        eventDetail = 'supplier reported no stock' + (lineItems.length === 1 && lineItems[0].sku ? ` for ${lineItems[0].sku}` : '');
      } else {
        eventKind = 'error';
        eventDetail = `failed at ${step}`;
      }
      await store.addOrderEvent(o.shopify_order_id, eventKind, eventDetail);
      errored++;

      if (stockout) {
        // Stop the bleeding: hide the variant from sale NOW instead of leaving the
        // phantom stock sellable until the next nightly sync. Best-effort - the
        // order is already parked, so a failure here never blocks the batch.
        let zeroed = false;
        if (stockout.cjPid) {
          try {
            const link = await store.getLink(stockout.cjPid);
            if (link?.shopify_product_id) {
              const locationId = await getPrimaryLocationId(admin);
              const items = await productInventoryItems(admin, link.shopify_product_id);
              const targets = items.filter((v) => !stockout!.sku || v.sku === stockout!.sku);
              if (locationId && targets.length) {
                await setInventoryQuantities(admin, locationId, targets.map((v) => ({ inventoryItemId: v.inventoryItemId, quantity: 0 })));
                zeroed = true;
              }
            }
          } catch (ze) {
            console.warn(`stockout inventory zero failed for ${stockout.cjPid}: ${(ze as Error).message}`);
          }
        }
        if (opts.notifyStockout) {
          try {
            await opts.notifyStockout({
              shopifyOrderId: o.shopify_order_id,
              orderName: o.order_name ?? o.shopify_order_id,
              item: stockout.sku || stockout.cjPid || 'unidentified line',
              detail: msg,
              zeroed
            });
          } catch (ne) {
            console.warn(`stockout notify failed for ${o.order_name ?? o.shopify_order_id}: ${(ne as Error).message}`);
          }
        }
      }
    }
  }
  return { submitted, awaiting, held, errored, skipped: false };
}

/** Poll submitted CJ orders; when a tracking number appears, write it to Shopify and mark fulfilled. */
export async function pollTracking(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  opts: { max?: number; alert?: AlertSend } = {}
): Promise<{ checked: number; fulfilled: number }> {
  // Poll both PS-paid ('submitted') and owner-pays-manually ('awaiting-payment')
  // orders: in either case a tracking number means CJ has shipped it. Once an
  // order is fulfilled it drops out of both lists, so it is never polled again.
  const max = opts.max ?? 30;
  const submitted = [
    ...(await store.listOrders('submitted', max)),
    ...(await store.listOrders('awaiting-payment', max))
  ].filter((o) => o.cj_order_id);
  let checked = 0;
  let fulfilled = 0;
  for (const o of submitted) {
    checked++;
    try {
      const detail = await cj.getOrderDetail(o.cj_order_id!);
      if (!detail?.trackNumber) continue;

      // tracking-found is written ONCE - a write-back that keeps failing polls the
      // same order every 15 minutes, and re-writing this on every poll would spam
      // the trail with no new information.
      const events = await store.listOrderEvents(o.shopify_order_id);
      if (!events.some((ev) => ev.kind === 'tracking-found')) {
        await store.addOrderEvent(o.shopify_order_id, 'tracking-found');
      }

      const url = trackingUrlFor(detail.trackNumber, detail.trackUrl);
      try {
        await writeTracking(admin, `gid://shopify/Order/${o.shopify_order_id}`, detail.trackNumber, detail.logisticName, url);
        await store.updateOrder(o.shopify_order_id, { status: 'fulfilled', tracking_number: detail.trackNumber });
        await store.addOrderEvent(o.shopify_order_id, 'tracking-written');
        fulfilled++;
      } catch (writeErr) {
        const msg = (writeErr as Error).message;
        console.warn(`tracking poll failed for ${o.order_name ?? o.shopify_order_id}: ${msg}`);
        await store.addOrderEvent(o.shopify_order_id, 'tracking-write-failed', msg);
        // Fix round 1, M-2: >= 4, not === 4 - a single swallowed addOrderEvent
        // write must never permanently silence this order's alert.
        if ((await store.countTrailingOrderEvents(o.shopify_order_id, 'tracking-write-failed')) >= 4) {
          const name = o.order_name ?? o.shopify_order_id;
          if (opts.alert) {
            await deliverOrderAlert(store, o.shopify_order_id, {
              subject: `Order ${name}: tracking could not be written to Shopify`,
              text: `Supplier order ${o.cj_order_id} has shipped with tracking ${detail.trackNumber}, but writing it to Shopify failed on the last 4 attempts (${msg}). The customer has not been told. It is retried every 15 minutes.`
            }, opts.alert);
          }
        }
      }
    } catch (e) {
      console.warn(`tracking poll failed for ${o.order_name ?? o.shopify_order_id}: ${(e as Error).message}`);
    }
  }
  return { checked, fulfilled };
}

/** Reads a row's hold_reasons JSON defensively - a syntax error or a
 *  non-array value both read as "no reasons recorded" rather than throwing. */
function parseHoldReasons(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
  } catch { return []; }
}

/**
 * A cancel or a refund reaches us by webhook only, so a lost delivery (the
 * subscription removed, the process down at the wrong moment) leaves a row
 * sitting on an unsettled supplier order (awaiting-payment, or held/error
 * while a supplier order still exists) with nobody told. This re-reads every
 * such row against Shopify on a rotation, independently of the webhook path,
 * paging through the backlog via listUnsettledSupplierOrders /
 * countUnsettledSupplierOrders so a backlog larger than one page still gets
 * every row read in turn rather than starving the oldest ones. It watches
 * held and error rows with a supplier order too, not only awaiting-payment.
 *
 * One row's failure - a throw from applyCancel (it can throw now, since its
 * own marker write can be refused), a bad gate read, anything - is caught
 * per row and never stops the rest of the tick; the failure is logged, never
 * written to the row's own trail (a trail write here could be the very thing
 * that just failed).
 *
 * Per row: an unreadable gate is handled the same way the pipeline's own
 * pre-pay gate read is (handleGateUnreadable - a trail marker, and an alert
 * on the fourth consecutive failure), but with its text saying truthfully
 * that the OWNER is the one who would pay, not PawScout. Cancelled in
 * Shopify: applyCancel decides and dedupes on the trail, so a cancel that
 * also arrives by webhook is handled exactly once, whichever gets there
 * first. A hold for any reason other than already-fulfilled or order-missing
 * - refunded, not-paid, on-hold or incomplete-address, the only ones
 * reachable here since this check skips the risk gate - is a financial stop
 * signal Shopify is sending us, not a reason to keep waiting: it is written
 * and alerted the same way the pipeline's own pre-create stop is, once per
 * reason (a row already held for that exact reason is left alone), keeping
 * any reason the row already carried alongside the new one rather than
 * erasing it - a row parked here already, by an error or by an earlier stop,
 * has its own reason as the only persisted record of why. An address that
 * changed after the supplier order was created is never held here - unlike
 * the pipeline's own two positions, holding here would pull the row out of
 * this very check and out of the tracking poll while the owner still pays it
 * by hand - so the row's status is left alone; only the stored address and
 * the alert are updated, and the stored address is itself the dedupe (the
 * next tick sees no change). A corrupt address_json never blocks the cancel
 * or stop checks for that row - only the address-changed comparison is
 * skipped.
 */
export async function recheckUnsettledSupplierOrders(
  store: TenantStore, admin: AdminGraphql, send: AlertSend, opts: { max?: number; now?: Date } = {}
): Promise<{ checked: number; cancelled: number; addressChanged: number; stopped: number; unreadable: number }> {
  const max = opts.max ?? 20;
  const now = opts.now ?? new Date();
  let checked = 0;
  let cancelled = 0;
  let addressChanged = 0;
  let stopped = 0;
  let unreadable = 0;

  const count = await store.countUnsettledSupplierOrders();
  if (count === 0) return { checked, cancelled, addressChanged, stopped, unreadable };
  const pages = Math.ceil(count / max);
  const page = Math.floor(now.getTime() / 900_000) % pages;
  const rows = await store.listUnsettledSupplierOrders(max, page * max);

  for (const o of rows) {
    checked++;
    try {
      const gateRead = await readOrderGate(admin, o.shopify_order_id);
      if (!gateRead.ok) {
        await handleGateUnreadable(store, o, gateRead.error, o.cj_order_id, send, { ownerPays: true });
        unreadable++;
        continue;
      }

      if (gateRead.snapshot.cancelledAt) {
        const outcome = await applyCancel(store, o.shopify_order_id);
        if (outcome.alert) await deliverOrderAlert(store, o.shopify_order_id, outcome.alert, send);
        cancelled++;
        continue;
      }

      let storedAddress: OrderAddress | null = null;
      let addressReadable = true;
      if (o.address_json) {
        try { storedAddress = JSON.parse(o.address_json) as OrderAddress; }
        catch { addressReadable = false; }
      }

      const decision = decideGate(gateRead.snapshot, { address: addressReadable ? storedAddress : null, totalPrice: o.total_price ?? 0, skipRisk: true });

      if (decision.action === 'hold') {
        if (decision.reason !== 'already-fulfilled' && decision.reason !== 'order-missing') {
          const existingReasons = parseHoldReasons(o.hold_reasons);
          const alreadyHeldForThis = o.status === 'held' && existingReasons.includes(decision.reason);
          if (!alreadyHeldForThis) {
            await writeGateStop(store, o.shopify_order_id, 'held', decision.reason, decision.riskLevel, decision.reason, existingReasons);
            await alertIfSupplierOrderExists(store, o, decision.reason, send);
            stopped++;
          }
        }
        continue;
      }
      if (decision.action === 'cancel') {
        // Unreachable in practice: decideGate's cancel branch keys off the
        // exact same snapshot.cancelledAt already handled above. Kept so a
        // future change to decideGate's ordering fails this check instead of
        // silently doing nothing.
        continue;
      }

      // decision.action === 'proceed' here - the only remaining variant.
      if (decision.addressChanged && addressReadable && o.cj_order_id) {
        await store.updateOrder(o.shopify_order_id, { address_json: JSON.stringify(decision.address) });
        await store.addOrderEvent(o.shopify_order_id, 'address-refreshed');
        const name = o.order_name ?? o.shopify_order_id;
        await deliverOrderAlert(store, o.shopify_order_id, {
          subject: `Order ${name}: the delivery address changed after the supplier order was created`,
          text: `The delivery address of order ${name} was changed in Shopify after supplier order ${o.cj_order_id} was created, so the supplier order still carries the old address. If it is not paid yet, correct the address on the supplier order at the supplier before you pay it. If it is already paid, ask the supplier to change the address before it ships. If the supplier cannot change it, handle this order by hand.`
        }, send);
        addressChanged++;
      }
    } catch (e) {
      console.warn(`unsettled supplier order recheck failed for ${o.order_name ?? o.shopify_order_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { checked, cancelled, addressChanged, stopped, unreadable };
}

/** Build the awaiting-payment email callback, or undefined when email isn't configured. */
function makeAwaitingPaymentNotify(env: Env, alertEmail: string | undefined): ((n: AwaitingPaymentNotice) => Promise<void>) | undefined {
  if (!env.RESEND_API_KEY || !alertEmail) return undefined;
  return async (n: AwaitingPaymentNotice) => {
    const amount = n.total != null ? `${n.currency ?? ''} ${n.total}`.trim() : '';
    const r = await sendEmail(env.RESEND_API_KEY!, {
      to: alertEmail,
      subject: `Active Paw - order ${n.orderName} awaiting payment in CJ`,
      text: `Order ${n.orderName}${amount ? ` (${amount})` : ''} has been created in CJ and is awaiting your payment.\n\nCJ order id: ${n.cjOrderId}\n\nPay it in CJ at https://app.cjdropshipping.com to start fulfilment. Tracking will sync back to Shopify automatically once paid.`,
      html: `<p>Order <strong>${n.orderName}</strong>${amount ? ` (${amount})` : ''} has been created in CJ and is <strong>awaiting your payment</strong>.</p>`
        + `<p>CJ order id: <strong>${n.cjOrderId}</strong></p>`
        + `<p>Pay it in CJ at <a href="https://app.cjdropshipping.com">app.cjdropshipping.com</a> to start fulfilment. Tracking will sync back to Shopify automatically once paid.</p>`
    });
    if (!r.ok) throw new Error(r.error); // surfaced + logged by markAwaiting's catch
  };
}

/** Build the source-stockout email callback (Layer 3 playbook for the owner), or
 * undefined when email isn't configured. */
function makeStockoutNotify(env: Env, alertEmail: string | undefined): ((n: StockoutNotice) => Promise<void>) | undefined {
  if (!env.RESEND_API_KEY || !alertEmail) return undefined;
  return async (n: StockoutNotice) => {
    const hidden = n.zeroed
      ? 'The variant has been hidden from sale (inventory zeroed) so no further orders can be placed for it.'
      : 'The variant could NOT be hidden automatically - check its availability on the store.';
    const r = await sendEmail(env.RESEND_API_KEY!, {
      to: alertEmail,
      subject: `Active Paw - order ${n.orderName} cannot be fulfilled (out of stock at source)`,
      text: `Order ${n.orderName} failed to submit: ${n.item} is out of stock at the source.\n\n${n.detail}\n\n${hidden}\n\nSuggested next steps:\n1. Check the item in CJ for a restock signal (CN-warehoused items often restock; local-warehouse stock may not).\n2. If a restock looks likely and soon, email the customer an honest timeframe and ask if they want to wait.\n3. Otherwise refund promptly and, if we stock a close alternative, offer it.\n\nThe order is parked in the console with reason "stockout" and will not retry until released.`,
      html: `<p>Order <strong>${n.orderName}</strong> failed to submit: <strong>${n.item}</strong> is out of stock at the source.</p>`
        + `<p>${n.detail}</p><p>${hidden}</p>`
        + `<p>Suggested next steps:</p><ol><li>Check the item in CJ for a restock signal (CN-warehoused items often restock; local-warehouse stock may not).</li>`
        + `<li>If a restock looks likely and soon, email the customer an honest timeframe and ask if they want to wait.</li>`
        + `<li>Otherwise refund promptly and, if we stock a close alternative, offer it.</li></ol>`
        + `<p>The order is parked in the console with reason "stockout" and will not retry until released.</p>`
    });
    if (!r.ok) throw new Error(r.error); // surfaced + logged by the caller's catch
  };
}

/** Run the order pipeline (submit due orders + poll tracking) for ONE shop. Returns
 * null when the shop isn't ready (no token / no CJ). Shared by the cron and the
 * on-demand "Run fulfilment now" endpoint. */
export async function runOrderPipelineForShop(env: Env, vault: Vault, shop: string): Promise<{ submitted: number; awaiting: number; held: number; errored: number; checked: number; fulfilled: number } | null> {
  const store = new TenantStore(env.DB, shop);
  const tenant = await store.getTenant();
  const cfg = await store.getConfig();
  if (!tenant?.access_token_enc || !cfg) return null;
  const alert: AlertSend = (subject, text) => alertOwner(env, cfg, subject, text);
  // Runs before the supplier-credential guard and the vault open below (and
  // regardless of fulfil.mode, which processDueOrders gates on) so a shop
  // whose CJ credential is missing, rotated out or failing to open still
  // gets its pending alerts re-sent - it needs only the store, the config
  // and the environment. Best-effort: a retry sweep failure must never stop
  // the pipeline it rides on.
  try {
    await retryOrderAlerts(store, alert);
  } catch (e) {
    console.warn(`owner alert retry sweep failed for ${shop}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!(await store.getSupplierCredential('cj'))) return null;
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  const admin = makeAdminGraphql(shop, accessToken);
  // Runs as soon as the admin client exists, and whatever fulfil.mode is set
  // to (unlike processDueOrders, which is pawscout-only): any row that
  // already has a supplier order and is not yet settled - awaiting-payment,
  // held or error - always needs telling about, mode aside. Cannot sit next
  // to the alert retry sweep above, which runs before the vault open this
  // needs. Its own try/catch so a failure here can never stop the pipeline
  // it rides on.
  try {
    const r = await recheckUnsettledSupplierOrders(store, admin, alert);
    if (r.cancelled || r.addressChanged || r.stopped) {
      console.log(`unsettled supplier order recheck for ${shop}: cancelled=${r.cancelled} addressChanged=${r.addressChanged} stopped=${r.stopped}`);
    }
  } catch (e) {
    console.warn(`unsettled supplier order recheck failed for ${shop}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const f = cjFetchFromEnv(env);
  const cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
  const notify = makeAwaitingPaymentNotify(env, cfg.fulfil.alertEmail);
  const notifyStockout = makeStockoutNotify(env, cfg.fulfil.alertEmail);
  const p = await processDueOrders(store, cj, admin, cfg, { ...(notify ? { notify } : {}), ...(notifyStockout ? { notifyStockout } : {}), alert });
  const t = await pollTracking(store, cj, admin, { alert });
  // Low-band fast re-sync piggybacks on this 15-minute entry (same clients): items
  // at <=LOW_STOCK_BAND get their source stock re-checked in minutes, not tomorrow
  // at 04:17. Best-effort - a failure never affects the order pipeline result.
  try {
    await resyncLowStockInventory(store, cj, admin, cfg);
  } catch (e) {
    console.warn(`low-stock resync failed for ${shop}: ${(e as Error).message}`);
  }
  // Affiliate voucher ledger also rides this entry (same admin client). It
  // early-exits without a Shopify call when no vouchers are registered, and a
  // failure never affects the order pipeline result.
  try {
    const a = await attributeAffiliateOrders(store, admin, env.SHOPIFY_API_SECRET);
    if (a.matched) console.log(`affiliate attribution for ${shop}: ${a.matched} matched of ${a.scanned} scanned`);
  } catch (e) {
    console.warn(`affiliate attribution failed for ${shop}: ${(e as Error).message}`);
  }
  // Console health stamp (Glance): record the completed run; best-effort.
  try { await store.putSearchCache(JOB_STAMP_PIPELINE, new Date().toISOString(), JOB_STAMP_TTL_DAYS); } catch { /* never affects the pipeline result */ }
  return { submitted: p.submitted, awaiting: p.awaiting, held: p.held, errored: p.errored, checked: t.checked, fulfilled: t.fulfilled };
}

/** Cron entry (runs more often than the daily job): submit due orders + poll tracking, per tenant. */
export async function runOrderPipeline(env: Env): Promise<void> {
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  for (const shop of await listActiveShops(env.DB)) {
    try {
      await runOrderPipelineForShop(env, vault, shop);
    } catch (e) {
      console.warn(`order pipeline failed for ${shop}: ${(e as Error).message}`);
    }
  }
}
