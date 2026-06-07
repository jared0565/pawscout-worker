import type { ShopifyApp } from '../shopify';
import { Vault } from '../vault';
import { TenantStore } from '../tenant-store';
import { DEFAULT_GATES, ACTIVE_PAW_COLLECTION_MAP, type TenantConfig } from '../types';

/** Pure-ish persistence: seal token, upsert tenant, seed config. Unit-tested. */
export async function persistInstall(
  db: D1Database,
  vault: Vault,
  session: { shop: string; accessToken: string; scope: string }
): Promise<void> {
  const dekWrapped = await vault.newTenantDek();
  const accessTokenEnc = await vault.seal(dekWrapped, session.accessToken);
  const store = new TenantStore(db, session.shop);
  await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: session.scope });

  // Seed config only if absent (don't clobber a reinstall's settings).
  if (!(await store.getConfig())) {
    const isActivePaw = session.shop.startsWith('4qkudm-ez.');
    const cfg: TenantConfig = {
      collectionMap: isActivePaw ? ACTIVE_PAW_COLLECTION_MAP : {},
      gates: DEFAULT_GATES,
      target: 16
    };
    await store.seedConfig(cfg);
  }
}

/** GET /auth/callback — completes OAuth, persists, redirects into the embedded app. Returns a Response. */
export async function handleCallback(shopify: ShopifyApp, db: D1Database, vault: Vault, request: Request): Promise<Response> {
  const { session, headers } = await shopify.auth.callback<Headers>({ rawRequest: request });
  if (!session.accessToken) return new Response('No access token from OAuth', { status: 400 });
  await persistInstall(db, vault, { shop: session.shop, accessToken: session.accessToken, scope: session.scope ?? '' });
  // Register the uninstall webhook (best-effort; safe to re-register).
  // (Webhook registration call omitted here for brevity — see Task 9 note.)
  const host = new URL(request.url).searchParams.get('host') ?? '';
  const redirect = `/app?shop=${encodeURIComponent(session.shop)}&host=${encodeURIComponent(host)}`;
  return new Response('', { status: 302, headers: [...(headers as unknown as [string, string][]), ['Location', redirect]] });
}
