import { ADMIN_API_VERSION } from './shopify-admin';
import { defaultFetch } from './safe-fetch';

const MUTATION = `mutation pawscoutHook($topic: WebhookSubscriptionTopic!, $url: URL!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) {
    userErrors { message }
    webhookSubscription { id }
  }
}`;

export type RegisterResult = { ok: true } | { ok: false; error: string };
export type RegisterWebhook = (shop: string, accessToken: string) => Promise<RegisterResult>;

interface CreateResponse {
  data?: { webhookSubscriptionCreate?: { userErrors?: { message: string }[] } };
  errors?: { message: string }[];
}

/** Subscribe a shop to one webhook topic. Idempotent; never throws. */
export async function registerWebhookTopic(
  shop: string,
  accessToken: string,
  topic: string,
  callbackUrl: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<RegisterResult> {
  try {
    const resp = await fetchImpl(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: MUTATION, variables: { topic, url: callbackUrl } })
    });
    if (!resp.ok) return { ok: false, error: `Shopify HTTP ${resp.status}` };
    const data = (await resp.json()) as CreateResponse;
    if (data.errors?.length) return { ok: false, error: data.errors.map((e) => e.message).join('; ') };
    const userErrors = data.data?.webhookSubscriptionCreate?.userErrors ?? [];
    const real = userErrors.filter((e) => !/already been taken/i.test(e.message));
    if (real.length) return { ok: false, error: real.map((e) => e.message).join('; ') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Register every webhook the app needs for a shop: uninstall, paid orders, and
 * the three mandatory GDPR/privacy topics. Best-effort per topic - a missing
 * `orders/paid` scope must not stop the others (or the install). Reports the
 * first failure (after attempting all).
 */
export async function registerWebhooks(
  shop: string,
  accessToken: string,
  appUrl: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<RegisterResult> {
  const topics: [string, string][] = [
    ['APP_UNINSTALLED', `${appUrl}/webhooks/uninstall`],
    ['ORDERS_PAID', `${appUrl}/webhooks/orders-paid`],
    ['CUSTOMERS_DATA_REQUEST', `${appUrl}/webhooks/customers-data-request`],
    ['CUSTOMERS_REDACT', `${appUrl}/webhooks/customers-redact`],
    ['SHOP_REDACT', `${appUrl}/webhooks/shop-redact`]
  ];
  const results = await Promise.all(topics.map(([t, u]) => registerWebhookTopic(shop, accessToken, t, u, fetchImpl)));
  const failed = results.find((r) => !r.ok);
  return failed ?? { ok: true };
}
