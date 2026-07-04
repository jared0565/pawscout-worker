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

const AUDIT_PAGE = 50;
// Category filter values must look like our label slugs; anything else (junk,
// injection-shaped strings) degrades to "all" rather than failing the view.
const AUDIT_CATEGORY_RE = /^[a-z][a-z-]{0,40}$/;

/**
 * Audit view v2 (2026-07-04 owner redesign): the landing list is CONTACTS -
 * email + stored name + latest-contact date + the classifications seen across
 * their threads - optionally scoped to one classification. Read-only.
 */
export async function getAudit(db: D1Database, shop: string, opts: { category?: string; before?: string; limit?: number } = {}) {
  const store = new TenantStore(db, shop);
  const category = typeof opts.category === 'string' && AUDIT_CATEGORY_RE.test(opts.category) ? opts.category : undefined;
  const before = typeof opts.before === 'string' && opts.before ? opts.before : undefined;
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || AUDIT_PAGE), 1), 100);
  const rows = await store.auditContacts({ category, before, limit });
  return {
    ok: true as const,
    contacts: rows.map((r) => ({
      email: r.email, name: r.name ?? null, lastAt: r.last_at, messages: r.n,
      categories: (r.categories ?? '').split(',').filter(Boolean)
    })),
    more: rows.length === limit
  };
}

/**
 * Audit conversation modal: every message exchanged with one contact across all
 * their threads, newest first, each send carrying its provenance ('auto' = the
 * machine sent it under the reply toggles, 'approved' = owner-approved HITL,
 * 'other' = system mail with no linked draft, e.g. an invoice email).
 */
export async function getAuditConversation(db: D1Database, shop: string, email: unknown) {
  if (typeof email !== 'string' || !email.trim()) return { ok: false as const, error: 'email required' };
  const store = new TenantStore(db, shop);
  const contact = await store.getContactByEmail(email);
  const rows = await store.auditConversation(email);
  return {
    ok: true as const,
    contact: { email, name: contact?.name ?? null },
    messages: rows.map((m) => ({
      id: m.id, threadId: m.thread_id, direction: m.direction,
      from: m.from_addr, to: m.to_addr, subject: m.subject,
      body: m.body_text, at: m.received_at, category: m.primary_category,
      sentVia: m.direction === 'outbound'
        ? (m.draft_status === 'auto_sent' ? 'auto' : m.draft_status === 'sent' ? 'approved' : 'other')
        : null,
      model: m.draft_model ?? null
    }))
  };
}

// --- Affiliate voucher trials (2026-07-04): Partners view API ---

/** Derived voucher state for display: owner revocation wins, then expiry. */
function voucherEffectiveStatus(status: string, endsAt: string, now: number): 'live' | 'revoked' | 'expired' {
  if (status === 'revoked') return 'revoked';
  const end = Date.parse(endsAt);
  if (!Number.isNaN(end) && end <= now) return 'expired';
  return 'live';
}

/** Partners list: one entry per voucher (newest first) with its ledger roll-up. */
export async function getPartners(db: D1Database, shop: string) {
  const store = new TenantStore(db, shop);
  const rows = await store.listAffiliateVouchers();
  const now = Date.now();
  return {
    ok: true as const,
    partners: rows.map((r) => ({
      partnerId: r.partner_id, voucherId: r.voucher_id,
      email: r.contact_email, name: r.name ?? null, channel: r.channel_url ?? null, notes: r.notes ?? null,
      code: r.code, pctOff: r.pct_off, commissionPct: r.commission_pct,
      startsAt: r.starts_at, endsAt: r.ends_at,
      status: voucherEffectiveStatus(r.status, r.ends_at, now),
      uses: r.uses, gross: r.gross, discount: r.discount, owed: r.owed, paid: r.paid,
      lastOrderAt: r.last_order_at ?? null
    }))
  };
}

/** Register a collaborator + the voucher the owner issued them in Shopify
 *  admin. The payload is validated upstream (validatePartnerPayload); the
 *  unique code index turns a duplicate registration into a friendly error. */
export async function createPartner(db: D1Database, shop: string, reg: import('../validate').PartnerRegistration) {
  const store = new TenantStore(db, shop);
  const partnerId = await store.upsertAffiliatePartner({
    contactEmail: reg.contactEmail, name: reg.name, channelUrl: reg.channelUrl, notes: reg.notes
  });
  try {
    const voucherId = await store.createAffiliateVoucher({
      partnerId, code: reg.code, pctOff: reg.pctOff, commissionPct: reg.commissionPct,
      endsAt: reg.endsAt, usageLimit: reg.usageLimit
    });
    return { ok: true as const, partnerId, voucherId };
  } catch (e) {
    const msg = (e as Error).message ?? '';
    if (/UNIQUE|constraint/i.test(msg)) return { ok: false as const, error: `Code ${reg.code} is already registered` };
    throw e;
  }
}

/** Owner actions on one voucher: revoke (stop honouring it here; the code must
 *  ALSO be disabled in Shopify admin, which the console reminds them to do) or
 *  mark the outstanding commission as paid out. */
export async function partnerVoucherAction(db: D1Database, shop: string, voucherId: unknown, action: unknown) {
  if (typeof voucherId !== 'string' || !voucherId.trim()) return { ok: false as const, error: 'voucherId required' };
  const store = new TenantStore(db, shop);
  if (action === 'revoke') {
    await store.setAffiliateVoucherStatus(voucherId, 'revoked');
    return { ok: true as const };
  }
  if (action === 'mark_paid') {
    const n = await store.markVoucherCommissionPaid(voucherId);
    return { ok: true as const, ordersCovered: n };
  }
  return { ok: false as const, error: 'action must be revoke or mark_paid' };
}

/** Ledger drill-down: the attributed orders behind one voucher's numbers. */
export async function getPartnerOrders(db: D1Database, shop: string, voucherId: unknown) {
  if (typeof voucherId !== 'string' || !voucherId.trim()) return { ok: false as const, error: 'voucherId required' };
  const store = new TenantStore(db, shop);
  const rows = await store.affiliateOrdersForVoucher(voucherId);
  return {
    ok: true as const,
    orders: rows.map((o) => ({
      id: o.shopify_order_id, name: o.order_name ?? null,
      gross: o.gross_gbp, discount: o.discount_gbp, commission: o.commission_gbp,
      financialStatus: o.financial_status ?? null, eligible: o.eligible === 1,
      placedAt: o.placed_at ?? null, paidOutAt: o.paid_out_at ?? null
    }))
  };
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
