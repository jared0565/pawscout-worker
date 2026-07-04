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
const FULFILL = `mutation pawscoutFulfill($f: FulfillmentV2Input!) {
  fulfillmentCreateV2(fulfillment: $f) { fulfillment { id status } userErrors { field message } }
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
  }) as { fulfillmentCreateV2?: { userErrors?: { message: string }[] } };
  const errs = r.fulfillmentCreateV2?.userErrors ?? [];
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
  opts: { now?: () => number; max?: number; notify?: (n: AwaitingPaymentNotice) => Promise<void>; notifyStockout?: (n: StockoutNotice) => Promise<void> } = {}
): Promise<{ submitted: number; awaiting: number; errored: number; skipped: boolean }> {
  if (cfg.fulfil.mode !== 'pawscout') return { submitted: 0, awaiting: 0, errored: 0, skipped: true }; // 'manual'/'cj' → PawScout doesn't pay
  const createOnly = cfg.fulfil.createOnly === true;
  const nowIso = new Date(opts.now ? opts.now() : Date.now()).toISOString();
  const due = await store.dueQueuedOrders(nowIso, opts.max ?? 10);
  let submitted = 0;
  let awaiting = 0;
  let errored = 0;
  const markAwaiting = async (o: typeof due[number], cjOrderId: string, reason: string) => {
    await store.updateOrder(o.shopify_order_id, { status: 'awaiting-payment', hold_reasons: JSON.stringify([reason]) });
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
    try {
      lineItems = JSON.parse(o.line_items_json ?? '[]') as OrderLineItem[];
      const address = o.address_json ? (JSON.parse(o.address_json) as OrderAddress) : null;
      if (!address) throw new Error('no address on order');

      const products: { vid: string; quantity: number }[] = [];
      let origin = 'CN';
      for (const li of lineItems) {
        const resolved = li.cjPid ? await resolveLine(store, cj, li.cjPid, li.sku ?? '', cfg.floors.stockFloor) : null;
        if (!resolved) throw new Error(`could not resolve vid for ${li.sku ?? li.cjPid}`);
        // Pre-flight source-stock check (deterministic): CJ stock is shared across
        // every CJ merchant, so this line may have been sniped since our last sync.
        // Catch it BEFORE creating the CJ order. Only on first submission (a pay-retry
        // already has a CJ order). An unreachable stock endpoint is UNKNOWN, not zero:
        // proceed and rely on the createOrder error backstop (isStockoutError).
        if (!o.cj_order_id) {
          let avail: number | undefined;
          try {
            avail = (await cj.stockByPid(li.cjPid!)).get(resolved.vid);
          } catch { avail = undefined; }
          if (avail !== undefined && avail < li.quantity) {
            throw new StockoutError(li.cjPid!, li.sku ?? '', `source stock ${avail} is below the ordered ${li.quantity} for ${li.sku ?? li.cjPid}`);
          }
        }
        products.push({ vid: resolved.vid, quantity: li.quantity });
        origin = resolved.origin; // last wins; CJ order ships from one origin
      }

      let cjOrderId = o.cj_order_id ?? '';
      if (!cjOrderId) {
        const freight = await cj.freightEstimate(products[0].vid, origin).catch(() => null);
        const created = await cj.createOrder({
          orderNumber: o.shopify_order_id,
          address,
          products,
          fromCountryCode: origin,
          logisticName: freight?.name,
          remark: 'Active Paw'
        });
        cjOrderId = created.orderId;
        await store.updateOrder(o.shopify_order_id, { cj_order_id: cjOrderId }); // persist BEFORE paying (no re-create on retry)
      }

      if (createOnly) {
        // Interim: created but unpaid - owner pays it manually in CJ.
        await markAwaiting(o, cjOrderId, `awaiting-payment: pay CJ order ${cjOrderId} manually`);
        continue;
      }

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
      await store.updateOrder(o.shopify_order_id, { status: 'submitted' });
      submitted++;
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
      await store.updateOrder(o.shopify_order_id, { status: 'error', hold_reasons: JSON.stringify([reason.slice(0, 200)]) });
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
  return { submitted, awaiting, errored, skipped: false };
}

/** Poll submitted CJ orders; when a tracking number appears, write it to Shopify and mark fulfilled. */
export async function pollTracking(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  opts: { max?: number } = {}
): Promise<{ checked: number; fulfilled: number }> {
  // Poll both PS-paid ('submitted') and owner-pays-manually ('awaiting-payment')
  // orders: in either case a tracking number means CJ has shipped it.
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
      const url = trackingUrlFor(detail.trackNumber, detail.trackUrl);
      await writeTracking(admin, `gid://shopify/Order/${o.shopify_order_id}`, detail.trackNumber, detail.logisticName, url);
      await store.updateOrder(o.shopify_order_id, { status: 'fulfilled', tracking_number: detail.trackNumber });
      fulfilled++;
    } catch (e) {
      console.warn(`tracking poll failed for ${o.order_name ?? o.shopify_order_id}: ${(e as Error).message}`);
    }
  }
  return { checked, fulfilled };
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
export async function runOrderPipelineForShop(env: Env, vault: Vault, shop: string): Promise<{ submitted: number; awaiting: number; errored: number; checked: number; fulfilled: number } | null> {
  const store = new TenantStore(env.DB, shop);
  const tenant = await store.getTenant();
  const cfg = await store.getConfig();
  if (!tenant?.access_token_enc || !cfg) return null;
  if (!(await store.getSupplierCredential('cj'))) return null;
  const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
  const admin = makeAdminGraphql(shop, accessToken);
  const f = cjFetchFromEnv(env);
  const cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
  const notify = makeAwaitingPaymentNotify(env, cfg.fulfil.alertEmail);
  const notifyStockout = makeStockoutNotify(env, cfg.fulfil.alertEmail);
  const p = await processDueOrders(store, cj, admin, cfg, { ...(notify ? { notify } : {}), ...(notifyStockout ? { notifyStockout } : {}) });
  const t = await pollTracking(store, cj, admin);
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
    const a = await attributeAffiliateOrders(store, admin);
    if (a.matched) console.log(`affiliate attribution for ${shop}: ${a.matched} matched of ${a.scanned} scanned`);
  } catch (e) {
    console.warn(`affiliate attribution failed for ${shop}: ${(e as Error).message}`);
  }
  // Console health stamp (Glance): record the completed run; best-effort.
  try { await store.putSearchCache(JOB_STAMP_PIPELINE, new Date().toISOString(), JOB_STAMP_TTL_DAYS); } catch { /* never affects the pipeline result */ }
  return { submitted: p.submitted, awaiting: p.awaiting, errored: p.errored, checked: t.checked, fulfilled: t.fulfilled };
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
