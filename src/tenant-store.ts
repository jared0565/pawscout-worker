import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_SEMANTIC, type TenantRow, type TenantConfig, type Fulfil } from './types';
import type { LogisticsRoute } from './logistics';
import { deriveModels } from './llm-migrate';
import { DEFAULT_INBOX, type InboxConfig } from './inbox/types';
import type { ContactRow, ThreadRow, MessageRow, ThreadStatus, DraftRow, DraftStatus, InvoiceRow, InvoiceLineItem, InvoiceStatus, ApplicantRow, PartnershipStage, ScreenVerdict } from './inbox/types';

interface SupplierCredRow {
  shop: string; supplier: string; api_key_enc: string; label: string | null; validated_at: string | null; created_at: string;
}

export interface CjTokenRow { shop: string; token_enc: string; expires_at: string; refreshed_at: string }

export interface ProductLink {
  shop: string;
  cj_pid: string;
  shopify_product_id: string | null;
  handle: string | null;
  category: string | null;
  state: 'ghost' | 'importing' | 'imported' | 'archived' | 'failed' | 'draft';
  stock_paused: number; // 1 = inventory zeroed because CJ stock fell below floor
  created_at: string;
  updated_at: string;
}

export interface KeywordDemand { keyword_norm: string; searches: number; avg_store_hits: number; avg_ghost_hits: number }

export interface WarehouseRow {
  shop: string;
  cj_pid: string;
  category: string | null;
  title: string;
  detail: string; // CjDetail JSON
  price_usd: number;
  listed_num: number;
  stock: number;
  search_text: string;
  status: 'available' | 'low_stock' | 'stale';
  fetched_at: string;
  stock_checked_at: string;
  created_at: string;
}

export interface OrderRow {
  shop: string;
  shopify_order_id: string;
  order_name: string | null;
  total_price: number | null;
  currency: string | null;
  financial_status: string | null;
  risk_level: string | null;
  status: 'received' | 'held' | 'queued' | 'submitted' | 'awaiting-payment' | 'fulfilled' | 'cancelled' | 'error';
  hold_reasons: string | null;
  cj_order_id: string | null;
  tracking_number: string | null;
  address_json: string | null;
  line_items_json: string | null;
  fulfil_after: string | null;
  created_at: string;
  updated_at: string;
}

/** One row of the Audit view's landing list: a contact rolled up across all
 *  their threads - display name, latest activity and the categories seen. */
export interface AuditContactRow {
  email: string; name: string | null;
  last_at: string; n: number;
  categories: string | null; // GROUP_CONCAT of DISTINCT thread categories
}

/** One message of the Audit conversation modal: joined to its thread's
 *  category and (outbound only) the draft that produced it. */
export interface AuditMessageRow {
  id: string; thread_id: string; direction: 'inbound' | 'outbound';
  from_addr: string | null; to_addr: string | null; subject: string | null;
  body_text: string | null; received_at: string;
  primary_category: string | null;
  draft_status: string | null; draft_model: string | null;
}

/** One row of the Partners view: a voucher joined to its partner plus the
 *  ledger roll-up (uses/gross/discount over ELIGIBLE orders; owed/paid split
 *  by the payout stamp). Expiry is derived from ends_at at read time. */
export interface AffiliateVoucherListRow {
  voucher_id: string; code: string; pct_off: number; commission_pct: number;
  starts_at: string; ends_at: string; status: string; created_at: string;
  partner_id: string; contact_email: string; name: string | null;
  channel_url: string | null; notes: string | null;
  uses: number; gross: number; discount: number; owed: number; paid: number;
  last_order_at: string | null;
}

/** One attributed order of a voucher's ledger drill-down. */
export interface AffiliateOrderRow {
  shopify_order_id: string; order_name: string | null;
  gross_gbp: number; discount_gbp: number; commission_gbp: number;
  financial_status: string | null; eligible: number;
  placed_at: string | null; paid_out_at: string | null;
}

/** Voucher fields the attribution sweep needs for code matching. */
export interface AttributionVoucherRow {
  id: string; code: string; commission_pct: number; status: string; created_at: string;
}

export class TenantStore {
  constructor(private readonly db: D1Database, readonly shop: string) {}

  async upsertTenant(t: { accessTokenEnc: string; dekWrapped: string; scopes: string }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO tenants (shop, access_token_enc, dek_wrapped, scopes, status, installed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)
         ON CONFLICT(shop) DO UPDATE SET
           access_token_enc = ?2, dek_wrapped = ?3, scopes = ?4, status = 'active', updated_at = ?5`
      )
      .bind(this.shop, t.accessTokenEnc, t.dekWrapped, t.scopes, now)
      .run();
  }

  getTenant(): Promise<TenantRow | null> {
    return this.db.prepare(`SELECT * FROM tenants WHERE shop = ?1`).bind(this.shop).first<TenantRow>();
  }

  async setStatus(status: string): Promise<void> {
    await this.db.prepare(`UPDATE tenants SET status = ?2, updated_at = ?3 WHERE shop = ?1`)
      .bind(this.shop, status, new Date().toISOString()).run();
  }

  async seedConfig(cfg: TenantConfig): Promise<void> {
    // addons/fulfil/inbox are intentionally NOT written here - they ride the '{}' column default +
    // getConfig's DEFAULT_* merge, and each has a dedicated saver (saveAddons/saveFulfil/saveInbox).
    // Keep them out of this INSERT to avoid clobbering a console-saved value on a core-config re-seed.
    await this.db
      .prepare(
        `INSERT INTO tenant_config (shop, collection_map, gates, pricing, floors, llm, target, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(shop) DO UPDATE SET collection_map = ?2, gates = ?3, pricing = ?4, floors = ?5, llm = ?6, target = ?7, updated_at = ?8`
      )
      .bind(
        this.shop,
        JSON.stringify(cfg.collectionMap),
        JSON.stringify(cfg.gates),
        JSON.stringify(cfg.pricing),
        JSON.stringify(cfg.floors),
        JSON.stringify(cfg.llm),
        cfg.target,
        new Date().toISOString()
      )
      .run();
  }

  async getConfig(): Promise<TenantConfig | null> {
    const row = await this.db
      .prepare(`SELECT collection_map, gates, pricing, floors, llm, addons, fulfil, inbox, semantic, target FROM tenant_config WHERE shop = ?1`)
      .bind(this.shop)
      .first<{ collection_map: string; gates: string; pricing: string; floors: string; llm: string; addons: string; fulfil: string; inbox: string; semantic: string; target: number }>();
    if (!row) return null;
    return {
      collectionMap: JSON.parse(row.collection_map),
      gates: JSON.parse(row.gates),
      // Tolerate pre-flywheel rows ('{}' default): fill missing fields from defaults.
      pricing: { ...DEFAULT_PRICING, ...JSON.parse(row.pricing || '{}') },
      floors: { ...DEFAULT_FLOORS, ...JSON.parse(row.floors || '{}') },
      llm: (() => {
        const raw = JSON.parse(row.llm || '{}') as Record<string, unknown>;
        const models = (raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models))
          ? (raw.models as TenantConfig['llm']['models'])
          : deriveModels(raw);
        return {
          enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_LLM.enabled,
          scoreThreshold: typeof raw.scoreThreshold === 'number' ? raw.scoreThreshold : DEFAULT_LLM.scoreThreshold,
          models,
        };
      })(),
      addons: { ...DEFAULT_ADDONS, ...JSON.parse(row.addons || '{}') },
      fulfil: { ...DEFAULT_FULFIL, ...JSON.parse(row.fulfil || '{}') },
      inbox: { ...DEFAULT_INBOX, ...JSON.parse(row.inbox || '{}') },
      semantic: { ...DEFAULT_SEMANTIC, ...JSON.parse(row.semantic || '{}') },
      target: row.target
    };
  }

  /** Set the fulfilment mode (manual | pawscout | cj). */
  async saveFulfil(fulfil: Fulfil): Promise<void> {
    await this.db
      .prepare(`UPDATE tenant_config SET fulfil = ?2, updated_at = ?3 WHERE shop = ?1`)
      .bind(this.shop, JSON.stringify(fulfil), new Date().toISOString())
      .run();
  }

  /** Persist the inbox (email-CRM) config block. */
  async saveInbox(inbox: InboxConfig): Promise<void> {
    await this.db
      .prepare(`UPDATE tenant_config SET inbox = ?2, updated_at = ?3 WHERE shop = ?1`)
      .bind(this.shop, JSON.stringify(inbox), new Date().toISOString())
      .run();
  }

  async putSupplierCredential(supplier: string, apiKeyEnc: string, label: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO supplier_credentials (shop, supplier, api_key_enc, label, validated_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(shop, supplier) DO UPDATE SET api_key_enc = ?3, label = ?4, validated_at = ?5`
      )
      .bind(this.shop, supplier, apiKeyEnc, label, now)
      .run();
  }

  getSupplierCredential(supplier: string): Promise<SupplierCredRow | null> {
    return this.db
      .prepare(`SELECT * FROM supplier_credentials WHERE shop = ?1 AND supplier = ?2`)
      .bind(this.shop, supplier)
      .first<SupplierCredRow>();
  }

  async deleteAllSecrets(): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM supplier_credentials WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM cj_tokens WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`UPDATE tenants SET access_token_enc = '', dek_wrapped = '' WHERE shop = ?1`).bind(this.shop)
    ]);
  }

  // --- GDPR (Shopify mandatory privacy webhooks) ---

  /** customers/redact: erase the PII we hold for the named orders (their address). */
  async redactOrders(orderIds: string[]): Promise<number> {
    if (!orderIds.length) return 0;
    let removed = 0;
    for (let i = 0; i < orderIds.length; i += 50) {
      const chunk = orderIds.slice(i, i + 50);
      const ph = chunk.map((_, j) => `?${j + 2}`).join(',');
      const r = await this.db
        .prepare(`DELETE FROM orders WHERE shop = ?1 AND shopify_order_id IN (${ph})`)
        .bind(this.shop, ...chunk)
        .run();
      removed += r.meta.changes ?? 0;
    }
    return removed;
  }

  /** GDPR customers/redact: erase all inbox PII we hold for one contact email. */
  async redactContact(email: string): Promise<number> {
    const e = email.trim().toLowerCase();
    if (!e) return 0;
    const sub = `(SELECT id FROM inbox_threads WHERE shop = ?1 AND contact_email = ?2)`;
    const res = await this.db.batch([
      this.db.prepare(`DELETE FROM inbox_thread_labels WHERE shop = ?1 AND thread_id IN ${sub}`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_messages WHERE shop = ?1 AND thread_id IN ${sub}`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_drafts WHERE shop = ?1 AND thread_id IN ${sub}`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_invoices WHERE shop = ?1 AND thread_id IN ${sub}`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_threads WHERE shop = ?1 AND contact_email = ?2`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_contacts WHERE shop = ?1 AND email = ?2`).bind(this.shop, e)
    ]);
    return res.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  }

  /** GDPR customers/data-request: count inbox records we hold for one contact email. */
  async inboxDataSummary(email: string): Promise<{ threads: number; messages: number; invoices: number }> {
    const e = email.trim().toLowerCase();
    const t = await this.db.prepare(`SELECT COUNT(*) AS n FROM inbox_threads WHERE shop = ?1 AND contact_email = ?2`).bind(this.shop, e).first<{ n: number }>();
    const m = await this.db.prepare(`SELECT COUNT(*) AS n FROM inbox_messages WHERE shop = ?1 AND thread_id IN (SELECT id FROM inbox_threads WHERE shop = ?1 AND contact_email = ?2)`).bind(this.shop, e).first<{ n: number }>();
    const inv = await this.db.prepare(`SELECT COUNT(*) AS n FROM inbox_invoices WHERE shop = ?1 AND thread_id IN (SELECT id FROM inbox_threads WHERE shop = ?1 AND contact_email = ?2)`).bind(this.shop, e).first<{ n: number }>();
    return { threads: t?.n ?? 0, messages: m?.n ?? 0, invoices: inv?.n ?? 0 };
  }

  /** shop/redact: purge ALL data for this shop (sent ~48h after uninstall). */
  async redactShop(): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM orders WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM product_events WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM product_links WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM warehouse_products WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM cj_logistics WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM search_cache WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM search_log WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM llm_usage WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM supplier_credentials WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM cj_tokens WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM inbox_thread_labels WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM inbox_messages WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM inbox_drafts WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM inbox_invoices WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM inbox_threads WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM inbox_contacts WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM tenant_config WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM tenants WHERE shop = ?1`).bind(this.shop)
    ]);
  }

  // --- CJ token cache ---

  getCjToken(): Promise<CjTokenRow | null> {
    return this.db.prepare(`SELECT * FROM cj_tokens WHERE shop = ?1`).bind(this.shop).first<CjTokenRow>();
  }

  async putCjToken(tokenEnc: string, expiresAt: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO cj_tokens (shop, token_enc, expires_at, refreshed_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(shop) DO UPDATE SET token_enc = ?2, expires_at = ?3, refreshed_at = ?4`
      )
      .bind(this.shop, tokenEnc, expiresAt, now)
      .run();
  }

  // --- search cache + demand log ---

  async getSearchCache(cacheKey: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT payload FROM search_cache WHERE shop = ?1 AND cache_key = ?2 AND expires_at > ?3`)
      .bind(this.shop, cacheKey, new Date().toISOString())
      .first<{ payload: string }>();
    return row?.payload ?? null;
  }

  /** Batched read of curated hero images (`hero:<pid>` entries) → pid → hero URL.
   * Lets the search grid swap CJ's raw thumbnail for the vision-vetted hero. */
  async getHeroImages(pids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!pids.length) return out;
    const keys = pids.map((p) => `hero:${p}`);
    const ph = keys.map((_, i) => `?${i + 3}`).join(',');
    const rs = await this.db
      .prepare(`SELECT cache_key, payload FROM search_cache WHERE shop = ?1 AND expires_at > ?2 AND cache_key IN (${ph})`)
      .bind(this.shop, new Date().toISOString(), ...keys)
      .all<{ cache_key: string; payload: string }>();
    for (const row of rs.results ?? []) {
      try {
        const c = JSON.parse(row.payload) as { images?: string[] };
        const hero = c.images?.[0];
        if (hero) out.set(row.cache_key.slice(5), hero); // strip "hero:"
      } catch { /* skip corrupt cache row */ }
    }
    return out;
  }

  async putSearchCache(cacheKey: string, payload: string, ttlDays: number): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO search_cache (shop, cache_key, payload, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(shop, cache_key) DO UPDATE SET payload = ?3, created_at = ?4, expires_at = ?5`
      )
      .bind(this.shop, cacheKey, payload, new Date(now).toISOString(), new Date(now + ttlDays * 86400_000).toISOString())
      .run();
  }

  // --- Pet semantic term library (per shop+collection+term) ---
  async getSemanticExpansions(collection: string, term: string): Promise<{ expansions: string[]; updatedAt: string } | null> {
    const row = await this.db
      .prepare(`SELECT expansions_json, updated_at FROM semantic_terms WHERE shop = ?1 AND collection = ?2 AND term = ?3`)
      .bind(this.shop, collection, term)
      .first<{ expansions_json: string; updated_at: string }>();
    if (!row) return null;
    try { return { expansions: JSON.parse(row.expansions_json), updatedAt: row.updated_at }; }
    catch { return { expansions: [], updatedAt: row.updated_at }; }
  }
  async upsertSemanticTerm(collection: string, term: string, expansions: string[], source: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO semantic_terms (shop, collection, term, expansions_json, source, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(shop, collection, term) DO UPDATE SET expansions_json = ?4, source = ?5, updated_at = ?6`
      )
      .bind(this.shop, collection, term, JSON.stringify(expansions), source, new Date().toISOString())
      .run();
  }
  async listSemanticTermsForCollection(collection: string): Promise<{ term: string; updatedAt: string }[]> {
    const r = await this.db
      .prepare(`SELECT term, updated_at FROM semantic_terms WHERE shop = ?1 AND collection = ?2`)
      .bind(this.shop, collection)
      .all<{ term: string; updated_at: string }>();
    return (r.results ?? []).map((x) => ({ term: x.term, updatedAt: x.updated_at }));
  }

  async logSearch(keywordNorm: string, storeHits: number, ghostHits: number): Promise<void> {
    await this.db
      .prepare(`INSERT INTO search_log (shop, keyword_norm, store_hits, ghost_hits, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(this.shop, keywordNorm, storeHits, ghostHits, new Date().toISOString())
      .run();
  }

  /** Keywords searched since `sinceIso` whose combined fill stayed under `under`, most-searched first. */
  async underfilledKeywords(sinceIso: string, under: number, limit: number): Promise<KeywordDemand[]> {
    const rs = await this.db
      .prepare(
        `SELECT keyword_norm, COUNT(*) AS searches,
                AVG(store_hits) AS avg_store_hits, AVG(ghost_hits) AS avg_ghost_hits
         FROM search_log WHERE shop = ?1 AND created_at >= ?2
         GROUP BY keyword_norm HAVING AVG(store_hits) + AVG(ghost_hits) < ?3
         ORDER BY searches DESC LIMIT ?4`
      )
      .bind(this.shop, sinceIso, under, limit)
      .all<KeywordDemand>();
    return rs.results ?? [];
  }

  /** Recent demand overview for the console (all keywords, most-searched first). */
  async recentSearches(sinceIso: string, limit: number): Promise<KeywordDemand[]> {
    const rs = await this.db
      .prepare(
        `SELECT keyword_norm, COUNT(*) AS searches,
                AVG(store_hits) AS avg_store_hits, AVG(ghost_hits) AS avg_ghost_hits
         FROM search_log WHERE shop = ?1 AND created_at >= ?2
         GROUP BY keyword_norm ORDER BY searches DESC LIMIT ?3`
      )
      .bind(this.shop, sinceIso, limit)
      .all<KeywordDemand>();
    return rs.results ?? [];
  }

  // --- product links + events ---

  getLink(cjPid: string): Promise<ProductLink | null> {
    return this.db
      .prepare(`SELECT * FROM product_links WHERE shop = ?1 AND cj_pid = ?2`)
      .bind(this.shop, cjPid)
      .first<ProductLink>();
  }

  /** Reverse lookup for the order pipeline: which CJ product backs a Shopify product. */
  getLinkByShopifyProductId(shopifyProductId: string): Promise<ProductLink | null> {
    return this.db
      .prepare(`SELECT * FROM product_links WHERE shop = ?1 AND shopify_product_id = ?2 LIMIT 1`)
      .bind(this.shop, shopifyProductId)
      .first<ProductLink>();
  }

  /** Look up a product link by its storefront handle (URL/handle item signal). */
  getLinkByHandle(handle: string): Promise<ProductLink | null> {
    return this.db
      .prepare(`SELECT * FROM product_links WHERE shop = ?1 AND handle = ?2 LIMIT 1`)
      .bind(this.shop, handle)
      .first<ProductLink>();
  }

  // --- orders (W-FULFIL) ---

  /**
   * Idempotent insert - returns false if this Shopify order was already received
   * (webhooks can fire more than once; we must never fulfil an order twice).
   */
  async insertOrderIfNew(o: {
    shopifyOrderId: string; orderName: string | null; totalPrice: number | null; currency: string | null;
    financialStatus: string | null; riskLevel: string | null; status: OrderRow['status'];
    holdReasons: string[]; addressJson: string | null; lineItemsJson: string | null; fulfilAfter: string | null;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const r = await this.db
      .prepare(
        `INSERT INTO orders
           (shop, shopify_order_id, order_name, total_price, currency, financial_status, risk_level,
            status, hold_reasons, address_json, line_items_json, fulfil_after, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
         ON CONFLICT(shop, shopify_order_id) DO NOTHING`
      )
      .bind(this.shop, o.shopifyOrderId, o.orderName, o.totalPrice, o.currency, o.financialStatus, o.riskLevel,
        o.status, JSON.stringify(o.holdReasons), o.addressJson, o.lineItemsJson, o.fulfilAfter, now)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  getOrder(shopifyOrderId: string): Promise<OrderRow | null> {
    return this.db
      .prepare(`SELECT * FROM orders WHERE shop = ?1 AND shopify_order_id = ?2`)
      .bind(this.shop, shopifyOrderId)
      .first<OrderRow>();
  }

  /** Look up by the customer-visible order name ("#1001") - the only identifier the
   * order-status agent gets back from the Shopify customer-orders query. */
  getOrderByName(orderName: string): Promise<OrderRow | null> {
    return this.db
      .prepare(`SELECT * FROM orders WHERE shop = ?1 AND order_name = ?2`)
      .bind(this.shop, orderName)
      .first<OrderRow>();
  }

  async listOrders(status: string | null, limit = 100): Promise<OrderRow[]> {
    const lim = Math.min(Math.max(limit, 1), 200);
    const rs = status
      ? await this.db.prepare(`SELECT * FROM orders WHERE shop = ?1 AND status = ?2 ORDER BY created_at DESC LIMIT ${lim}`).bind(this.shop, status).all<OrderRow>()
      : await this.db.prepare(`SELECT * FROM orders WHERE shop = ?1 ORDER BY created_at DESC LIMIT ${lim}`).bind(this.shop).all<OrderRow>();
    return rs.results ?? [];
  }

  /** Queued orders whose grace window has elapsed - ready for Stage-B auto-submit. */
  async dueQueuedOrders(nowIso: string, limit = 20): Promise<OrderRow[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM orders WHERE shop = ?1 AND status = 'queued' AND (fulfil_after IS NULL OR fulfil_after <= ?2) ORDER BY created_at ASC LIMIT ${Math.min(Math.max(limit, 1), 50)}`)
      .bind(this.shop, nowIso)
      .all<OrderRow>();
    return rs.results ?? [];
  }

  async updateOrder(shopifyOrderId: string, fields: Partial<Pick<OrderRow, 'status' | 'hold_reasons' | 'cj_order_id' | 'tracking_number'>>): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `UPDATE orders SET
           status = COALESCE(?3, status),
           hold_reasons = COALESCE(?4, hold_reasons),
           cj_order_id = COALESCE(?5, cj_order_id),
           tracking_number = COALESCE(?6, tracking_number),
           updated_at = ?7
         WHERE shop = ?1 AND shopify_order_id = ?2`
      )
      .bind(this.shop, shopifyOrderId, fields.status ?? null, fields.hold_reasons ?? null, fields.cj_order_id ?? null, fields.tracking_number ?? null, now)
      .run();
  }

  async getLinks(cjPids: string[]): Promise<Map<string, ProductLink>> {
    const out = new Map<string, ProductLink>();
    if (!cjPids.length) return out;
    // D1 caps bound parameters; chunk to stay well under it.
    for (let i = 0; i < cjPids.length; i += 50) {
      const chunk = cjPids.slice(i, i + 50);
      const placeholders = chunk.map((_, j) => `?${j + 2}`).join(',');
      const rs = await this.db
        .prepare(`SELECT * FROM product_links WHERE shop = ?1 AND cj_pid IN (${placeholders})`)
        .bind(this.shop, ...chunk)
        .all<ProductLink>();
      for (const row of rs.results ?? []) out.set(row.cj_pid, row);
    }
    return out;
  }

  async putLink(link: { cjPid: string; state: ProductLink['state']; shopifyProductId?: string | null; handle?: string | null; category?: string | null }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO product_links (shop, cj_pid, shopify_product_id, handle, category, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(shop, cj_pid) DO UPDATE SET
           shopify_product_id = COALESCE(?3, shopify_product_id),
           handle = COALESCE(?4, handle),
           category = COALESCE(?5, category),
           state = ?6, updated_at = ?7`
      )
      .bind(this.shop, link.cjPid, link.shopifyProductId ?? null, link.handle ?? null, link.category ?? null, link.state, now)
      .run();
  }

  async recordEvent(cjPid: string, event: 'view' | 'atc' | 'order'): Promise<void> {
    await this.db
      .prepare(`INSERT INTO product_events (shop, cj_pid, event, created_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(this.shop, cjPid, event, new Date().toISOString())
      .run();
  }

  /** Real ORDER events in the window - powers the deterministic "Selling fast" badge
   * (only genuine recent sales can light it; it clears when demand fades). */
  async countRecentOrderEvents(cjPid: string, sinceIso: string): Promise<number> {
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM product_events WHERE shop = ?1 AND cj_pid = ?2 AND event = 'order' AND created_at >= ?3`)
      .bind(this.shop, cjPid, sinceIso)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async logLlmUsage(task: string, model: string, promptTokens: number, completionTokens: number, costUsd: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO llm_usage (shop, task, model, prompt_tokens, completion_tokens, cost_usd, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(this.shop, task, model, promptTokens, completionTokens, costUsd, new Date().toISOString())
      .run();
  }

  async llmSpendSince(sinceIso: string): Promise<{ calls: number; costUsd: number }> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM llm_usage WHERE shop = ?1 AND created_at >= ?2`)
      .bind(this.shop, sinceIso)
      .first<{ calls: number; cost: number }>();
    return { calls: row?.calls ?? 0, costUsd: row?.cost ?? 0 };
  }

  /**
   * Imported products older than the grace cutoff with zero qualifying events
   * since the window cutoff. Stock-paused products are exempt - they couldn't
   * earn views while unsellable (W2.4).
   */
  async linksEligibleForArchive(cutoffIso: string): Promise<ProductLink[]> {
    const rs = await this.db
      .prepare(
        `SELECT pl.* FROM product_links pl
         WHERE pl.shop = ?1 AND pl.state = 'imported' AND pl.stock_paused = 0 AND pl.created_at < ?2
           AND NOT EXISTS (
             SELECT 1 FROM product_events pe
             WHERE pe.shop = pl.shop AND pe.cj_pid = pl.cj_pid AND pe.created_at >= ?2
           )`
      )
      .bind(this.shop, cutoffIso)
      .all<ProductLink>();
    return rs.results ?? [];
  }

  async setStockPaused(cjPid: string, paused: boolean): Promise<void> {
    await this.db
      .prepare(`UPDATE product_links SET stock_paused = ?3, updated_at = ?4 WHERE shop = ?1 AND cj_pid = ?2`)
      .bind(this.shop, cjPid, paused ? 1 : 0, new Date().toISOString())
      .run();
  }

  async listImportedLinks(limit = 200): Promise<ProductLink[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM product_links WHERE shop = ?1 AND state = 'imported' ORDER BY updated_at ASC LIMIT ${Math.min(Math.max(limit, 1), 500)}`)
      .bind(this.shop)
      .all<ProductLink>();
    return rs.results ?? [];
  }

  /** Imported, unpaused products whose last-synced source stock is at or below the
   * threshold - the low band where a shared-warehouse race is likely. Powers the
   * fast (15-min) re-sync that shrinks the nightly sync's staleness window for
   * exactly the risky items. */
  async lowStockImportedCjPids(threshold: number, limit = 25): Promise<string[]> {
    const rs = await this.db
      .prepare(
        `SELECT l.cj_pid FROM product_links l
         JOIN warehouse_products w ON w.shop = l.shop AND w.cj_pid = l.cj_pid
         WHERE l.shop = ?1 AND l.state = 'imported' AND l.stock_paused = 0 AND w.stock <= ?2
         ORDER BY w.stock ASC LIMIT ${Math.min(Math.max(limit, 1), 100)}`
      )
      .bind(this.shop, threshold)
      .all<{ cj_pid: string }>();
    return (rs.results ?? []).map((r) => r.cj_pid);
  }

  async linksByState(state: ProductLink['state']): Promise<ProductLink[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM product_links WHERE shop = ?1 AND state = ?2 ORDER BY updated_at ASC`)
      .bind(this.shop, state)
      .all<ProductLink>();
    return rs.results ?? [];
  }

  /** Hard-delete a product's link + warehouse rows (the Shopify product, if any, is
   *  deleted separately via the Admin API). Reusable cleanup accessor. */
  async purgeProductData(cjPid: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM product_links WHERE shop = ?1 AND cj_pid = ?2`).bind(this.shop, cjPid),
      this.db.prepare(`DELETE FROM warehouse_products WHERE shop = ?1 AND cj_pid = ?2`).bind(this.shop, cjPid)
    ]);
  }

  /** W-ADDON: hidden filler handles for the storefront widgets (random rotation). */
  async listAddonHandles(limit = 4): Promise<string[]> {
    const rs = await this.db
      .prepare(
        `SELECT handle FROM product_links
         WHERE shop = ?1 AND category = 'addons' AND state = 'imported'
           AND stock_paused = 0 AND handle IS NOT NULL
         ORDER BY RANDOM() LIMIT ${Math.min(Math.max(limit, 1), 8)}`
      )
      .bind(this.shop)
      .all<{ handle: string }>();
    return (rs.results ?? []).map((r) => r.handle);
  }

  async countImportedByCategory(category: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM product_links WHERE shop = ?1 AND category = ?2 AND state = 'imported'`)
      .bind(this.shop, category)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Shopify product ids for imported, GB-warehoused products: the membership source for
   * the GB Local delivery profile (free UK shipping). GB-warehoused = the cached
   * warehouse_products.detail (origins JSON) contains the "GB" key. Only state='imported'
   * with a non-null shopify_product_id (a live, assignable product). Shop-scoped.
   */
  async listGbWarehousedShopifyProductIds(): Promise<string[]> {
    const rs = await this.db
      .prepare(
        `SELECT l.shopify_product_id AS id
         FROM product_links l
         JOIN warehouse_products w ON w.shop = l.shop AND w.cj_pid = l.cj_pid
         WHERE l.shop = ?1 AND l.state = 'imported' AND l.shopify_product_id IS NOT NULL AND w.detail LIKE '%"GB"%'`
      )
      .bind(this.shop)
      .all<{ id: string }>();
    return (rs.results ?? []).map((r) => r.id);
  }

  /**
   * Groups imported, shopify-linked products by their origin signature.
   * The signature is the sorted comma-joined set of origin codes whose stock
   * value in the warehouse_products.detail origins map is greater than zero
   * (e.g. "CN", "GB", "CN,US"). Returns a Map from signature to the list of
   * Shopify product ids that share that signature. Shop-scoped.
   */
  async listSignatureMemberships(): Promise<Map<string, string[]>> {
    const rs = await this.db.prepare(
      `SELECT l.shopify_product_id AS id, je.key AS origin
         FROM product_links l
         JOIN warehouse_products w ON w.shop = l.shop AND w.cj_pid = l.cj_pid
         JOIN json_each(json_extract(w.detail, '$.origins')) je
         WHERE l.shop = ?1 AND l.state = 'imported' AND l.shopify_product_id IS NOT NULL
           AND CAST(je.value AS INTEGER) > 0`
    ).bind(this.shop).all<{ id: string; origin: string }>();
    const perProduct = new Map<string, Set<string>>();
    for (const r of rs.results ?? []) {
      if (!perProduct.has(r.id)) perProduct.set(r.id, new Set());
      perProduct.get(r.id)!.add(r.origin);
    }
    const bySig = new Map<string, string[]>();
    for (const [id, origins] of perProduct) {
      const sig = [...origins].sort().join(',');
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig)!.push(id);
    }
    return bySig;
  }

  // --- W1: PS-local product warehouse ---

  async putWarehouseProduct(p: {
    cjPid: string;
    category: string | null;
    title: string;
    detailJson: string;
    priceUsd: number;
    listedNum: number;
    stock: number;
  }): Promise<void> {
    const now = new Date().toISOString();
    const searchText = `${p.title} ${p.category ?? ''}`.toLowerCase();
    await this.db
      .prepare(
        `INSERT INTO warehouse_products
           (shop, cj_pid, category, title, detail, price_usd, listed_num, stock, search_text, status, fetched_at, stock_checked_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'available', ?10, ?10, ?10)
         ON CONFLICT(shop, cj_pid) DO UPDATE SET
           category = COALESCE(?3, category), title = ?4, detail = ?5, price_usd = ?6,
           listed_num = ?7, stock = ?8, search_text = ?9, status = 'available',
           fetched_at = ?10, stock_checked_at = ?10`
      )
      .bind(this.shop, p.cjPid, p.category, p.title, p.detailJson, p.priceUsd, p.listedNum, p.stock, searchText, now)
      .run();
  }

  getWarehouseProduct(cjPid: string): Promise<WarehouseRow | null> {
    return this.db
      .prepare(`SELECT * FROM warehouse_products WHERE shop = ?1 AND cj_pid = ?2`)
      .bind(this.shop, cjPid)
      .first<WarehouseRow>();
  }

  /** Available rows matching ANY token in title/category text (ranking happens in the caller). */
  async searchWarehouse(tokens: string[], limit: number): Promise<WarehouseRow[]> {
    const clean = tokens.map((t) => t.replace(/[%_]/g, '')).filter(Boolean).slice(0, 6);
    if (!clean.length) return [];
    const conds = clean.map((_, i) => `search_text LIKE ?${i + 2}`).join(' OR ');
    const rs = await this.db
      .prepare(
        `SELECT * FROM warehouse_products WHERE shop = ?1 AND status = 'available' AND (${conds})
         ORDER BY listed_num DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`
      )
      .bind(this.shop, ...clean.map((t) => `%${t}%`))
      .all<WarehouseRow>();
    return rs.results ?? [];
  }

  /** Available warehouse rows for a category, best (most-listed) first - promotion candidates. */
  async warehouseByCategory(category: string, limit: number): Promise<WarehouseRow[]> {
    const rs = await this.db
      .prepare(
        `SELECT * FROM warehouse_products WHERE shop = ?1 AND category = ?2 AND status = 'available'
         ORDER BY listed_num DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`
      )
      .bind(this.shop, category)
      .all<WarehouseRow>();
    return rs.results ?? [];
  }

  /** All warehouse titles (any status) - for dedupe-at-admission signatures. */
  async warehouseTitles(): Promise<string[]> {
    const rs = await this.db
      .prepare(`SELECT title FROM warehouse_products WHERE shop = ?1`)
      .bind(this.shop)
      .all<{ title: string }>();
    return (rs.results ?? []).map((r) => r.title);
  }

  async countWarehouseAvailableByCategory(category: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM warehouse_products WHERE shop = ?1 AND category = ?2 AND status = 'available'`)
      .bind(this.shop, category)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async setWarehouseStock(cjPid: string, stock: number, status: 'available' | 'low_stock'): Promise<void> {
    await this.db
      .prepare(
        `UPDATE warehouse_products SET stock = ?3, status = ?4, stock_checked_at = ?5
         WHERE shop = ?1 AND cj_pid = ?2`
      )
      .bind(this.shop, cjPid, stock, status, new Date().toISOString())
      .run();
  }

  /** Rows whose stock check or detail fetch is older than the cutoff (freshness cycle). */
  async staleWarehouseRows(kind: 'stock' | 'detail', cutoffIso: string, limit: number): Promise<WarehouseRow[]> {
    const field = kind === 'stock' ? 'stock_checked_at' : 'fetched_at';
    const rs = await this.db
      .prepare(`SELECT * FROM warehouse_products WHERE shop = ?1 AND ${field} < ?2 ORDER BY ${field} ASC LIMIT ${Math.min(Math.max(limit, 1), 100)}`)
      .bind(this.shop, cutoffIso)
      .all<WarehouseRow>();
    return rs.results ?? [];
  }

  /** A few available warehouse detail JSONs (most-listed first) - used to pick a
   *  representative in-stock vid for the logistics freight probe. */
  async sampleWarehouseDetails(limit: number): Promise<string[]> {
    const rs = await this.db
      .prepare(`SELECT detail FROM warehouse_products WHERE shop = ?1 AND status = 'available' ORDER BY listed_num DESC LIMIT ${Math.min(Math.max(limit, 1), 50)}`)
      .bind(this.shop)
      .all<{ detail: string }>();
    return (rs.results ?? []).map((r) => r.detail);
  }

  /**
   * Distinct non-CN origin ISO-2 codes that have at least one stocked unit in
   * this shop's warehouse. Reads `origins` from each row's `detail` JSON via
   * json_each and returns only keys where value > 0 and key != 'CN'.
   * Used by the nightly logistics sync to discover which non-CN origins to sync.
   */
  async catalogNonCnOrigins(): Promise<string[]> {
    const rs = await this.db
      .prepare(
        `SELECT DISTINCT je.key AS origin
         FROM warehouse_products AS wp, json_each(json_extract(wp.detail, '$.origins')) AS je
         WHERE wp.shop = ?1
           AND wp.status = 'available'
           AND je.key != 'CN'
           AND CAST(je.value AS INTEGER) > 0
         ORDER BY je.key`
      )
      .bind(this.shop)
      .all<{ origin: string }>();
    return (rs.results ?? []).map((r) => r.origin);
  }

  /**
   * Available warehouse detail JSONs for rows that have at least one unit stocked
   * in `origin` (i.e. origins[origin] > 0). Most-listed first. Mirrors
   * sampleWarehouseDetails but scoped to a specific non-CN origin. Used by
   * findRepresentativeVidForOrigin to pick a rep vid for the non-CN sync probe.
   */
  async sampleWarehouseDetailsForOrigin(origin: string, limit: number): Promise<string[]> {
    const rs = await this.db
      .prepare(
        `SELECT detail FROM warehouse_products
         WHERE shop = ?1
           AND status = 'available'
           AND EXISTS (
             SELECT 1 FROM json_each(json_extract(detail, '$.origins')) AS je
             WHERE je.key = ?2 AND CAST(je.value AS INTEGER) > 0
           )
         ORDER BY listed_num DESC
         LIMIT ${Math.min(Math.max(limit, 1), 50)}`
      )
      .bind(this.shop, origin)
      .all<{ detail: string }>();
    return (rs.results ?? []).map((r) => r.detail);
  }

  // --- CJ logistics (synced delivery-time matrix) -------------------------------

  /** Upsert a refreshed route row (a SUCCESSFUL quote): resets the failure counter. */
  async upsertLogisticsRoute(r: {
    from: string; to: string; channel: string;
    transitMin: number | null; transitMax: number | null; agingRaw: string; repVid: string;
    freightCostUsd?: number | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO cj_logistics
           (shop, from_country, to_country, channel, transit_min, transit_max, aging_raw, rep_vid, freight_cost_usd, synced_at, consecutive_failures, last_error, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?10, ?9, 0, NULL, ?9)
         ON CONFLICT(shop, from_country, to_country) DO UPDATE SET
           channel = ?4, transit_min = ?5, transit_max = ?6, aging_raw = ?7, rep_vid = ?8,
           freight_cost_usd = ?10, synced_at = ?9, consecutive_failures = 0, last_error = NULL`
      )
      .bind(this.shop, r.from, r.to, r.channel, r.transitMin, r.transitMax, r.agingRaw, r.repVid, now, r.freightCostUsd ?? null)
      .run();
  }

  /** Record a failed refresh for an EXISTING route - keeps the last-good row, bumps the
   *  failure counter. No-op when the route has never synced (nothing to preserve => hedge). */
  async bumpLogisticsFailure(from: string, to: string, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE cj_logistics SET consecutive_failures = consecutive_failures + 1, last_error = ?4
         WHERE shop = ?1 AND from_country = ?2 AND to_country = ?3`
      )
      .bind(this.shop, from, to, error.slice(0, 300))
      .run();
  }

  /**
   * Freshness-gated route read - the SINGLE consumption chokepoint. Returns null
   * (== "hedge") when the row is missing, older than stalenessHours, or has no
   * parsed transit. 'stale == missing == null' holds identically for every caller.
   */
  async getLogisticsRoute(from: string, to: string, stalenessHours: number, now: number = Date.now()): Promise<LogisticsRoute | null> {
    const row = await this.db
      .prepare(
        `SELECT from_country, to_country, channel, transit_min, transit_max, aging_raw, freight_cost_usd, synced_at
         FROM cj_logistics WHERE shop = ?1 AND from_country = ?2 AND to_country = ?3`
      )
      .bind(this.shop, from, to)
      .first<LogisticsRoute>();
    if (!row || row.transit_min == null) return null;
    const synced = Date.parse(row.synced_at);
    if (!Number.isFinite(synced) || synced < now - stalenessHours * 3600_000) return null;
    return row;
  }

  /** (to_country, synced_at) for this origin - lets the sync refresh oldest-first
   *  (so a budget-truncated run never starves the same tail). */
  async logisticsSyncedFor(from: string): Promise<Map<string, string>> {
    const rs = await this.db
      .prepare(`SELECT to_country, synced_at FROM cj_logistics WHERE shop = ?1 AND from_country = ?2`)
      .bind(this.shop, from)
      .all<{ to_country: string; synced_at: string }>();
    return new Map((rs.results ?? []).map((r) => [r.to_country, r.synced_at]));
  }

  /** Drop rows for destinations no longer in scope (keep set non-empty to avoid a full wipe). */
  async pruneLogisticsRoutes(from: string, keepTo: string[]): Promise<void> {
    if (!keepTo.length) return;
    const ph = keepTo.map((_, i) => `?${i + 3}`).join(', ');
    await this.db
      .prepare(`DELETE FROM cj_logistics WHERE shop = ?1 AND from_country = ?2 AND to_country NOT IN (${ph})`)
      .bind(this.shop, from, ...keepTo)
      .run();
  }

  // --- W-INBOX: email CRM ---

  async upsertContact(c: { email: string; name?: string | null; phone?: string | null }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO inbox_contacts (shop, email, name, phone, message_count, first_seen_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
         ON CONFLICT(shop, email) DO UPDATE SET
           name = COALESCE(?3, name), phone = COALESCE(?4, phone),
           message_count = message_count + 1, last_seen_at = ?5`
      )
      .bind(this.shop, c.email, c.name ?? null, c.phone ?? null, now)
      .run();
  }

  async linkContactToShopifyCustomer(email: string, customerId: string): Promise<void> {
    await this.db.prepare(`UPDATE inbox_contacts SET shopify_customer_id = ?3 WHERE shop = ?1 AND email = ?2`).bind(this.shop, email, customerId).run();
  }

  getContactByEmail(email: string): Promise<ContactRow | null> {
    return this.db.prepare(`SELECT * FROM inbox_contacts WHERE shop = ?1 AND email = ?2`).bind(this.shop, email).first<ContactRow>();
  }

  /** Find an existing thread for a reply: first by any referenced Message-ID,
   * then by (contact + normalized subject). Returns the thread id or null. */
  async matchThread(args: { contactEmail: string; inReplyTo: string | null; references: string[]; subjectNorm: string }): Promise<string | null> {
    const refs = [args.inReplyTo, ...args.references].filter((r): r is string => !!r);
    if (refs.length) {
      const ph = refs.map((_, i) => `?${i + 2}`).join(',');
      const row = await this.db
        .prepare(`SELECT thread_id FROM inbox_messages WHERE shop = ?1 AND message_id IN (${ph}) LIMIT 1`)
        .bind(this.shop, ...refs)
        .first<{ thread_id: string }>();
      if (row?.thread_id) return row.thread_id;
    }
    if (args.subjectNorm) {
      const row = await this.db
        .prepare(`SELECT id FROM inbox_threads WHERE shop = ?1 AND contact_email = ?2 AND subject_norm = ?3 ORDER BY last_message_at DESC LIMIT 1`)
        .bind(this.shop, args.contactEmail, args.subjectNorm)
        .first<{ id: string }>();
      if (row?.id) return row.id;
    }
    return null;
  }

  async createThread(t: { contactEmail: string; subject: string; subjectNorm: string; receivedAt: string; initialStatus: ThreadStatus; declaredIntent?: string | null }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO inbox_threads (shop, id, contact_email, subject, subject_norm, status, last_message_at, created_at, updated_at, declared_intent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`
      )
      .bind(this.shop, id, t.contactEmail, t.subject, t.subjectNorm, t.initialStatus, t.receivedAt, now, t.declaredIntent ?? null)
      .run();
    return id;
  }

  /** Insert an inbound message; false if its Message-ID was already stored (dedup). */
  async insertInboundMessageIfNew(m: {
    threadId: string; messageId: string | null; inReplyTo: string | null; references: string[];
    from: string; to: string | null; subject: string | null; bodyText: string | null;
    bodyHtml: string | null; headersJson: string | null; receivedAt: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const r = await this.db
      .prepare(
        `INSERT INTO inbox_messages
           (shop, id, thread_id, direction, message_id, in_reply_to, ref_ids, from_addr, to_addr, subject, body_text, body_html, headers_json, received_at, created_at)
         VALUES (?1, ?2, ?3, 'inbound', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(shop, message_id) DO NOTHING`
      )
      .bind(this.shop, crypto.randomUUID(), m.threadId, m.messageId, m.inReplyTo,
        m.references.join(' ') || null, m.from, m.to, m.subject, m.bodyText, m.bodyHtml, m.headersJson, m.receivedAt, now)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async touchThread(threadId: string, lastMessageAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE inbox_threads SET last_message_at = ?3, updated_at = ?4 WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, threadId, lastMessageAt, new Date().toISOString())
      .run();
  }

  async listThreads(status: string | null, limit = 50): Promise<ThreadRow[]> {
    const lim = Math.min(Math.max(limit, 1), 200);
    let rs;
    if (status === 'open') {
      // Default console view = threads still needing the merchant's attention, i.e.
      // ONLY new + needs_reply. awaiting_customer is excluded too: once a reply is
      // sent the thread flips to awaiting_customer (send.ts) and must drop OFF this
      // list (it's processed - the ball is in the customer's court). Excluding only
      // converted/closed/spam left replied threads lingering here, which read as
      // "still unprocessed". The merchant can still see them via the dedicated
      // "Awaiting customer" filter.
      rs = await this.db.prepare(`SELECT * FROM inbox_threads WHERE shop = ?1 AND status NOT IN ('awaiting_customer', 'converted', 'closed', 'spam') ORDER BY last_message_at DESC LIMIT ${lim}`).bind(this.shop).all<ThreadRow>();
    } else if (status) {
      rs = await this.db.prepare(`SELECT * FROM inbox_threads WHERE shop = ?1 AND status = ?2 ORDER BY last_message_at DESC LIMIT ${lim}`).bind(this.shop, status).all<ThreadRow>();
    } else {
      rs = await this.db.prepare(`SELECT * FROM inbox_threads WHERE shop = ?1 ORDER BY last_message_at DESC LIMIT ${lim}`).bind(this.shop).all<ThreadRow>();
    }
    return rs.results ?? [];
  }

  async getThreadWithMessages(threadId: string): Promise<{ thread: ThreadRow; messages: MessageRow[]; labels: string[] } | null> {
    const thread = await this.db.prepare(`SELECT * FROM inbox_threads WHERE shop = ?1 AND id = ?2`).bind(this.shop, threadId).first<ThreadRow>();
    if (!thread) return null;
    const msgs = await this.db.prepare(`SELECT * FROM inbox_messages WHERE shop = ?1 AND thread_id = ?2 ORDER BY received_at ASC`).bind(this.shop, threadId).all<MessageRow>();
    const labs = await this.db.prepare(`SELECT label FROM inbox_thread_labels WHERE shop = ?1 AND thread_id = ?2`).bind(this.shop, threadId).all<{ label: string }>();
    return { thread, messages: msgs.results ?? [], labels: (labs.results ?? []).map((l) => l.label) };
  }

  async setThreadStatus(threadId: string, status: ThreadStatus): Promise<void> {
    await this.db
      .prepare(`UPDATE inbox_threads SET status = ?3, updated_at = ?4 WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, threadId, status, new Date().toISOString())
      .run();
  }

  /**
   * Add ONE label to a thread, non-destructively (keeps any existing labels). Used
   * on send to auto-tag the thread by its classifier category so the merchant never
   * has to set labels by hand. PRIMARY KEY (shop, thread_id, label) makes the
   * INSERT OR IGNORE a no-op when the label is already present.
   */
  async addThreadLabel(threadId: string, label: string): Promise<void> {
    await this.db
      .prepare(`INSERT OR IGNORE INTO inbox_thread_labels (shop, thread_id, label) VALUES (?1, ?2, ?3)`)
      .bind(this.shop, threadId, label)
      .run();
  }

  /** Replace a thread's label set. */
  async setThreadLabels(threadId: string, labels: string[]): Promise<void> {
    const uniq = [...new Set(labels)].slice(0, 20);
    const stmts = [this.db.prepare(`DELETE FROM inbox_thread_labels WHERE shop = ?1 AND thread_id = ?2`).bind(this.shop, threadId)];
    for (const label of uniq) {
      stmts.push(this.db.prepare(`INSERT INTO inbox_thread_labels (shop, thread_id, label) VALUES (?1, ?2, ?3)`).bind(this.shop, threadId, label));
    }
    await this.db.batch(stmts);
  }

  async unclassifiedThreads(limit = 20): Promise<ThreadRow[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM inbox_threads WHERE shop = ?1 AND classified_at IS NULL AND status = 'new' ORDER BY last_message_at ASC LIMIT ${Math.min(Math.max(limit, 1), 50)}`)
      .bind(this.shop)
      .all<ThreadRow>();
    return rs.results ?? [];
  }

  /** Open classified threads whose sender has written again since classification
   *  (an inbound row was inserted after classified_at - insert-time comparison, so
   *  a spoofed Date header cannot hide a follow-up). The bait-opener pattern: an
   *  innocuous first message earns a benign category, then the real pitch arrives;
   *  one-shot classification would route the thread to the wrong agent forever. */
  async reclassifyCandidates(limit = 20): Promise<ThreadRow[]> {
    const rs = await this.db
      .prepare(`SELECT t.* FROM inbox_threads t WHERE t.shop = ?1 AND t.classified_at IS NOT NULL
                AND t.status IN ('new', 'needs_reply')
                AND EXISTS (SELECT 1 FROM inbox_messages m WHERE m.shop = t.shop AND m.thread_id = t.id
                            AND m.direction = 'inbound' AND m.created_at > t.classified_at)
                ORDER BY t.last_message_at ASC LIMIT ${Math.min(Math.max(limit, 1), 50)}`)
      .bind(this.shop)
      .all<ThreadRow>();
    return rs.results ?? [];
  }

  /** Bump classified_at without touching the verdict - used when a follow-up gave
   *  nothing new to judge (all-quote) or confirmed the existing lane, so the thread
   *  stops qualifying as a reclassify candidate until the sender writes again. */
  async touchClassifiedAt(threadId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(`UPDATE inbox_threads SET classified_at = ?3, updated_at = ?3 WHERE shop = ?1 AND id = ?2`).bind(this.shop, threadId, now).run();
  }

  async setThreadClassification(threadId: string, c: { status: ThreadStatus; primaryCategory: string | null; intentScore: number | null; summary: string | null; classifiedAt: string }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE inbox_threads SET status = ?3, primary_category = ?4, intent_score = ?5, summary = ?6, classified_at = ?7, updated_at = ?7
         WHERE shop = ?1 AND id = ?2`
      )
      .bind(this.shop, threadId, c.status, c.primaryCategory, c.intentScore, c.summary, c.classifiedAt)
      .run();
  }

  // --- W-INBOX-2: draft + outbound-message store methods ---

  async insertDraft(d: { threadId: string; bodyText: string; bodyHtml: string; confidence: number | null; quotesPriceOrder: boolean; commercialIntent?: boolean; holdReasons: string[]; model: string; status: DraftStatus }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(`INSERT INTO inbox_drafts (shop, id, thread_id, body_text, body_html, status, confidence, quotes_price_order, commercial_intent, hold_reasons, model, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
      .bind(this.shop, id, d.threadId, d.bodyText, d.bodyHtml, d.status, d.confidence, d.quotesPriceOrder ? 1 : 0, d.commercialIntent ? 1 : 0, JSON.stringify(d.holdReasons), d.model, new Date().toISOString())
      .run();
    return id;
  }

  getPendingDraft(threadId: string): Promise<DraftRow | null> {
    return this.db.prepare(`SELECT * FROM inbox_drafts WHERE shop = ?1 AND thread_id = ?2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`).bind(this.shop, threadId).first<DraftRow>();
  }

  getDraft(draftId: string): Promise<DraftRow | null> {
    return this.db.prepare(`SELECT * FROM inbox_drafts WHERE shop = ?1 AND id = ?2`).bind(this.shop, draftId).first<DraftRow>();
  }

  async setDraftStatus(draftId: string, status: DraftStatus, fields?: { sentMessageId?: string; sentAt?: string }): Promise<void> {
    await this.db
      .prepare(`UPDATE inbox_drafts SET status = ?3, sent_message_id = COALESCE(?4, sent_message_id), sent_at = COALESCE(?5, sent_at) WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, draftId, status, fields?.sentMessageId ?? null, fields?.sentAt ?? null)
      .run();
  }

  async supersedePendingDrafts(threadId: string): Promise<void> {
    await this.db.prepare(`UPDATE inbox_drafts SET status = 'superseded' WHERE shop = ?1 AND thread_id = ?2 AND status = 'pending'`).bind(this.shop, threadId).run();
  }

  /** Retire a thread's pending drafts when the merchant dismisses the thread
   *  (closed/spam/converted). An unapproved draft on a dismissed thread can never
   *  be acted on and would inflate the pending-draft badge forever. */
  async discardPendingDrafts(threadId: string): Promise<void> {
    await this.db.prepare(`UPDATE inbox_drafts SET status = 'discarded' WHERE shop = ?1 AND thread_id = ?2 AND status = 'pending'`).bind(this.shop, threadId).run();
  }

  async recentAutoSendCount(contactEmail: string, sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM inbox_messages WHERE shop = ?1 AND direction = 'outbound' AND to_addr = ?2 AND received_at >= ?3`)
      .bind(this.shop, contactEmail, sinceIso).first<{ n: number }>();
    return row?.n ?? 0;
  }

  async insertOutboundMessage(m: { threadId: string; messageId: string; from: string; to: string; subject: string | null; bodyText: string; bodyHtml: string; sentAt: string }): Promise<void> {
    await this.db
      .prepare(`INSERT INTO inbox_messages (shop, id, thread_id, direction, message_id, in_reply_to, ref_ids, from_addr, to_addr, subject, body_text, body_html, headers_json, received_at, created_at)
                VALUES (?1, ?2, ?3, 'outbound', ?4, NULL, NULL, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11)`)
      .bind(this.shop, crypto.randomUUID(), m.threadId, m.messageId, m.from, m.to, m.subject, m.bodyText, m.bodyHtml, m.sentAt, new Date().toISOString())
      .run();
    await this.touchThread(m.threadId, m.sentAt);
  }

  async reopenThread(threadId: string): Promise<void> {
    await this.db.prepare(`UPDATE inbox_threads SET status = 'needs_reply', updated_at = ?3 WHERE shop = ?1 AND id = ?2`).bind(this.shop, threadId, new Date().toISOString()).run();
  }

  async threadsNeedingDraft(limit = 15): Promise<ThreadRow[]> {
    const rs = await this.db
      .prepare(`SELECT t.* FROM inbox_threads t WHERE t.shop = ?1 AND t.status = 'needs_reply'
                AND NOT EXISTS (SELECT 1 FROM inbox_drafts d WHERE d.shop = t.shop AND d.thread_id = t.id AND d.status = 'pending')
                ORDER BY t.last_message_at ASC LIMIT ${Math.min(Math.max(limit, 1), 50)}`)
      .bind(this.shop).all<ThreadRow>();
    return rs.results ?? [];
  }

  // --- Console Glance (Phase 3): read-only aggregates. Every number the Glance
  // view shows comes from one of these real D1 facts - nothing is fabricated. ---

  /**
   * Audit landing list: contacts rolled up across their threads, latest
   * activity first. `category` scopes the roll-up to threads of that
   * classification (so the shown date is the latest matching activity);
   * `before` keyset-pages on the aggregate.
   */
  async auditContacts(opts: { category?: string; before?: string; limit?: number } = {}): Promise<AuditContactRow[]> {
    const lim = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const conds = ['t.shop = ?1'];
    const binds: unknown[] = [this.shop];
    if (opts.category) { binds.push(opts.category); conds.push(`t.primary_category = ?${binds.length}`); }
    let having = '';
    if (opts.before) { binds.push(opts.before); having = `HAVING MAX(m.received_at) < ?${binds.length}`; }
    const rs = await this.db.prepare(
      `SELECT t.contact_email AS email, c.name AS name,
              MAX(m.received_at) AS last_at, COUNT(m.id) AS n,
              GROUP_CONCAT(DISTINCT t.primary_category) AS categories
       FROM inbox_threads t
       JOIN inbox_messages m ON m.shop = t.shop AND m.thread_id = t.id
       LEFT JOIN inbox_contacts c ON c.shop = t.shop AND c.email = t.contact_email
       WHERE ${conds.join(' AND ')}
       GROUP BY t.contact_email ${having}
       ORDER BY last_at DESC LIMIT ${lim}`
    ).bind(...binds).all<AuditContactRow>();
    return rs.results ?? [];
  }

  /**
   * Audit conversation: EVERY message exchanged with one contact, across all
   * their threads, newest first - so a bait-opener chain reads as one story.
   * Outbound rows LEFT-join the draft that produced them via sent_message_id
   * (auto_sent = machine under the reply toggles, sent = owner-approved HITL,
   * no row = system mail such as an invoice).
   */
  async auditConversation(contactEmail: string, limit = 200): Promise<AuditMessageRow[]> {
    const lim = Math.min(Math.max(limit, 1), 500);
    const rs = await this.db.prepare(
      `SELECT m.id, m.thread_id, m.direction, m.from_addr, m.to_addr, m.subject,
              substr(m.body_text, 1, 8000) AS body_text, m.received_at,
              t.primary_category, d.status AS draft_status, d.model AS draft_model
       FROM inbox_messages m
       JOIN inbox_threads t ON t.shop = m.shop AND t.id = m.thread_id
       LEFT JOIN inbox_drafts d ON d.shop = m.shop AND m.direction = 'outbound' AND d.sent_message_id = m.message_id
       WHERE m.shop = ?1 AND t.contact_email = ?2
       ORDER BY m.received_at DESC LIMIT ${lim}`
    ).bind(this.shop, contactEmail).all<AuditMessageRow>();
    return rs.results ?? [];
  }

  async pendingDraftStats(): Promise<{ n: number; oldestAt: string | null }> {
    // Count only drafts the merchant can act on: the parent thread must still be
    // in the Open (unprocessed) set. Drafts on dismissed threads (closed/spam/
    // converted) or replied ones (awaiting_customer) are dead weight - counting
    // them made the rail badge read 11 while the Open list showed 3 (2026-07-04).
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n, MIN(d.created_at) AS oldest
                FROM inbox_drafts d
                JOIN inbox_threads t ON t.shop = d.shop AND t.id = d.thread_id
                WHERE d.shop = ?1 AND d.status = 'pending'
                  AND t.status NOT IN ('awaiting_customer', 'converted', 'closed', 'spam')`)
      .bind(this.shop).first<{ n: number; oldest: string | null }>();
    return { n: row?.n ?? 0, oldestAt: row?.oldest ?? null };
  }

  async countAutoSentSince(sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM inbox_drafts WHERE shop = ?1 AND status = 'auto_sent' AND sent_at >= ?2`)
      .bind(this.shop, sinceIso).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Thread ids that currently have a pending draft (for the "draft ready" list chip). */
  async pendingDraftThreadIds(): Promise<string[]> {
    const rs = await this.db
      .prepare(`SELECT DISTINCT thread_id FROM inbox_drafts WHERE shop = ?1 AND status = 'pending'`)
      .bind(this.shop).all<{ thread_id: string }>();
    return (rs.results ?? []).map((r) => r.thread_id);
  }

  /** Recently sent replies (manual approvals + auto-sends) with their recipient. */
  async recentSentDrafts(limit = 6): Promise<{ sent_at: string; status: string; contact_email: string }[]> {
    const rs = await this.db
      .prepare(
        `SELECT d.sent_at AS sent_at, d.status AS status, t.contact_email AS contact_email
         FROM inbox_drafts d JOIN inbox_threads t ON t.shop = d.shop AND t.id = d.thread_id
         WHERE d.shop = ?1 AND d.status IN ('sent', 'auto_sent') AND d.sent_at IS NOT NULL
         ORDER BY d.sent_at DESC LIMIT ${Math.min(Math.max(limit, 1), 20)}`
      )
      .bind(this.shop).all<{ sent_at: string; status: string; contact_email: string }>();
    return rs.results ?? [];
  }

  async recentInboundMessages(limit = 6): Promise<{ received_at: string; from_addr: string }[]> {
    const rs = await this.db
      .prepare(`SELECT received_at, from_addr FROM inbox_messages WHERE shop = ?1 AND direction = 'inbound' ORDER BY received_at DESC LIMIT ${Math.min(Math.max(limit, 1), 20)}`)
      .bind(this.shop).all<{ received_at: string; from_addr: string }>();
    return rs.results ?? [];
  }

  async countOrdersByStatus(): Promise<Record<string, number>> {
    const rs = await this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM orders WHERE shop = ?1 GROUP BY status`)
      .bind(this.shop).all<{ status: string; n: number }>();
    const out: Record<string, number> = {};
    for (const r of rs.results ?? []) out[r.status] = r.n;
    return out;
  }

  async countLinksByState(state: ProductLink['state']): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM product_links WHERE shop = ?1 AND state = ?2`)
      .bind(this.shop, state).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Low-band imported products WITH titles, most-at-risk first (the detail view of
   *  lowStockImportedCjPids - same join, same threshold semantics). */
  async lowStockImportedProducts(threshold: number, limit = 5): Promise<{ cj_pid: string; title: string; stock: number }[]> {
    const rs = await this.db
      .prepare(
        `SELECT l.cj_pid AS cj_pid, w.title AS title, w.stock AS stock
         FROM product_links l
         JOIN warehouse_products w ON w.shop = l.shop AND w.cj_pid = l.cj_pid
         WHERE l.shop = ?1 AND l.state = 'imported' AND l.stock_paused = 0 AND w.stock <= ?2
         ORDER BY w.stock ASC LIMIT ${Math.min(Math.max(limit, 1), 25)}`
      )
      .bind(this.shop, threshold)
      .all<{ cj_pid: string; title: string; stock: number }>();
    return rs.results ?? [];
  }

  /** Imported, Shopify-linked products with NO origins-bearing warehouse row. These have
   *  no origin signature, so they fall back to the merchant's MANUAL default shipping
   *  profile instead of the engineered per-origin profiles - the nightly backfill
   *  (backfillOriginSignatures) works this list off. */
  async importedCjPidsWithoutOrigins(limit = 25): Promise<{ cj_pid: string; category: string | null }[]> {
    const rs = await this.db
      .prepare(
        `SELECT l.cj_pid AS cj_pid, l.category AS category FROM product_links l
         WHERE l.shop = ?1 AND l.state = 'imported' AND l.shopify_product_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM warehouse_products w, json_each(COALESCE(json_extract(w.detail, '$.origins'), '{}')) je
             WHERE w.shop = l.shop AND w.cj_pid = l.cj_pid AND CAST(je.value AS INTEGER) > 0
           )
         ORDER BY l.created_at ASC LIMIT ${Math.min(Math.max(limit, 1), 100)}`
      )
      .bind(this.shop)
      .all<{ cj_pid: string; category: string | null }>();
    return rs.results ?? [];
  }

  /** Batched contact-name lookup (email -> name; unnamed contacts are omitted). */
  async contactNamesByEmails(emails: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!emails.length) return out;
    for (let i = 0; i < emails.length; i += 50) {
      const chunk = emails.slice(i, i + 50);
      const ph = chunk.map((_, j) => `?${j + 2}`).join(',');
      const rs = await this.db
        .prepare(`SELECT email, name FROM inbox_contacts WHERE shop = ?1 AND email IN (${ph}) AND name IS NOT NULL`)
        .bind(this.shop, ...chunk)
        .all<{ email: string; name: string }>();
      for (const r of rs.results ?? []) out.set(r.email, r.name);
    }
    return out;
  }

  // --- Affiliate inbound gating (Phase 1) ---
  getApplicantByThread(threadId: string): Promise<ApplicantRow | null> {
    return this.db.prepare(`SELECT * FROM affiliate_applicants WHERE shop = ?1 AND thread_id = ?2`)
      .bind(this.shop, threadId).first<ApplicantRow>();
  }

  async upsertApplicant(a: { threadId: string; contactEmail: string; stage: PartnershipStage; declaredIntent?: string | null }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO affiliate_applicants (shop, id, thread_id, contact_email, stage, declared_intent, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                ON CONFLICT(shop, thread_id) DO UPDATE SET
                  stage = ?5, declared_intent = COALESCE(?6, declared_intent), updated_at = ?7`)
      .bind(this.shop, crypto.randomUUID(), a.threadId, a.contactEmail, a.stage, a.declaredIntent ?? null, now)
      .run();
  }

  async setApplicantStage(threadId: string, stage: PartnershipStage, verdict: ScreenVerdict | null): Promise<void> {
    await this.db
      .prepare(`UPDATE affiliate_applicants SET stage = ?3, verdict_json = ?4, score = ?5, updated_at = ?6 WHERE shop = ?1 AND thread_id = ?2`)
      .bind(this.shop, threadId, stage, verdict ? JSON.stringify(verdict) : null, verdict?.score ?? null, new Date().toISOString())
      .run();
  }

  // --- Affiliate voucher trials (2026-07-04): partners, vouchers, order ledger ---

  /** Create (or reuse by email) the partner record. Re-registering an email
   *  attaches the new voucher to the SAME partner, refreshing any details given. */
  async upsertAffiliatePartner(p: { contactEmail: string; name?: string | null; channelUrl?: string | null; notes?: string | null }): Promise<string> {
    const email = p.contactEmail.trim().toLowerCase();
    const now = new Date().toISOString();
    const existing = await this.db
      .prepare(`SELECT id FROM affiliate_partners WHERE shop = ?1 AND contact_email = ?2 LIMIT 1`)
      .bind(this.shop, email).first<{ id: string }>();
    if (existing) {
      await this.db
        .prepare(`UPDATE affiliate_partners SET name = COALESCE(?3, name), channel_url = COALESCE(?4, channel_url),
                    notes = COALESCE(?5, notes), status = 'active', updated_at = ?6 WHERE shop = ?1 AND id = ?2`)
        .bind(this.shop, existing.id, p.name ?? null, p.channelUrl ?? null, p.notes ?? null, now)
        .run();
      return existing.id;
    }
    const id = crypto.randomUUID();
    await this.db
      .prepare(`INSERT INTO affiliate_partners (shop, id, contact_email, name, channel_url, status, notes, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?7)`)
      .bind(this.shop, id, email, p.name ?? null, p.channelUrl ?? null, p.notes ?? null, now)
      .run();
    return id;
  }

  /** Register an issued code. Codes are stored UPPERCASE; the unique index on
   *  (shop, code) makes a duplicate registration throw - callers surface it. */
  async createAffiliateVoucher(v: { partnerId: string; code: string; pctOff: number; commissionPct: number; startsAt?: string; endsAt: string; usageLimit?: number | null }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO affiliate_vouchers (shop, id, partner_id, code, pct_off, commission_pct, starts_at, ends_at, usage_limit, status, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'live', ?10, ?10)`)
      .bind(this.shop, id, v.partnerId, v.code.trim().toUpperCase(), v.pctOff, v.commissionPct, v.startsAt ?? now, v.endsAt, v.usageLimit ?? null, now)
      .run();
    return id;
  }

  /** Partners view list: one row per voucher (newest first) with its partner and
   *  ledger roll-up. Uses/gross/discount count ELIGIBLE (paid, uncancelled)
   *  orders; owed/paid split commission by the payout stamp. */
  async listAffiliateVouchers(): Promise<AffiliateVoucherListRow[]> {
    const rs = await this.db
      .prepare(
        `SELECT v.id AS voucher_id, v.code, v.pct_off, v.commission_pct, v.starts_at, v.ends_at, v.status, v.created_at,
                p.id AS partner_id, p.contact_email, p.name, p.channel_url, p.notes,
                COALESCE(o.uses, 0) AS uses, COALESCE(o.gross, 0) AS gross, COALESCE(o.discount, 0) AS discount,
                COALESCE(o.owed, 0) AS owed, COALESCE(o.paid, 0) AS paid, o.last_order_at
         FROM affiliate_vouchers v
         JOIN affiliate_partners p ON p.shop = v.shop AND p.id = v.partner_id
         LEFT JOIN (
           SELECT voucher_id,
                  SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS uses,
                  SUM(CASE WHEN eligible = 1 THEN gross_gbp ELSE 0 END) AS gross,
                  SUM(CASE WHEN eligible = 1 THEN discount_gbp ELSE 0 END) AS discount,
                  SUM(CASE WHEN paid_out_at IS NULL THEN commission_gbp ELSE 0 END) AS owed,
                  SUM(CASE WHEN paid_out_at IS NOT NULL THEN commission_gbp ELSE 0 END) AS paid,
                  MAX(placed_at) AS last_order_at
           FROM affiliate_orders WHERE shop = ?1 GROUP BY voucher_id
         ) o ON o.voucher_id = v.id
         WHERE v.shop = ?1
         ORDER BY v.created_at DESC`
      )
      .bind(this.shop)
      .all<AffiliateVoucherListRow>();
    return rs.results ?? [];
  }

  /** All registered vouchers (any status) for the attribution sweep's code map.
   *  Revoked/expired codes still record matches: if Shopify honoured the code,
   *  the discount was really given and the ledger reflects reality. */
  async attributionVouchers(): Promise<AttributionVoucherRow[]> {
    const rs = await this.db
      .prepare(`SELECT id, code, commission_pct, status, created_at FROM affiliate_vouchers WHERE shop = ?1`)
      .bind(this.shop)
      .all<AttributionVoucherRow>();
    return rs.results ?? [];
  }

  /** Upsert one attributed order. Re-upserts on later order updates (refunds,
   *  edits) refresh the money columns but NEVER touch paid_out_at, so payouts
   *  already made stay stamped. */
  async upsertAffiliateOrder(o: { shopifyOrderId: string; voucherId: string; orderName: string | null; grossGbp: number; discountGbp: number; commissionGbp: number; financialStatus: string | null; eligible: boolean; placedAt: string | null }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO affiliate_orders (shop, shopify_order_id, voucher_id, order_name, gross_gbp, discount_gbp, commission_gbp, financial_status, eligible, placed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
         ON CONFLICT(shop, shopify_order_id, voucher_id) DO UPDATE SET
           order_name = ?4, gross_gbp = ?5, discount_gbp = ?6, commission_gbp = ?7,
           financial_status = ?8, eligible = ?9, placed_at = ?10, updated_at = ?11`
      )
      .bind(this.shop, o.shopifyOrderId, o.voucherId, o.orderName, o.grossGbp, o.discountGbp, o.commissionGbp, o.financialStatus, o.eligible ? 1 : 0, o.placedAt, now)
      .run();
  }

  /** Ledger drill-down for one voucher, newest order first. */
  async affiliateOrdersForVoucher(voucherId: string, limit = 100): Promise<AffiliateOrderRow[]> {
    const rs = await this.db
      .prepare(
        `SELECT shopify_order_id, order_name, gross_gbp, discount_gbp, commission_gbp, financial_status, eligible, placed_at, paid_out_at
         FROM affiliate_orders WHERE shop = ?1 AND voucher_id = ?2
         ORDER BY placed_at DESC LIMIT ?3`
      )
      .bind(this.shop, voucherId, limit)
      .all<AffiliateOrderRow>();
    return rs.results ?? [];
  }

  /** Stamp every eligible unpaid commission row for the voucher as paid out.
   *  Returns how many orders the payout covered. */
  async markVoucherCommissionPaid(voucherId: string): Promise<number> {
    const r = await this.db
      .prepare(
        `UPDATE affiliate_orders SET paid_out_at = ?3
         WHERE shop = ?1 AND voucher_id = ?2 AND paid_out_at IS NULL AND eligible = 1 AND commission_gbp > 0`
      )
      .bind(this.shop, voucherId, new Date().toISOString())
      .run();
    return r.meta.changes ?? 0;
  }

  async setAffiliateVoucherStatus(voucherId: string, status: 'live' | 'revoked'): Promise<void> {
    await this.db
      .prepare(`UPDATE affiliate_vouchers SET status = ?3, updated_at = ?4 WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, voucherId, status, new Date().toISOString())
      .run();
  }

  // --- W-INBOX-3: invoices ---
  async insertInvoice(i: { threadId: string; lineItems: InvoiceLineItem[]; total: number; currency: string; coverText: string; confidence: number | null; holdReasons: string[]; status: InvoiceStatus }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(`INSERT INTO inbox_invoices (shop, id, thread_id, status, line_items_json, currency, total, cover_text, confidence, hold_reasons, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
      .bind(this.shop, id, i.threadId, i.status, JSON.stringify(i.lineItems), i.currency, i.total, i.coverText, i.confidence, JSON.stringify(i.holdReasons), new Date().toISOString())
      .run();
    return id;
  }
  getInvoice(id: string): Promise<InvoiceRow | null> {
    return this.db.prepare(`SELECT * FROM inbox_invoices WHERE shop = ?1 AND id = ?2`).bind(this.shop, id).first<InvoiceRow>();
  }
  getInvoiceByPawscoutId(id: string): Promise<InvoiceRow | null> { return this.getInvoice(id); }
  getOpenInvoiceForThread(threadId: string): Promise<InvoiceRow | null> {
    return this.db.prepare(`SELECT * FROM inbox_invoices WHERE shop = ?1 AND thread_id = ?2 AND status = 'sent' ORDER BY created_at DESC LIMIT 1`).bind(this.shop, threadId).first<InvoiceRow>();
  }
  /** Returns true if any invoice for this thread is active (proposed or sent).
   * Used by proposeInvoiceOne to avoid re-proposing in HITL mode every sweep. */
  async hasActiveInvoice(threadId: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 FROM inbox_invoices WHERE shop = ?1 AND thread_id = ?2 AND status IN ('proposed','sent') LIMIT 1`).bind(this.shop, threadId).first<{ 1: number }>();
    return row !== null;
  }
  getInvoiceByOrderId(shopifyOrderId: string): Promise<InvoiceRow | null> {
    return this.db.prepare(`SELECT * FROM inbox_invoices WHERE shop = ?1 AND shopify_order_id = ?2 LIMIT 1`).bind(this.shop, shopifyOrderId).first<InvoiceRow>();
  }
  async setInvoiceStatus(id: string, status: InvoiceStatus, fields?: { sentAt?: string; paidAt?: string; shopifyOrderId?: string; draftOrderId?: string; invoiceUrl?: string }): Promise<void> {
    await this.db
      .prepare(`UPDATE inbox_invoices SET status = ?3,
                  sent_at = COALESCE(?4, sent_at), paid_at = COALESCE(?5, paid_at),
                  shopify_order_id = COALESCE(?6, shopify_order_id),
                  shopify_draft_order_id = COALESCE(?7, shopify_draft_order_id),
                  invoice_url = COALESCE(?8, invoice_url)
                WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, id, status, fields?.sentAt ?? null, fields?.paidAt ?? null, fields?.shopifyOrderId ?? null, fields?.draftOrderId ?? null, fields?.invoiceUrl ?? null)
      .run();
  }
  async recentInvoiceCount(threadId: string, sinceIso: string): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM inbox_invoices WHERE shop = ?1 AND thread_id = ?2 AND created_at >= ?3 AND status IN ('sent','paid')`).bind(this.shop, threadId, sinceIso).first<{ n: number }>();
    return row?.n ?? 0;
  }
  /** True if a 'failed' invoice for this thread was created at/after sinceIso. Backoff
   * signal: a thread whose invoice keeps failing must NOT be re-proposed (a fresh LLM
   * call + draft attempt) every sweep - hasActiveInvoice only covers proposed|sent. */
  async hasRecentFailedInvoice(threadId: string, sinceIso: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 FROM inbox_invoices WHERE shop = ?1 AND thread_id = ?2 AND status = 'failed' AND created_at >= ?3 LIMIT 1`).bind(this.shop, threadId, sinceIso).first<{ 1: number }>();
    return row !== null;
  }
  getOpenInvoiceForContact(email: string): Promise<InvoiceRow | null> {
    return this.db.prepare(`SELECT inv.* FROM inbox_invoices inv JOIN inbox_threads t ON t.shop = inv.shop AND t.id = inv.thread_id WHERE inv.shop = ?1 AND t.contact_email = ?2 AND inv.status = 'sent' ORDER BY inv.created_at DESC LIMIT 1`).bind(this.shop, email).first<InvoiceRow>();
  }

  // --- Retention reorder reminders (affiliate 1.3) ---
  /** True if we've already reminded against this order (dedup). */
  async hasReorderReminder(orderId: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 FROM reorder_reminders WHERE shop = ?1 AND order_id = ?2 LIMIT 1`).bind(this.shop, orderId).first();
    return row !== null;
  }
  async recordReorderReminder(orderId: string, email: string, sentAt: string): Promise<void> {
    await this.db.prepare(`INSERT OR IGNORE INTO reorder_reminders (shop, order_id, email, sent_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(this.shop, orderId, email.toLowerCase(), sentAt).run();
  }
  /** True if this email has opted out of reminder mail (PECR/GDPR suppression). */
  async isEmailUnsubscribed(email: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 FROM email_unsubscribes WHERE shop = ?1 AND email = ?2 LIMIT 1`).bind(this.shop, email.toLowerCase()).first();
    return row !== null;
  }
  async recordUnsubscribe(email: string, at: string): Promise<void> {
    await this.db.prepare(`INSERT OR IGNORE INTO email_unsubscribes (shop, email, unsubscribed_at) VALUES (?1, ?2, ?3)`)
      .bind(this.shop, email.toLowerCase(), at).run();
  }
}

// --- cross-tenant maintenance (cron jobs) - keep all raw D1 in this file ---

export async function listActiveShops(db: D1Database): Promise<string[]> {
  const rs = await db.prepare(`SELECT shop FROM tenants WHERE status = 'active' AND access_token_enc != ''`).all<{ shop: string }>();
  return (rs.results ?? []).map((r) => r.shop);
}

/** Enforce the 30-day retention promise on cached supplier data. */
export async function purgeExpiredSearchCache(db: D1Database): Promise<number> {
  const r = await db.prepare(`DELETE FROM search_cache WHERE expires_at <= ?1`).bind(new Date().toISOString()).run();
  return r.meta.changes ?? 0;
}

/** Trim event + demand logs we no longer need (keeps D1 small; nothing here is PII). */
export async function trimOldLogs(db: D1Database, beforeIso: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM product_events WHERE created_at < ?1`).bind(beforeIso),
    db.prepare(`DELETE FROM search_log WHERE created_at < ?1`).bind(beforeIso),
    db.prepare(`DELETE FROM llm_usage WHERE created_at < ?1`).bind(beforeIso)
  ]);
}

/** Retention: drop warehouse rows that went unrefreshed past the cutoff and never got imported. */
export async function purgeUnusedWarehouse(db: D1Database, beforeIso: string): Promise<number> {
  const r = await db
    .prepare(
      `DELETE FROM warehouse_products WHERE fetched_at < ?1 AND NOT EXISTS (
         SELECT 1 FROM product_links pl
         WHERE pl.shop = warehouse_products.shop AND pl.cj_pid = warehouse_products.cj_pid AND pl.state = 'imported'
       )`
    )
    .bind(beforeIso)
    .run();
  return r.meta.changes ?? 0;
}
