import { Vault } from '../vault';
import { TenantStore, type KeywordDemand } from '../tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_TARGET, type Floors, type Gates, type LlmConfig, type Pricing, type TenantConfig } from '../types';
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

export async function saveLlm(db: D1Database, shop: string, llm: LlmConfig): Promise<void> {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  if (!cfg) return;
  await store.seedConfig({ ...cfg, llm });
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
  floors: Floors;
  llm: LlmConfig;
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
    floors: cfg?.floors ?? DEFAULT_FLOORS,
    llm: cfg?.llm ?? DEFAULT_LLM,
    target: cfg?.target ?? DEFAULT_TARGET
  };
}

export interface CategoryFill { key: string; imported: number; warehouse: number; floor: number; target: number }

/** Console readout: top search keywords (30d) + per-category fill vs floors. */
export async function getInsights(
  db: D1Database,
  shop: string
): Promise<{ keywords: KeywordDemand[]; categories: CategoryFill[]; llmSpend: { calls: number; costUsd: number } }> {
  const store = new TenantStore(db, shop);
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const cfg = await store.getConfig();
  const categories: CategoryFill[] = [];
  if (cfg) {
    for (const key of Object.keys(cfg.collectionMap)) {
      categories.push({
        key,
        imported: await store.countImportedByCategory(key),
        warehouse: await store.countWarehouseAvailableByCategory(key),
        floor: cfg.floors.storeFloor,
        target: cfg.target
      });
    }
  }
  return {
    keywords: await store.recentSearches(since, 10),
    categories,
    llmSpend: await store.llmSpendSince(since)
  };
}
