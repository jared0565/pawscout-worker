import { LATEST_API_VERSION } from '@shopify/shopify-api';
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
    const resp = await fetchImpl(`https://${shop}/admin/api/${LATEST_API_VERSION}/graphql.json`, {
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
 * Register every webhook the app needs (uninstall + paid orders) for a shop.
 * Best-effort per topic — a missing `orders/paid` scope must not stop the
 * uninstall hook (or the install) from registering. Reports the first failure.
 */
export async function registerWebhooks(
  shop: string,
  accessToken: string,
  appUrl: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<RegisterResult> {
  const results = await Promise.all([
    registerWebhookTopic(shop, accessToken, 'APP_UNINSTALLED', `${appUrl}/webhooks/uninstall`, fetchImpl),
    registerWebhookTopic(shop, accessToken, 'ORDERS_PAID', `${appUrl}/webhooks/orders-paid`, fetchImpl)
  ]);
  const failed = results.find((r) => !r.ok);
  return failed ?? { ok: true };
}
