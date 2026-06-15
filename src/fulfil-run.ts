import { Vault } from './vault';
import { TenantStore, listActiveShops } from './tenant-store';
import { makeAdminGraphql, type AdminGraphql } from './shopify-admin';
import { CjClient, CjTokenManager, cjFetchFromEnv, chooseOrigin, type CjDetail } from './cj';
import { sendEmail } from './email';
import type { Env, TenantConfig } from './types';
import type { OrderLineItem, OrderAddress } from './fulfil';

// W-FULFIL Stage B: turn queued orders into paid CJ orders, then write tracking
// back to Shopify. The money leg (createOrder + payBalance) only runs when
// cfg.fulfil.mode is 'pawscout' — otherwise orders just sit queued ('manual') or
// are left to CJ's native Shopify app ('cj').

/** Resolve a line's CJ variant id (vid) + dispatch origin from the warehouse detail. */
async function resolveLine(store: TenantStore, cjPid: string, sku: string, stockFloor: number): Promise<{ vid: string; origin: string } | null> {
  const wh = await store.getWarehouseProduct(cjPid);
  if (!wh) return null;
  let detail: CjDetail;
  try { detail = JSON.parse(wh.detail) as CjDetail; } catch { return null; }
  const variants = detail.variants ?? [];
  // Match by sku; fall back to the sole variant when there's only one.
  const v = (sku && variants.find((x) => x.sku === sku)) || (variants.length === 1 ? variants[0] : undefined);
  if (!v?.vid || v.vid === 'default') return null;
  const origin = detail.origin ?? chooseOrigin(detail, stockFloor);
  return { vid: v.vid, origin };
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

/** A payBalance failure that means "wallet has no/insufficient funds" — recoverable
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
 * cfg.fulfil.mode==='pawscout' — a no-op in 'manual'/'cj' (orders stay queued /
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
  opts: { now?: () => number; max?: number; notify?: (n: AwaitingPaymentNotice) => Promise<void> } = {}
): Promise<{ submitted: number; awaiting: number; errored: number; skipped: boolean }> {
  if (cfg.fulfil.mode !== 'pawscout') return { submitted: 0, awaiting: 0, errored: 0, skipped: true }; // 'manual'/'cj' → PawScout doesn't pay
  void admin; // (admin reserved for future create-side checks; tracking writeback is in pollTracking)
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
    try {
      const lineItems = JSON.parse(o.line_items_json ?? '[]') as OrderLineItem[];
      const address = o.address_json ? (JSON.parse(o.address_json) as OrderAddress) : null;
      if (!address) throw new Error('no address on order');

      const products: { vid: string; quantity: number }[] = [];
      let origin = 'CN';
      for (const li of lineItems) {
        const resolved = li.cjPid ? await resolveLine(store, li.cjPid, li.sku ?? '', cfg.floors.stockFloor) : null;
        if (!resolved) throw new Error(`could not resolve vid for ${li.sku ?? li.cjPid}`);
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
        // Interim: created but unpaid — owner pays it manually in CJ.
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
      console.warn(`fulfil failed for ${o.order_name ?? o.shopify_order_id}: ${(e as Error).message}`);
      await store.updateOrder(o.shopify_order_id, { status: 'error', hold_reasons: JSON.stringify([`fulfil: ${(e as Error).message}`.slice(0, 200)]) });
      errored++;
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
      subject: `Active Paw — order ${n.orderName} awaiting payment in CJ`,
      text: `Order ${n.orderName}${amount ? ` (${amount})` : ''} has been created in CJ and is awaiting your payment.\n\nCJ order id: ${n.cjOrderId}\n\nPay it in CJ at https://app.cjdropshipping.com to start fulfilment. Tracking will sync back to Shopify automatically once paid.`,
      html: `<p>Order <strong>${n.orderName}</strong>${amount ? ` (${amount})` : ''} has been created in CJ and is <strong>awaiting your payment</strong>.</p>`
        + `<p>CJ order id: <strong>${n.cjOrderId}</strong></p>`
        + `<p>Pay it in CJ at <a href="https://app.cjdropshipping.com">app.cjdropshipping.com</a> to start fulfilment. Tracking will sync back to Shopify automatically once paid.</p>`
    });
    if (!r.ok) throw new Error(r.error); // surfaced + logged by markAwaiting's catch
  };
}

/** Cron entry (runs more often than the daily job): submit due orders + poll tracking, per tenant. */
export async function runOrderPipeline(env: Env): Promise<void> {
  const vault = await Vault.fromMasterKey(env.PAWSCOUT_MASTER_KEY);
  for (const shop of await listActiveShops(env.DB)) {
    const store = new TenantStore(env.DB, shop);
    try {
      const tenant = await store.getTenant();
      const cfg = await store.getConfig();
      if (!tenant?.access_token_enc || !cfg) continue;
      if (!(await store.getSupplierCredential('cj'))) continue;
      const accessToken = await vault.open(tenant.dek_wrapped, tenant.access_token_enc);
      const admin = makeAdminGraphql(shop, accessToken);
      const f = cjFetchFromEnv(env);
      const cj = new CjClient(() => new CjTokenManager(store, vault, f).getToken(), f);
      const notify = makeAwaitingPaymentNotify(env, cfg.fulfil.alertEmail);
      await processDueOrders(store, cj, admin, cfg, notify ? { notify } : {});
      await pollTracking(store, cj, admin);
    } catch (e) {
      console.warn(`order pipeline failed for ${shop}: ${(e as Error).message}`);
    }
  }
}
