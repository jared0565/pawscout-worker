import { defaultFetch } from './safe-fetch';

/** Admin API version for every raw GraphQL call the worker makes. Pinned
 *  EXPLICITLY (2026-07-06) instead of the library's LATEST_API_VERSION: the
 *  installed @shopify/shopify-api caps out at 2025-07, which carried the
 *  deprecated inventorySetQuantities shape (dev-dashboard warning, sunset
 *  Jan 2027). 2026-04 was validated empirically before pinning: all 58 worker
 *  GraphQL documents pass 2026-04 validation, and an introspection diff of all
 *  86 input/enum types we use found no removals (validate_gql.py procedure -
 *  rerun it against the next version before bumping this constant). */
export const ADMIN_API_VERSION = '2026-04';

export type AdminGraphql = (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Minimal Admin GraphQL caller bound to a shop + offline token. Throws on transport or GraphQL errors. */
export function makeAdminGraphql(shop: string, accessToken: string, fetchImpl: typeof fetch = defaultFetch): AdminGraphql {
  return async (query, variables = {}) => {
    const resp = await fetchImpl(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
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
