import { LATEST_API_VERSION } from '@shopify/shopify-api';
import { defaultFetch } from './safe-fetch';

const MUTATION = `mutation pawscoutUninstallHook($url: URL!) {
  webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: { callbackUrl: $url, format: JSON }) {
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

/**
 * Register the app/uninstalled webhook for a shop via the Admin GraphQL API.
 *
 * Idempotent: Shopify rejects a duplicate subscription with an
 * "address … has already been taken" userError, which counts as success here.
 * Never throws — install must not fail because webhook registration did.
 */
export async function registerUninstallWebhook(
  shop: string,
  accessToken: string,
  appUrl: string,
  fetchImpl: typeof fetch = defaultFetch
): Promise<RegisterResult> {
  try {
    const resp = await fetchImpl(`https://${shop}/admin/api/${LATEST_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: MUTATION, variables: { url: `${appUrl}/webhooks/uninstall` } })
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
