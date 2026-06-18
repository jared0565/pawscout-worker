import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, type TenantRow, type TenantConfig, type Fulfil } from './types';
import { DEFAULT_INBOX, type InboxConfig } from './inbox/types';
import type { ContactRow, ThreadRow, MessageRow, ThreadStatus } from './inbox/types';

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
  state: 'ghost' | 'importing' | 'imported' | 'archived' | 'failed';
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
    // addons/fulfil/inbox are intentionally NOT written here — they ride the '{}' column default +
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
      .prepare(`SELECT collection_map, gates, pricing, floors, llm, addons, fulfil, inbox, target FROM tenant_config WHERE shop = ?1`)
      .bind(this.shop)
      .first<{ collection_map: string; gates: string; pricing: string; floors: string; llm: string; addons: string; fulfil: string; inbox: string; target: number }>();
    if (!row) return null;
    return {
      collectionMap: JSON.parse(row.collection_map),
      gates: JSON.parse(row.gates),
      // Tolerate pre-flywheel rows ('{}' default): fill missing fields from defaults.
      pricing: { ...DEFAULT_PRICING, ...JSON.parse(row.pricing || '{}') },
      floors: { ...DEFAULT_FLOORS, ...JSON.parse(row.floors || '{}') },
      llm: { ...DEFAULT_LLM, ...JSON.parse(row.llm || '{}') },
      addons: { ...DEFAULT_ADDONS, ...JSON.parse(row.addons || '{}') },
      fulfil: { ...DEFAULT_FULFIL, ...JSON.parse(row.fulfil || '{}') },
      inbox: { ...DEFAULT_INBOX, ...JSON.parse(row.inbox || '{}') },
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

  /** shop/redact: purge ALL data for this shop (sent ~48h after uninstall). */
  async redactShop(): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM orders WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM product_events WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM product_links WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM warehouse_products WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM search_cache WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM search_log WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM llm_usage WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM supplier_credentials WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM cj_tokens WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM inbox_thread_labels WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM inbox_messages WHERE shop = ?1`).bind(this.shop),
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

  // --- orders (W-FULFIL) ---

  /**
   * Idempotent insert — returns false if this Shopify order was already received
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

  async listOrders(status: string | null, limit = 100): Promise<OrderRow[]> {
    const lim = Math.min(Math.max(limit, 1), 200);
    const rs = status
      ? await this.db.prepare(`SELECT * FROM orders WHERE shop = ?1 AND status = ?2 ORDER BY created_at DESC LIMIT ${lim}`).bind(this.shop, status).all<OrderRow>()
      : await this.db.prepare(`SELECT * FROM orders WHERE shop = ?1 ORDER BY created_at DESC LIMIT ${lim}`).bind(this.shop).all<OrderRow>();
    return rs.results ?? [];
  }

  /** Queued orders whose grace window has elapsed — ready for Stage-B auto-submit. */
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
   * since the window cutoff. Stock-paused products are exempt — they couldn't
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

  /** Available warehouse rows for a category, best (most-listed) first — promotion candidates. */
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

  /** All warehouse titles (any status) — for dedupe-at-admission signatures. */
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

  async createThread(t: { contactEmail: string; subject: string; subjectNorm: string; receivedAt: string; initialStatus: ThreadStatus }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO inbox_threads (shop, id, contact_email, subject, subject_norm, status, last_message_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
      )
      .bind(this.shop, id, t.contactEmail, t.subject, t.subjectNorm, t.initialStatus, t.receivedAt, now)
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
    const rs = status
      ? await this.db.prepare(`SELECT * FROM inbox_threads WHERE shop = ?1 AND status = ?2 ORDER BY last_message_at DESC LIMIT ${lim}`).bind(this.shop, status).all<ThreadRow>()
      : await this.db.prepare(`SELECT * FROM inbox_threads WHERE shop = ?1 ORDER BY last_message_at DESC LIMIT ${lim}`).bind(this.shop).all<ThreadRow>();
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

  async setThreadClassification(threadId: string, c: { status: ThreadStatus; primaryCategory: string | null; intentScore: number | null; summary: string | null; classifiedAt: string }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE inbox_threads SET status = ?3, primary_category = ?4, intent_score = ?5, summary = ?6, classified_at = ?7, updated_at = ?7
         WHERE shop = ?1 AND id = ?2`
      )
      .bind(this.shop, threadId, c.status, c.primaryCategory, c.intentScore, c.summary, c.classifiedAt)
      .run();
  }
}

// --- cross-tenant maintenance (cron jobs) — keep all raw D1 in this file ---

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
