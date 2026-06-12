import type { ShopifyApp } from '../shopify';
import { Vault } from '../vault';
import { TenantStore } from '../tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_TARGET, ACTIVE_PAW_COLLECTION_MAP, type TenantConfig } from '../types';
import type { RegisterWebhook } from '../webhooks';

/** Pure-ish persistence: seal token, upsert tenant, seed config. Unit-tested. */
export async function persistInstall(
  db: D1Database,
  vault: Vault,
  session: { shop: string; accessToken: string; scope: string },
  registerWebhook?: RegisterWebhook
): Promise<void> {
  const store = new TenantStore(db, session.shop);
  // Re-auths/reinstalls MUST reuse the existing DEK: minting a fresh one would
  // orphan every secret sealed under the old DEK (e.g. the CJ key). Only a
  // first install — or a post-uninstall wipe, which empties dek_wrapped —
  // gets a new DEK.
  const existing = await store.getTenant();
  const dekWrapped = existing?.dek_wrapped ? existing.dek_wrapped : await vault.newTenantDek();
  const accessTokenEnc = await vault.seal(dekWrapped, session.accessToken);
  await store.upsertTenant({ accessTokenEnc, dekWrapped, scopes: session.scope });

  // Seed config only if absent (don't clobber a reinstall's settings).
  if (!(await store.getConfig())) {
    const isActivePaw = session.shop.startsWith('4qkudm-ez.');
    const cfg: TenantConfig = {
      collectionMap: isActivePaw ? ACTIVE_PAW_COLLECTION_MAP : {},
      gates: DEFAULT_GATES,
      pricing: DEFAULT_PRICING,
      floors: DEFAULT_FLOORS,
      target: DEFAULT_TARGET
    };
    await store.seedConfig(cfg);
  }

  // Best-effort: a registration failure must never fail the install — the
  // registrar itself never throws, so this only logs.
  if (registerWebhook) {
    const r = await registerWebhook(session.shop, session.accessToken);
    if (!r.ok) console.warn(`uninstall-webhook registration failed for ${session.shop}: ${r.error}`);
  }
}

/** GET /auth/callback — completes OAuth, persists, redirects into the embedded app. Returns a Response. */
export async function handleCallback(
  shopify: ShopifyApp,
  db: D1Database,
  vault: Vault,
  request: Request,
  registerWebhook?: RegisterWebhook
): Promise<Response> {
  const { session, headers } = await shopify.auth.callback<Headers>({ rawRequest: request });
  if (!session.accessToken) return new Response('No access token from OAuth', { status: 400 });
  await persistInstall(db, vault, { shop: session.shop, accessToken: session.accessToken, scope: session.scope ?? '' }, registerWebhook);
  const host = new URL(request.url).searchParams.get('host') ?? '';
  const redirect = `/app?shop=${encodeURIComponent(session.shop)}&host=${encodeURIComponent(host)}`;
  return new Response('', { status: 302, headers: [...(headers as unknown as [string, string][]), ['Location', redirect]] });
}
