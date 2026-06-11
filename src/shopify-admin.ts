import { LATEST_API_VERSION } from '@shopify/shopify-api';

export type AdminGraphql = (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Minimal Admin GraphQL caller bound to a shop + offline token. Throws on transport or GraphQL errors. */
export function makeAdminGraphql(shop: string, accessToken: string, fetchImpl: typeof fetch = fetch): AdminGraphql {
  return async (query, variables = {}) => {
    const resp = await fetchImpl(`https://${shop}/admin/api/${LATEST_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables })
    });
    if (!resp.ok) throw new Error(`Shopify HTTP ${resp.status}`);
    const data = (await resp.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] };
    if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join('; '));
    return data.data ?? {};
  };
}
