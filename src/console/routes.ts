import { Vault } from '../vault';
import { TenantStore, type KeywordDemand } from '../tenant-store';
import { DEFAULT_GATES, DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_TARGET, type Addons, type Floors, type Gates, type LlmConfig, type Pricing, type TenantConfig } from '../types';
import { LOW_STOCK_BAND, sellableQty, JOB_STAMP_DAILY, JOB_STAMP_PIPELINE, JOB_STAMP_MARKETS } from '../jobs';
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

export async function saveAddons(db: D1Database, shop: string, addons: Addons): Promise<void> {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  if (!cfg) return;
  await store.seedConfig({ ...cfg, addons });
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
  addons: Addons;
  target: number;
  gbFreeUkLive: boolean;      // the verify-then-flip "free UK delivery" gate (Phase 1)
  gbWarehousedCount: number;  // GB-warehoused imported products = the GB Local membership size
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
    addons: cfg?.addons ?? DEFAULT_ADDONS,
    target: cfg?.target ?? DEFAULT_TARGET,
    gbFreeUkLive: cfg?.fulfil?.gbFreeUkLive === true,
    gbWarehousedCount: (await store.listGbWarehousedShopifyProductIds()).length
  };
}

/** Flip the verify-then-flip "free UK delivery" gate (Fulfil.gbFreeUkLive). Owner flips ON
 *  only after a live GB-item-to-UK checkout is verified at GBP 0 (Phase 1 cutover).
 *  Uses the dedicated saveFulfil (seedConfig intentionally does NOT persist fulfil). */
export async function saveGbFreeUk(db: D1Database, shop: string, on: boolean): Promise<void> {
  const store = new TenantStore(db, shop);
  const cfg = await store.getConfig();
  if (!cfg) return;
  await store.saveFulfil({ ...(cfg.fulfil ?? { mode: 'manual' as const }), gbFreeUkLive: on });
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

// --- Glance (Phase 3): the landing view's single aggregate. ---
// Every field is a real D1 fact (counts, timestamps, cron completion stamps);
// nothing here is estimated or invented - an absent fact renders as absent.

export interface GlanceAttention {
  level: 'crit' | 'warn' | 'info';
  title: string;
  detail: string;
  route: 'inbox' | 'ops' | 'catalog' | 'settings';
}

export interface GlanceActivity {
  at: string;
  kind: 'auto_reply' | 'reply' | 'inbound' | 'order';
  who: string;      // contact email, or the order name
  detail: string;   // order status; empty for mail events
}

export interface Glance {
  ok: true;
  kpis: {
    pendingDrafts: number;
    oldestPendingAt: string | null;
    autoSent24h: number;
    ordersHeld: number;
    ordersInPipeline: number;
    pipeline: Record<string, number>;  // non-terminal statuses -> count
    liveProducts: number;
    lowStock: number;
  };
  attention: GlanceAttention[];
  activity: GlanceActivity[];
  health: {
    cjConnected: boolean;
    dailyLastRunAt: string | null;     // stamped by runDailyMaintenance on completion
    pipelineLastRunAt: string | null;  // stamped by the 15-min order pipeline on completion
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
  };
  markets: { at: string; markets: { name: string; excluded: number }[] } | null;
}

function parseHoldReasons(json: string | null): string[] {
  if (!json) return [];
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

export async function getGlance(db: D1Database, shop: string): Promise<Glance> {
  const store = new TenantStore(db, shop);
  const since24h = new Date(Date.now() - 86400_000).toISOString();

  const drafts = await store.pendingDraftStats();
  const autoSent24h = await store.countAutoSentSince(since24h);
  const byStatus = await store.countOrdersByStatus();
  const held = byStatus['held'] ?? 0;
  const awaiting = byStatus['awaiting-payment'] ?? 0;
  const pipeline: Record<string, number> = {};
  for (const s of ['received', 'queued', 'submitted', 'awaiting-payment'] as const) {
    if (byStatus[s]) pipeline[s] = byStatus[s];
  }
  const ordersInPipeline = Object.values(pipeline).reduce((a, b) => a + b, 0);
  const liveProducts = await store.countLinksByState('imported');
  const lowStock = await store.lowStockImportedProducts(LOW_STOCK_BAND, 5);
  const cjConnected = !!(await store.getSupplierCredential('cj'));

  // Attention queue, worst first: held orders block fulfilment, then money/review items.
  const attention: GlanceAttention[] = [];
  if (!cjConnected) {
    attention.push({
      level: 'crit', title: 'CJ supplier is not connected',
      detail: 'Imports, stock sync and fulfilment are paused until the API key is reconnected.', route: 'settings'
    });
  }
  for (const o of await store.listOrders('held', 5)) {
    const holds = parseHoldReasons(o.hold_reasons).join(', ');
    attention.push({
      level: 'crit', title: `Order ${o.order_name ?? o.shopify_order_id} is held`,
      detail: holds ? `Reason: ${holds}` : 'Review it under Operations', route: 'ops'
    });
  }
  if (awaiting) {
    attention.push({
      level: 'warn', title: `${awaiting} CJ order${awaiting === 1 ? '' : 's'} awaiting payment`,
      detail: 'Created in CJ and waiting for you to pay - tracking syncs back once paid.', route: 'ops'
    });
  }
  if (drafts.n) {
    attention.push({
      level: 'warn', title: `${drafts.n} draft ${drafts.n === 1 ? 'reply' : 'replies'} waiting for review`,
      detail: 'Approve, edit or regenerate them in the Inbox.', route: 'inbox'
    });
  }
  if (lowStock.length) {
    const names = lowStock.slice(0, 3).map((p) => `${p.title} (${sellableQty(p.stock)} left)`).join(' · ');
    attention.push({
      level: 'warn', title: `${lowStock.length} product${lowStock.length === 1 ? '' : 's'} nearly sold out at source`,
      detail: names, route: 'ops'
    });
  }

  // Activity: merge sent replies + inbound mail + orders, newest first.
  const sent = await store.recentSentDrafts(6);
  const inbound = await store.recentInboundMessages(6);
  const acts: GlanceActivity[] = [];
  for (const d of sent) acts.push({ at: d.sent_at, kind: d.status === 'auto_sent' ? 'auto_reply' : 'reply', who: d.contact_email, detail: '' });
  for (const m of inbound) acts.push({ at: m.received_at, kind: 'inbound', who: m.from_addr, detail: '' });
  for (const o of await store.listOrders(null, 4)) acts.push({ at: o.created_at, kind: 'order', who: o.order_name ?? o.shopify_order_id, detail: o.status });
  acts.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  let markets: Glance['markets'] = null;
  const marketsRaw = await store.getSearchCache(JOB_STAMP_MARKETS);
  if (marketsRaw) {
    try { markets = JSON.parse(marketsRaw) as Glance['markets']; } catch { markets = null; }
  }

  return {
    ok: true,
    kpis: {
      pendingDrafts: drafts.n,
      oldestPendingAt: drafts.oldestAt,
      autoSent24h,
      ordersHeld: held,
      ordersInPipeline,
      pipeline,
      liveProducts,
      lowStock: lowStock.length
    },
    attention,
    activity: acts.slice(0, 8),
    health: {
      cjConnected,
      dailyLastRunAt: await store.getSearchCache(JOB_STAMP_DAILY),
      pipelineLastRunAt: await store.getSearchCache(JOB_STAMP_PIPELINE),
      lastInboundAt: inbound[0]?.received_at ?? null,
      lastOutboundAt: sent[0]?.sent_at ?? null
    },
    markets
  };
}
