import { Vault } from '../vault';
import { TenantStore } from '../tenant-store';
import { persistInstall } from './callback';

export interface ExchangedToken {
  accessToken: string;
  scope: string;
}

/**
 * Managed-installation path (Shopify's 2026 default for embedded apps).
 *
 * Shopify installs the app without calling our legacy OAuth callback, then loads
 * the embedded console with a signed session token (`id_token`). On the first
 * authenticated request we mint an *offline* access token via token exchange and
 * persist it — sealed — through the exact same path the legacy callback used.
 *
 * Idempotent: once a tenant holds a sealed token this is a no-op, so it is safe
 * to call on every authenticated request. An emptied token (post secret-wipe)
 * counts as "not installed" and re-provisions.
 *
 * `exchange` is injected so this stays unit-testable without a live Shopify call;
 * production wires it to `shopify.auth.tokenExchange` with the offline token type.
 * The session token's signature is validated inside token exchange before any
 * grant is issued.
 */
export async function ensureInstalled(
  db: D1Database,
  vault: Vault,
  shop: string,
  sessionToken: string,
  exchange: (shop: string, sessionToken: string) => Promise<ExchangedToken>
): Promise<void> {
  const store = new TenantStore(db, shop);
  const tenant = await store.getTenant();
  if (tenant && tenant.access_token_enc) return; // already installed — nothing to do

  const { accessToken, scope } = await exchange(shop, sessionToken);
  if (!accessToken) throw new Error('token exchange returned no access token');
  await persistInstall(db, vault, { shop, accessToken, scope });
}
