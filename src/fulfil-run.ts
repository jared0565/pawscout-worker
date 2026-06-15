import { Vault } from './vault';
import { TenantStore, listActiveShops } from './tenant-store';
import { makeAdminGraphql, type AdminGraphql } from './shopify-admin';
import { CjClient, CjTokenManager, cjFetchFromEnv, chooseOrigin, type CjDetail } from './cj';
import type { Env, TenantConfig } from './types';
import type { OrderLineItem, OrderAddress } from './fulfil';

// W-FULFIL Stage B: turn queued orders into paid CJ orders, then write tracking
// back to Shopify. The money leg (createOrder + payBalance) only runs when
// cfg.fulfil.autopay is true — otherwise orders just sit queued for manual handling.

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

/** Write a tracking number back to Shopify (fulfils the order's open fulfillment orders). */
async function writeTracking(admin: AdminGraphql, orderGid: string, trackNumber: string, company: string): Promise<void> {
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
      trackingInfo: { number: trackNumber, ...(company ? { company } : {}) },
      notifyCustomer: true
    }
  }) as { fulfillmentCreateV2?: { userErrors?: { message: string }[] } };
  const errs = r.fulfillmentCreateV2?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
}

/**
 * Submit queued orders to CJ and pay them. GATED on cfg.fulfil.autopay — a
 * no-op when off (orders stay queued). createOrder is skipped when cj_order_id
 * is already set (so a pay-retry never duplicates the CJ order). Any failure
 * marks the order `error` (operator releases it to retry); one failure never
 * aborts the batch.
 */
export async function processDueOrders(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  cfg: TenantConfig,
  opts: { now?: () => number; max?: number } = {}
): Promise<{ submitted: number; errored: number; skipped: boolean }> {
  if (!cfg.fulfil.autopay) return { submitted: 0, errored: 0, skipped: true };
  void admin; // (admin reserved for future create-side checks; tracking writeback is in pollTracking)
  const nowIso = new Date(opts.now ? opts.now() : Date.now()).toISOString();
  const due = await store.dueQueuedOrders(nowIso, opts.max ?? 10);
  let submitted = 0;
  let errored = 0;
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
      await cj.payBalance(cjOrderId);
      await store.updateOrder(o.shopify_order_id, { status: 'submitted' });
      submitted++;
    } catch (e) {
      console.warn(`fulfil failed for ${o.order_name ?? o.shopify_order_id}: ${(e as Error).message}`);
      await store.updateOrder(o.shopify_order_id, { status: 'error', hold_reasons: JSON.stringify([`fulfil: ${(e as Error).message}`.slice(0, 200)]) });
      errored++;
    }
  }
  return { submitted, errored, skipped: false };
}

/** Poll submitted CJ orders; when a tracking number appears, write it to Shopify and mark fulfilled. */
export async function pollTracking(
  store: TenantStore,
  cj: CjClient,
  admin: AdminGraphql,
  opts: { max?: number } = {}
): Promise<{ checked: number; fulfilled: number }> {
  const submitted = (await store.listOrders('submitted', opts.max ?? 30)).filter((o) => o.cj_order_id);
  let checked = 0;
  let fulfilled = 0;
  for (const o of submitted) {
    checked++;
    try {
      const detail = await cj.getOrderDetail(o.cj_order_id!);
      if (!detail?.trackNumber) continue;
      await writeTracking(admin, `gid://shopify/Order/${o.shopify_order_id}`, detail.trackNumber, detail.logisticName);
      await store.updateOrder(o.shopify_order_id, { status: 'fulfilled', tracking_number: detail.trackNumber });
      fulfilled++;
    } catch (e) {
      console.warn(`tracking poll failed for ${o.order_name ?? o.shopify_order_id}: ${(e as Error).message}`);
    }
  }
  return { checked, fulfilled };
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
      await processDueOrders(store, cj, admin, cfg);
      await pollTracking(store, cj, admin);
    } catch (e) {
      console.warn(`order pipeline failed for ${shop}: ${(e as Error).message}`);
    }
  }
}
