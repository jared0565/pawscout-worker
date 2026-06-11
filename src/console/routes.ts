import { Vault } from '../vault';
import { TenantStore, type KeywordDemand } from '../tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_TARGET, type Gates, type Pricing, type TenantConfig } from '../types';
import type { ValidateResult } from '../cj';

export async function connectCj(
  db: D1Database, vault: Vault, shop: string, apiKey: string,
  validate: (key: string) => Promise<ValidateResult>
): Promise<{ ok: boolean; error?: string }> {
  const v = await validate(apiKey);
  if (!v.ok) return { ok: false, error: v.error };
  const store = new TenantStore(db, shop);
  const tenant = await store.getTenant();
  if (!tenant) return { ok: false, error: 'Unknown shop' };
  const sealed = await vault.seal(tenant.dek_wrapped, apiKey);
  await store.putSupplierCredential('cj', sealed, 'cj');
  return { ok: true };
}

export async function saveGates(db: D1Database, shop: string, gates: Gates, target?: number): Promise<void> {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  if (!cfg) return;
  await store.seedConfig({ ...cfg, gates, target: target ?? cfg.target });
}

export async function savePricing(db: D1Database, shop: string, pricing: Pricing): Promise<void> {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  if (!cfg) return;
  await store.seedConfig({ ...cfg, pricing });
}

export async function saveCollectionMap(db: D1Database, shop: string, map: Record<string, { handle: string; tag: string }>): Promise<void> {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  if (!cfg) return;
  await store.seedConfig({ ...cfg, collectionMap: map });
}

export interface Status {
  cjConnected: boolean;
  collectionMap: TenantConfig['collectionMap'];
  gates: Gates;
  pricing: Pricing;
  target: number;
}

export async function getStatus(db: D1Database, shop: string): Promise<Status> {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  const cred = await store.getSupplierCredential('cj');
  return {
    cjConnected: !!cred,
    collectionMap: cfg?.collectionMap ?? {},
    gates: cfg?.gates ?? DEFAULT_GATES,
    pricing: cfg?.pricing ?? DEFAULT_PRICING,
    target: cfg?.target ?? DEFAULT_TARGET
  };
}

/** Search-demand readout for the console: top keywords of the last 30 days. */
export async function getInsights(db: D1Database, shop: string): Promise<{ keywords: KeywordDemand[] }> {
  const store = new TenantStore(db, shop);
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  return { keywords: await store.recentSearches(since, 10) };
}
