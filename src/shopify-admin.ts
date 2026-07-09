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

/** Minimal Admin GraphQL caller bound to a shop + offline token.
 *
 * Retries transient failures with backoff so a throttle window can never abort
 * a batch job mid-flight (the inventory/price sync makes hundreds of Admin calls
 * across the catalogue; without this, one THROTTLED response threw and dropped
 * that product's reprice). Retried: HTTP 429, HTTP 5xx, and Shopify's GraphQL
 * cost-limit error (HTTP 200 with a THROTTLED `errors` entry). Real GraphQL
 * errors and other 4xx still throw immediately - only genuinely transient
 * conditions are retried. `sleep` is injectable so tests run without real waits. */
export function makeAdminGraphql(
  shop: string,
  accessToken: string,
  fetchImpl: typeof fetch = defaultFetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): AdminGraphql {
  const MAX_ATTEMPTS = 4;
  return async (query, variables = {}) => {
    // Idempotency (Admin API 2026-04): inventory + refund mutations are REJECTED at
    // runtime ("The @idempotent directive is required for this mutation") unless the
    // field carries @idempotent(key:). Mint the key ONCE here, before the retry loop,
    // so every attempt below reuses the SAME key - a retried write then dedupes on
    // Shopify's side (applied at most once) instead of double-applying. A fresh UUID
    // per call keeps distinct operations from colliding in Shopify's key cache (a key
    // reused across runs would replay the first response and silently drop later
    // updates). Only documents that opt in (contain the directive) are touched; a
    // caller-supplied key is respected. NB: this is a runtime rule, invisible to
    // static schema validation - re-check the changelog on any future version bump.
    if (variables.idempotencyKey === undefined && query.includes('@idempotent')) {
      variables = { ...variables, idempotencyKey: crypto.randomUUID() };
    }
    let lastError = 'Shopify request failed';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const resp = await fetchImpl(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({ query, variables })
      });
      // HTTP-level throttle (429) or transient server error (5xx): back off and retry.
      if (resp.status === 429 || resp.status >= 500) {
        lastError = `Shopify HTTP ${resp.status}`;
        if (attempt === MAX_ATTEMPTS - 1) throw new Error(lastError);
        const retryAfter = Number(resp.headers.get('Retry-After'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (!resp.ok) throw new Error(`Shopify HTTP ${resp.status}`);
      const data = (await resp.json()) as {
        data?: Record<string, unknown>;
        errors?: { message: string; extensions?: { code?: string } }[];
      };
      // GraphQL-level throttle: Shopify returns HTTP 200 with a THROTTLED error when
      // the cost budget is exhausted. Back off (the budget restores over time) and retry.
      const throttled = data.errors?.some((e) => e.extensions?.code === 'THROTTLED' || /throttl/i.test(e.message));
      if (throttled && attempt < MAX_ATTEMPTS - 1) {
        lastError = data.errors!.map((e) => e.message).join('; ');
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join('; '));
      return data.data ?? {};
    }
    throw new Error(lastError);
  };
}
