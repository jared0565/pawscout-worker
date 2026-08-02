import { DEFAULT_PRICING, DEFAULT_FLOORS, DEFAULT_LLM, DEFAULT_ADDONS, DEFAULT_FULFIL, DEFAULT_SEMANTIC, DEFAULT_PROFIT, DEFAULT_SELF_SERVE, COMMISSION_CLEARANCE_DAYS, mergeSyndicate, type TenantRow, type TenantConfig, type Fulfil, type ProfitConfig, type SyndicateConfig, type SelfServeConfig } from './types';
import type { LogisticsRoute } from './logistics';
import { deriveModels } from './llm-migrate';
import { DEFAULT_INBOX, type InboxConfig } from './inbox/types';
import type { ContactRow, ThreadRow, MessageRow, ThreadStatus, DraftRow, DraftStatus, InvoiceRow, InvoiceLineItem, InvoiceStatus, ApplicantRow, PartnershipStage, ScreenVerdict } from './inbox/types';

/** ISO cutoff for the commission clearance hold: an order whose age basis
 *  (placed_at, or its insert timestamp created_at when placed_at is missing, so
 *  a null placed_at can never strand commission) is <= this instant has cleared
 *  the return window and its commission is releasable. Computed server-side from
 *  an injectable now so it can never be shifted by a stale client, and so the
 *  three readers (payout, console owed, portal) all gate on the SAME boundary. */
function clearanceCutoffIso(nowMs: number): string {
  return new Date(nowMs - COMMISSION_CLEARANCE_DAYS * 86_400_000).toISOString();
}

/** The Open (unprocessed) status set - ONE definition shared by the Inbox
 * default list, the open-queue count behind the rail badge, and the
 * pending-draft KPI, so they can never drift apart (owner invariant
 * 2026-07-05: the badge always equals what opening the Inbox shows). */
const OPEN_THREAD_STATUSES_SQL = `NOT IN ('awaiting_customer', 'converted', 'closed', 'spam')`;

/** llm_usage.task tag for affiliate self-serve screening calls - shared here so
 *  the (future) screening task and sumScreenSpendTodayGbp never drift apart.
 *  Value matches docs/superpowers/specs/2026-07-12-affiliate-self-serve-marketplace-design.md
 *  ("Usage logged as `affiliate-screen`"). */
export const AFFILIATE_SCREEN_LLM_TASK = 'affiliate-screen';

/** affiliate_applications.stage vocabulary (design spec: submitted | verified |
 *  judging | approved_pending_issue | approved | deflected | declined |
 *  owner_queue). Exported in full so every stage-writing/reading task (Stage 0
 *  apply route, Stage 1 verify, the screen lane, the console) shares the exact
 *  literal strings and can never drift apart on a typo. */
export const AFFILIATE_STAGE_SUBMITTED = 'submitted';
export const AFFILIATE_STAGE_VERIFIED = 'verified';
export const AFFILIATE_STAGE_JUDGING = 'judging';
export const AFFILIATE_STAGE_APPROVED_PENDING_ISSUE = 'approved_pending_issue';
/** "voucher successfully issued" - the terminal state after approved_pending_issue. */
export const AFFILIATE_STAGE_APPROVED = 'approved';
export const AFFILIATE_STAGE_DEFLECTED = 'deflected';
export const AFFILIATE_STAGE_DECLINED = 'declined';
/** Routed for mandatory human review; the auto-funnel must never advance an
 *  application past this stage on its own (former-partner gate, over-cap). */
export const AFFILIATE_STAGE_OWNER_QUEUE = 'owner_queue';

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
  profit_keep: number;  // 1 = owner Keep override: the profit agent must not act on this product
  // Which admission gate kept this product out. Set only with state 'failed',
  // and null on every other state. Null on a failed row means the row predates
  // migration 0037, not that the cause is a mystery worth investigating.
  fail_reason: string | null;
  // HOW FAR it missed that gate, in the gate's own units ("score 58 < 60",
  // "best sub-market net ~GBP 4.80"). Null on rows predating migration 0038 and
  // on gates that have no meaningful magnitude. Never parsed for control flow -
  // it is evidence for a human decision, not a machine-readable field.
  fail_detail: string | null;
  created_at: string;
  updated_at: string;
}

/** One internal surface that points at a product handle. DERIVED - rebuilt from
 *  article bodies and the related_products metafield.
 *
 *  `referrer_id` is the ARTICLE GID, not its handle. A handle can be renamed,
 *  and clearProductReferrers is scoped to one id, so handle-keyed rows would be
 *  orphaned by a rename and would block that product from archiving forever.
 *
 *  Only `blog` referrers exist today, and they are repairable (the article can
 *  be rewritten). Surfaces that were expected to need their own type turned out
 *  not to: syndicated posts link ARTICLES, never products (utmUrl,
 *  src/syndicate/channels.ts:16), and the "Shop this guide" picks ARE the
 *  related_products metafield the blog slice already reads. See the Task 11
 *  falsification note in docs/superpowers/plans/2026-07-31-profitability-repositioning.md. */
export interface ProductReferrer {
  shop: string;
  handle: string;
  referrer_type: string;
  referrer_id: string;
  detected_at: string;
}

/** What the last index rebuild actually managed to read. The guard refuses to
 *  archive anything unless this is present, complete and recent - an empty
 *  referrer lookup against a half-built index is indistinguishable from
 *  "genuinely unreferenced". See migrations/0036_referrer_index_stamp.sql. */
export interface ReferrerIndexStamp {
  indexedAt: string;
  articleCount: number;
  rowCount: number;
  truncated: boolean;
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

export interface ProfitVerdictRow {
  cj_pid: string;
  verdict: string; // pass | review | reject
  net_gbp: number | null;
  net_pct: number | null;
  our_retail_gbp: number | null;
  competitor_gbp: number | null;
  competitor_confidence: string | null;
  competitor_sources: string | null; // JSON array
  reason: string;
  checked_at: string;
  // Latest action the active agent took/would-take on this product (nullable
  // until the runner acts; observe-only rows leave these unset).
  action?: string | null;             // reprice | drop | flag | keep
  from_gbp?: number | null;           // from-price of the latest reprice
  to_gbp?: number | null;             // target of the latest reprice
  acted_at?: string | null;
  dry_run?: number | null;            // 1 = previewed only, 0 = executed live
  // Joined from product_links (listProfitVerdicts only): the current product so
  // the console can link to it and skip already-archived rows.
  handle?: string | null;
  shopify_product_id?: string | null;
  link_state?: string | null;
  profit_keep?: number | null; // owner Keep override (1 = the agent must not act)
  // Joined from warehouse_products.detail (listProfitVerdicts only): the CJ
  // product name + variant SKU + CJ item price (USD) so the console table can
  // show a readable short name, the SKU, and the supplier price for review.
  sku?: string | null;
  name?: string | null;
  cj_price_usd?: number | null;
}

/** One row of the append-only profit_actions ledger (newest first via listProfitActions). */
export interface ProfitActionRow {
  id: number;
  cj_pid: string;
  action: string;                     // reprice | drop | flag | keep
  from_gbp: number | null;
  to_gbp: number | null;
  competitor_gbp: number | null;
  competitor_confidence: string | null;
  reason: string;
  dry_run: number;                    // 1 = previewed only, 0 = executed live
  created_at: string;
}

/** One self-serve affiliate signup, from submit through screen to auto-issue
 *  or decline. DISTINCT from ApplicantRow (affiliate_applicants, the
 *  thread-keyed inbox partnership lane) - see migrations/0032_affiliate_selfserve.sql. */
export interface AffiliateApplicationRow {
  shop: string;
  id: string;
  email: string;
  name: string | null;
  channel_url: string | null;
  answers_json: string | null;
  stage: string;
  score: number | null;
  facts_json: string | null;
  flags_json: string | null;
  ip_hash: string | null;
  created_at: string;
  updated_at: string;
}

/** One vetted Q-A pair of the inbox answer memory (approved-answers grounding). */
export interface AnswerMemoryRow {
  qhash: string;         // FNV-1a 64-bit hex of category + '|' + question_norm
  category: string;
  question_text: string;
  question_norm: string; // canonical token string used for matching
  answer_text: string;   // final SENT substance (salutation/footer stripped)
  thread_id: string;
  disabled: number;      // 1 = owner pulled this pair out of recall
  used_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
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
  marketing_consent: number;
  // owed = ALL unpaid eligible commission (total). owed_cleared = the payable
  // portion (past the clearance hold); owed_maturing = still in the hold window.
  // owed === owed_cleared + owed_maturing. The owner pays owed_cleared.
  uses: number; gross: number; discount: number; owed: number; owed_cleared: number; owed_maturing: number; paid: number;
  last_order_at: string | null;
}

/** One marketing broadcast (Campaigns view). body_text is the owner's plain
 * text; HTML + compliance footer are rendered at send time. */
export interface CampaignRow {
  shop: string; id: string; audience: string; subject: string; body_text: string;
  status: string; recipient_count: number | null; sent_count: number;
  created_at: string; updated_at: string; sent_at: string | null;
}

/** One acquisition channel on the Traffic strategy board. */
export interface TrafficChannelRow {
  shop: string; id: string; name: string; status: string; priority: number;
  rationale: string; next_action: string; notes: string;
  created_at: string; updated_at: string;
}

/** One attributed order of a voucher's ledger drill-down. */
export interface AffiliateOrderRow {
  shopify_order_id: string; order_name: string | null;
  gross_gbp: number; discount_gbp: number; commission_gbp: number;
  financial_status: string | null; eligible: number;
  placed_at: string | null; paid_out_at: string | null; payout_id: string | null;
  buyer_email_hash: string | null; self_referral: number;
}

/** Voucher fields the attribution sweep needs for code matching, plus the
 *  partner's contact_email (joined in) so the self-referral guard has
 *  something to compare the buyer against. partner_email is nullable - the
 *  join is a LEFT JOIN on purpose (see attributionVouchers) so a voucher
 *  whose partner row is ever missing still attributes orders exactly as
 *  before; the guard just has nothing to compare and degrades to "no
 *  determination" instead of dropping the voucher from the sweep. */
export interface AttributionVoucherRow {
  id: string; code: string; commission_pct: number; status: string; created_at: string;
  partner_email: string | null;
}

/** One voucher line of the self-serve partner portal (Task 5) - code + status
 *  + validity window only, never the underlying partner/order rows. */
export interface PartnerPortalVoucher {
  code: string; status: string; starts_at: string; ends_at: string;
}

/** The partner portal's ENTIRE payload (`partnerPortalSummary`): counts and
 *  amounts only, aggregated across every voucher this partner has ever held.
 *  Deliberately has NO per-order fields (no shopify_order_id/order_name/
 *  buyer_email_hash) - that is the whole point of this being an aggregate
 *  query rather than a reuse of affiliateOrdersForVoucher, which returns
 *  buyer-linkable rows and must never be reachable from this unauthenticated-
 *  by-anything-but-the-portal-session surface. */
export interface PartnerPortalSummary {
  partner_id: string;
  vouchers: PartnerPortalVoucher[];
  orders_count: number;
  gross_gbp: number;
  commission_gbp: number;
  paid_gbp: number;
  // pending_gbp = ALL unpaid eligible commission (total, unchanged meaning).
  // available_gbp = the cleared, payable portion; maturing_gbp = still in the
  // clearance hold. pending_gbp === available_gbp + maturing_gbp.
  pending_gbp: number;
  available_gbp: number;
  maturing_gbp: number;
  last_order_at: string | null;
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
      .prepare(`SELECT collection_map, gates, pricing, floors, llm, addons, fulfil, inbox, semantic, target, profit, syndicate, selfserve FROM tenant_config WHERE shop = ?1`)
      .bind(this.shop)
      .first<{ collection_map: string; gates: string; pricing: string; floors: string; llm: string; addons: string; fulfil: string; inbox: string; semantic: string; target: number; profit: string; syndicate: string; selfserve: string | null }>();
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
      profit: { ...DEFAULT_PROFIT, ...JSON.parse(row.profit || '{}') },
      syndicate: mergeSyndicate(row.syndicate),
      selfServe: { ...DEFAULT_SELF_SERVE, ...JSON.parse(row.selfserve || '{}') },
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

  /** Persist the profitability config block (the enabled/hardBlock flips live here). */
  async saveProfit(profit: ProfitConfig): Promise<void> {
    await this.db
      .prepare(`UPDATE tenant_config SET profit = ?2, updated_at = ?3 WHERE shop = ?1`)
      .bind(this.shop, JSON.stringify(profit), new Date().toISOString())
      .run();
  }

  /** Persist the blog syndication config block (channel toggles + digest mode). */
  async saveSyndicate(syn: SyndicateConfig): Promise<void> {
    await this.db
      .prepare(`UPDATE tenant_config SET syndicate = ?2, updated_at = ?3 WHERE shop = ?1`)
      .bind(this.shop, JSON.stringify(syn), new Date().toISOString())
      .run();
  }

  /** Persist the affiliate self-serve marketplace config block (Task 6: the
   *  missing DB wiring flagged by Task 1 - without this, selfServe.enabled
   *  could never actually be flipped on from the console). */
  async saveSelfServe(sc: SelfServeConfig): Promise<void> {
    await this.db
      .prepare(`UPDATE tenant_config SET selfserve = ?2, updated_at = ?3 WHERE shop = ?1`)
      .bind(this.shop, JSON.stringify(sc), new Date().toISOString())
      .run();
  }

  /** Upsert a product's profitability state (the active agent's per-product output).
   *  Action fields are optional so the observe path (verdict only) still works; the
   *  runner always passes them so the console can render the latest action inline. */
  async upsertProfitVerdict(rec: {
    cjPid: string; verdict: string; netGbp: number | null; netPct: number | null; ourRetailGbp: number | null;
    competitorGbp: number | null; competitorConfidence: string | null; competitorSources: string[] | null; reason: string;
    action?: string | null; fromGbp?: number | null; toGbp?: number | null; dryRun?: boolean | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const actedAt = rec.action ? now : null;
    const dry = rec.dryRun === undefined || rec.dryRun === null ? null : (rec.dryRun ? 1 : 0);
    await this.db
      .prepare(
        `INSERT INTO product_profit (shop, cj_pid, verdict, net_gbp, net_pct, our_retail_gbp, competitor_gbp, competitor_confidence, competitor_sources, reason, checked_at, action, from_gbp, to_gbp, acted_at, dry_run)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(shop, cj_pid) DO UPDATE SET verdict = ?3, net_gbp = ?4, net_pct = ?5, our_retail_gbp = ?6, competitor_gbp = ?7, competitor_confidence = ?8, competitor_sources = ?9, reason = ?10, checked_at = ?11, action = ?12, from_gbp = ?13, to_gbp = ?14, acted_at = ?15, dry_run = ?16`
      )
      .bind(
        this.shop, rec.cjPid, rec.verdict, rec.netGbp, rec.netPct, rec.ourRetailGbp, rec.competitorGbp, rec.competitorConfidence,
        rec.competitorSources ? JSON.stringify(rec.competitorSources) : null, rec.reason, now,
        rec.action ?? null, rec.fromGbp ?? null, rec.toGbp ?? null, actedAt, dry
      )
      .run();
  }

  /** Append one immutable row to the profit_actions ledger (every reprice/drop the
   *  agent takes or, in dry-run, WOULD take). This is the only surviving record of
   *  a drop once the product is archived off the verdict list. */
  async logProfitAction(rec: {
    cjPid: string; action: string; fromGbp: number | null; toGbp: number | null;
    competitorGbp: number | null; competitorConfidence: string | null; reason: string; dryRun: boolean;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO profit_actions (shop, cj_pid, action, from_gbp, to_gbp, competitor_gbp, competitor_confidence, reason, dry_run, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      )
      .bind(
        this.shop, rec.cjPid, rec.action, rec.fromGbp, rec.toGbp, rec.competitorGbp,
        rec.competitorConfidence, rec.reason, rec.dryRun ? 1 : 0, new Date().toISOString()
      )
      .run();
  }

  /** The action ledger newest-first (console "recent actions" surface). */
  async listProfitActions(limit = 100): Promise<ProfitActionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, cj_pid, action, from_gbp, to_gbp, competitor_gbp, competitor_confidence, reason, dry_run, created_at
         FROM profit_actions WHERE shop = ?1 ORDER BY id DESC LIMIT ?2`
      )
      .bind(this.shop, limit)
      .all<ProfitActionRow>();
    return results ?? [];
  }

  /** Verdicts worst-first (reject, then review, then pass), then lowest net.
   *  Joins the current product_link for the handle/link, and EXCLUDES already
   *  archived products so the console list shrinks as the owner archives (an
   *  archived product's verdict row is kept for history, just hidden here). */
  async listProfitVerdicts(limit = 500): Promise<ProfitVerdictRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT pp.cj_pid, pp.verdict, pp.net_gbp, pp.net_pct, pp.our_retail_gbp, pp.competitor_gbp, pp.competitor_confidence, pp.competitor_sources, pp.reason, pp.checked_at,
                pp.action AS action, pp.from_gbp AS from_gbp, pp.to_gbp AS to_gbp, pp.acted_at AS acted_at, pp.dry_run AS dry_run,
                pl.handle AS handle, pl.shopify_product_id AS shopify_product_id, pl.state AS link_state, pl.profit_keep AS profit_keep,
                json_extract(wp.detail, '$.variants[0].sku') AS sku,
                json_extract(wp.detail, '$.nameEn') AS name,
                json_extract(wp.detail, '$.variants[0].sellPriceUsd') AS cj_price_usd
         FROM product_profit pp
         LEFT JOIN product_links pl ON pl.shop = pp.shop AND pl.cj_pid = pp.cj_pid
         LEFT JOIN warehouse_products wp ON wp.shop = pp.shop AND wp.cj_pid = pp.cj_pid
         WHERE pp.shop = ?1 AND (pl.state IS NULL OR pl.state NOT IN ('archived', 'failed'))
         ORDER BY CASE pp.verdict WHEN 'reject' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, pp.net_gbp ASC LIMIT ?2`
      )
      .bind(this.shop, limit)
      .all<ProfitVerdictRow>();
    return results ?? [];
  }

  /** Wipe ALL standing profitability decisions for this shop (the console's
   *  Products list). The action LEDGER (profit_actions) is deliberately kept -
   *  history is history - and nothing is archived or repriced by clearing: the
   *  15-min agent re-decides every product on live numbers and repopulates the
   *  list over its next cycles. Returns the number of rows removed. */
  async clearProfitVerdicts(): Promise<number> {
    const r = await this.db.prepare(`DELETE FROM product_profit WHERE shop = ?1`).bind(this.shop).run();
    return r.meta.changes ?? 0;
  }

  /** Drop every cached competitor signal (comp:<pid>) so the next judgment of
   *  each product re-researches the market FRESH (current prompt, current
   *  listings) instead of reusing a stale estimate - what makes "clear &
   *  re-judge" meaningful. Other cache keys (pid:, hero:, ...) are untouched. */
  async clearCompetitorCache(): Promise<number> {
    const r = await this.db.prepare(`DELETE FROM search_cache WHERE shop = ?1 AND cache_key LIKE 'comp:%'`).bind(this.shop).run();
    await this.clearUnknownSellerCountries();
    return r.meta.changes ?? 0;
  }

  /** clearCompetitorCache, but the owner's Wrong-match markers survive (their
   *  payload carries the 'owner:' source sentinel written by rejectProfitMatch).
   *  Used by the recalibration sweep: every product re-references the market
   *  under the CURRENT judging rules without forgetting the owner's calls. */
  async clearCompetitorCacheExceptOwner(): Promise<number> {
    const r = await this.db
      .prepare(`DELETE FROM search_cache WHERE shop = ?1 AND cache_key LIKE 'comp:%' AND payload NOT LIKE '%"owner:%'`)
      .bind(this.shop)
      .run();
    await this.clearUnknownSellerCountries();
    return r.meta.changes ?? 0;
  }

  /** Re-referencing under current rules must also retry UNKNOWN seller-country
   *  lookups (ebayseller:<id> = '?'): an unknown may be a transient read
   *  failure, and a cached '?' suppresses the lookup for its whole 30d TTL.
   *  Positively-resolved countries are facts and keep their TTL. */
  private async clearUnknownSellerCountries(): Promise<number> {
    const r = await this.db
      .prepare(`DELETE FROM search_cache WHERE shop = ?1 AND cache_key LIKE 'ebayseller:%' AND payload = '?'`)
      .bind(this.shop)
      .run();
    return r.meta.changes ?? 0;
  }

  /** Distinct products the agent dropped FOR REAL (dry_run = 0) whose link is
   *  still archived - the candidate list for a recalibration rescue. Owner
   *  console archives are deliberately absent (they never log a profit action):
   *  the owner's explicit call is not the agent's to reverse. */
  async listArchivedDroppedPids(): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT pa.cj_pid FROM profit_actions pa
         JOIN product_links pl ON pl.shop = pa.shop AND pl.cj_pid = pa.cj_pid
         WHERE pa.shop = ?1 AND pa.action = 'drop' AND pa.dry_run = 0
           AND pl.state = 'archived' AND pl.shopify_product_id IS NOT NULL
         ORDER BY pa.cj_pid`
      )
      .bind(this.shop)
      .all<{ cj_pid: string }>();
    return (results ?? []).map((r) => r.cj_pid);
  }

  /** Catalog-wide qualifying-engagement count in a window - the cull's signal
   *  gate: "zero events for this product" only means anything when the STORE
   *  had events to give. */
  async countProductEventsSince(sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM product_events WHERE shop = ?1 AND created_at >= ?2`)
      .bind(this.shop, sinceIso)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * Every archived product that still has a handle, oldest first.
   *
   * These are the 404s: 112 of them measured 2026-07-31, all with handles.
   * Unlike listCulledArchivedLinks this deliberately does NOT filter by who
   * archived it or when - an owner-era archive 404s exactly as loudly as a
   * cull-era one, and Google does not care which of us did it.
   */
  async listArchivedLinksWithHandles(limit = 500): Promise<ProductLink[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM product_links
          WHERE shop = ?1 AND state = 'archived' AND handle IS NOT NULL AND handle != ''
          ORDER BY updated_at ASC
          LIMIT ?2`
      )
      .bind(this.shop, limit)
      .all<ProductLink>();
    return results ?? [];
  }

  /** Archived links attributable to the performance CULL, not the profit agent
   *  and not the owner: archived since `sinceIso` with NO real (dry_run = 0)
   *  agent drop on record. The owner's console archives predate the cutoff the
   *  caller passes; agent drops are excluded here explicitly. */
  async listCulledArchivedLinks(sinceIso: string): Promise<ProductLink[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM product_links pl
         WHERE pl.shop = ?1 AND pl.state = 'archived' AND pl.updated_at >= ?2
           AND pl.shopify_product_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM profit_actions pa
             WHERE pa.shop = pl.shop AND pa.cj_pid = pl.cj_pid AND pa.action = 'drop' AND pa.dry_run = 0
           )
         ORDER BY pl.updated_at ASC`
      )
      .bind(this.shop, sinceIso)
      .all<ProductLink>();
    return results ?? [];
  }

  async getProfitVerdict(cjPid: string): Promise<ProfitVerdictRow | null> {
    return await this.db
      .prepare(
        `SELECT cj_pid, verdict, net_gbp, net_pct, our_retail_gbp, competitor_gbp, competitor_confidence, competitor_sources, reason, checked_at,
                action, from_gbp, to_gbp, acted_at, dry_run
         FROM product_profit WHERE shop = ?1 AND cj_pid = ?2`
      )
      .bind(this.shop, cjPid)
      .first<ProfitVerdictRow>();
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

  /** GDPR customers/redact: erase all inbox PII we hold for one contact email.
   *  Also purges the self-serve affiliate_applications for that email; when the
   *  caller supplies emailHash (the same hash a later task uses to populate
   *  affiliate_orders.buyer_email_hash - tenant-store has no secret and does
   *  not compute it), the matching buyer hash on affiliate_orders is nulled
   *  too. Omitting emailHash is a no-op on affiliate_orders, not an error. */
  async redactContact(email: string, emailHash?: string | null): Promise<number> {
    const e = email.trim().toLowerCase();
    if (!e) return 0;
    const sub = `(SELECT id FROM inbox_threads WHERE shop = ?1 AND contact_email = ?2)`;
    const statements = [
      this.db.prepare(`DELETE FROM inbox_thread_labels WHERE shop = ?1 AND thread_id IN ${sub}`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_messages WHERE shop = ?1 AND thread_id IN ${sub}`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_drafts WHERE shop = ?1 AND thread_id IN ${sub}`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_invoices WHERE shop = ?1 AND thread_id IN ${sub}`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM answer_memory WHERE shop = ?1 AND thread_id IN ${sub}`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM affiliate_applications WHERE shop = ?1 AND email = ?2`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_threads WHERE shop = ?1 AND contact_email = ?2`).bind(this.shop, e),
      this.db.prepare(`DELETE FROM inbox_contacts WHERE shop = ?1 AND email = ?2`).bind(this.shop, e)
    ];
    if (emailHash) {
      statements.push(
        this.db.prepare(`UPDATE affiliate_orders SET buyer_email_hash = NULL WHERE shop = ?1 AND buyer_email_hash = ?2`).bind(this.shop, emailHash)
      );
    }
    const res = await this.db.batch(statements);
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
      this.db.prepare(`DELETE FROM answer_memory WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM affiliate_applications WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM affiliate_tokens WHERE shop = ?1`).bind(this.shop),
      // Fix 7 (2026-07-13 final review): these five PRE-DATE the self-serve
      // funnel (migrations 0015/0019/0024) but were missed when the funnel's
      // own affiliate_applications/affiliate_tokens were added above - a
      // shop/redact request left every partner, voucher, order (including
      // buyer_email_hash), payout, and inbox-partnership-applicant record
      // behind. All five are shop-scoped directly (no join needed).
      this.db.prepare(`DELETE FROM affiliate_orders WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM affiliate_payouts WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM affiliate_vouchers WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM affiliate_partners WHERE shop = ?1`).bind(this.shop),
      this.db.prepare(`DELETE FROM affiliate_applicants WHERE shop = ?1`).bind(this.shop),
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

  async updateOrder(shopifyOrderId: string, fields: Partial<Pick<OrderRow, 'status' | 'hold_reasons' | 'cj_order_id' | 'tracking_number' | 'risk_level'>>): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `UPDATE orders SET
           status = COALESCE(?3, status),
           hold_reasons = COALESCE(?4, hold_reasons),
           cj_order_id = COALESCE(?5, cj_order_id),
           tracking_number = COALESCE(?6, tracking_number),
           risk_level = COALESCE(?8, risk_level),
           updated_at = ?7
         WHERE shop = ?1 AND shopify_order_id = ?2`
      )
      .bind(this.shop, shopifyOrderId, fields.status ?? null, fields.hold_reasons ?? null, fields.cj_order_id ?? null, fields.tracking_number ?? null, now, fields.risk_level ?? null)
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

  /**
   * `failReason` is recorded ONLY alongside state 'failed', and any other state
   * CLEARS it rather than leaving a stale explanation on a product that has
   * since imported fine. That is why it is not a COALESCE like the fields
   * above: those carry forward when omitted, this one must not.
   */
  async putLink(link: { cjPid: string; state: ProductLink['state']; shopifyProductId?: string | null; handle?: string | null; category?: string | null; failReason?: string | null; failDetail?: string | null }): Promise<void> {
    const now = new Date().toISOString();
    const reason = link.state === 'failed' ? (link.failReason ?? null) : null;
    // failDetail follows failReason exactly - written only alongside 'failed',
    // cleared on every other state. A detail surviving a later successful import
    // would read as a live product that also failed, which is worse than silence.
    const detail = link.state === 'failed' ? (link.failDetail ?? null) : null;
    await this.db
      .prepare(
        `INSERT INTO product_links (shop, cj_pid, shopify_product_id, handle, category, state, created_at, updated_at, fail_reason, fail_detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9)
         ON CONFLICT(shop, cj_pid) DO UPDATE SET
           shopify_product_id = COALESCE(?3, shopify_product_id),
           handle = COALESCE(?4, handle),
           category = COALESCE(?5, category),
           state = ?6, updated_at = ?7, fail_reason = ?8, fail_detail = ?9`
      )
      .bind(this.shop, link.cjPid, link.shopifyProductId ?? null, link.handle ?? null, link.category ?? null, link.state, now, reason, detail)
      .run();
  }

  /**
   * The funnel roll-up, one row per (gate, product): which gate rejected it and
   * HOW FAR it missed. `fail_reason` alone answers which gate binds;
   * `fail_detail` is what makes "loosen it or not" an evidenced decision rather
   * than a guess. Ordered so the biggest bucket reads first.
   */
  async failureDetails(limit = 500): Promise<{ reason: string; detail: string | null; handle: string | null; category: string | null }[]> {
    const rs = await this.db
      .prepare(
        `SELECT COALESCE(fail_reason, 'unrecorded') AS reason, fail_detail AS detail, handle, category
           FROM product_links
          WHERE shop = ?1 AND state = 'failed' AND fail_detail IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT ?2`
      )
      .bind(this.shop, limit)
      .all<{ reason: string; detail: string | null; handle: string | null; category: string | null }>();
    return rs.results ?? [];
  }

  /**
   * The admission funnel: how many products each gate is currently keeping out.
   *
   * This is the question that could not be answered on 2026-08-01, when 270
   * rows sat in 'failed' with no recorded cause. Read it before tuning any
   * floor - a small catalog is only evidence of an over-strict gate once you
   * know WHICH gate is binding.
   *
   * `unrecorded` is the pre-migration backlog, not a bug.
   */
  async failureReasonCounts(): Promise<{ reason: string; n: number }[]> {
    const rs = await this.db
      .prepare(
        `SELECT COALESCE(fail_reason, 'unrecorded') AS reason, COUNT(*) AS n
           FROM product_links
          WHERE shop = ?1 AND state = 'failed'
          GROUP BY reason
          ORDER BY n DESC`
      )
      .bind(this.shop)
      .all<{ reason: string; n: number }>();
    return rs.results ?? [];
  }

  // --- Product referrer index (2026-07-31) ---
  //
  // A DERIVED CACHE of which internal surfaces point at a product handle, read
  // by archiveProductGuarded before any takedown. A MISS means "unknown" and
  // BLOCKS the archive - it must never be read as "safe to archive".

  /** Insert referrer rows for ONE handle. Idempotent per
   *  (handle, type, id), so a nightly rebuild cannot accumulate duplicates. */
  async putProductReferrers(
    handle: string,
    rows: { referrerType: string; referrerId: string }[]
  ): Promise<void> {
    if (!rows.length) return;
    const now = new Date().toISOString();
    await this.db.batch(
      rows.map((r) =>
        this.db
          .prepare(
            `INSERT INTO product_referrers (shop, handle, referrer_type, referrer_id, detected_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(shop, handle, referrer_type, referrer_id)
             DO UPDATE SET detected_at = excluded.detected_at`
          )
          .bind(this.shop, handle.toLowerCase(), r.referrerType, r.referrerId, now)
      )
    );
  }

  async referrersFor(handle: string): Promise<ProductReferrer[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM product_referrers WHERE shop = ?1 AND handle = ?2 ORDER BY referrer_type, referrer_id`)
      .bind(this.shop, handle.toLowerCase())
      .all<ProductReferrer>();
    return rs.results ?? [];
  }

  /**
   * How many products of each category a given guide references.
   *
   * This is what lets a dead product URL find a CONGRUENT article without an
   * LLM and without a hand-maintained topic map: an article that recommends six
   * pet-toys products is, on the evidence, the pet-toys guide. Derived from live
   * data, so it re-aims itself as the blog grows rather than going stale.
   *
   * Joined on handle because that is what product_referrers stores; a product
   * with no category contributes nothing rather than forming a null bucket.
   */
  async articleCategoryWeights(): Promise<{ referrerId: string; category: string; n: number }[]> {
    const rs = await this.db
      .prepare(
        `SELECT r.referrer_id AS referrerId, l.category AS category, COUNT(*) AS n
           FROM product_referrers r
           JOIN product_links l ON l.shop = r.shop AND l.handle = r.handle
          WHERE r.shop = ?1 AND r.referrer_type = 'blog'
            AND l.category IS NOT NULL AND l.category != ''
          GROUP BY r.referrer_id, l.category`
      )
      .bind(this.shop)
      .all<{ referrerId: string; category: string; n: number }>();
    return rs.results ?? [];
  }

  /**
   * Each generated guide's OWN declared subject - the collection its brief was
   * written against - keyed by the article it became.
   *
   * WHY THIS IS SEPARATE FROM articleCategoryWeights. That query infers what a
   * guide is about from the categories of the products it happens to link, which
   * is a proxy that measurably fails: a guide written about grooming brushes
   * linked one pet-cleaning, one pet-grooming and one more-to-love product, so
   * the inference made it the `more-to-love` guide and never the grooming one
   * (measured 2026-08-02). The brief already knew the answer; nothing read it.
   *
   * Sourced independently of the weights ON PURPOSE, so a guide can claim its
   * own category even when it links NO products in that category at all - which
   * an inference-only ranking can never express.
   *
   * shopify_article_id is nullable and carries no unique constraint (the PK is
   * shop+id), so the GROUP BY collapses any duplicates deterministically:
   * MAX(updated_at) makes SQLite return the newest row's collection_handle
   * rather than an arbitrary one.
   */
  async articleSubjects(): Promise<{ referrerId: string; category: string }[]> {
    const rs = await this.db
      .prepare(
        `SELECT shopify_article_id AS referrerId, collection_handle AS category, MAX(updated_at)
           FROM blog_post_drafts
          WHERE shop = ?1
            AND shopify_article_id IS NOT NULL AND shopify_article_id != ''
            AND collection_handle IS NOT NULL AND collection_handle != ''
          GROUP BY shopify_article_id`
      )
      .bind(this.shop)
      .all<{ referrerId: string; category: string }>();
    return (rs.results ?? []).map((r) => ({ referrerId: r.referrerId, category: r.category }));
  }

  /** Drop every row contributed by ONE source, so rebuilding that source also
   *  REMOVES links it no longer contains. Without this the index would only
   *  grow and would block archives forever. */
  async clearProductReferrers(referrerType: string, referrerId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM product_referrers WHERE shop = ?1 AND referrer_type = ?2 AND referrer_id = ?3`)
      .bind(this.shop, referrerType, referrerId)
      .run();
  }

  /**
   * Most-engaged live product in a category, for redirect targeting: most
   * product_events in 30 days, ties broken by the most recently created link.
   *
   * `exclude` is the handle being archived - without it the top result can be
   * the dying product itself, which would redirect a URL to itself. Filtered in
   * SQL rather than by the caller so no call site can forget it.
   *
   * state='imported' means WE think it is live; the caller still confirms
   * onlineStoreUrl against Shopify, because an unpublished product carries that
   * state too.
   */
  async topLiveHandleInCategory(category: string, exclude?: string): Promise<string | null> {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const row = await this.db
      .prepare(
        `SELECT pl.handle AS h, COUNT(pe.id) AS n
           FROM product_links pl
           LEFT JOIN product_events pe
             ON pe.shop = pl.shop AND pe.cj_pid = pl.cj_pid AND pe.created_at >= ?3
          WHERE pl.shop = ?1 AND pl.state = 'imported' AND pl.category = ?2
            AND pl.handle IS NOT NULL AND pl.handle != ?4
          GROUP BY pl.handle
          ORDER BY n DESC, pl.created_at DESC
          LIMIT 1`
      )
      .bind(this.shop, category, since, exclude ?? '')
      .first<{ h: string; n: number }>();
    return row?.h ?? null;
  }

  /** Overwrite the single completeness stamp for this shop's referrer index. */
  async putReferrerIndexStamp(s: ReferrerIndexStamp): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO referrer_index_stamp (shop, indexed_at, article_count, row_count, truncated)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(shop) DO UPDATE SET
           indexed_at = excluded.indexed_at, article_count = excluded.article_count,
           row_count = excluded.row_count, truncated = excluded.truncated`
      )
      .bind(this.shop, s.indexedAt, s.articleCount, s.rowCount, s.truncated ? 1 : 0)
      .run();
  }

  /** null when the index has never been built - which the guard must treat as
   *  "unknown", never as "nothing is referenced". */
  async getReferrerIndexStamp(): Promise<ReferrerIndexStamp | null> {
    const row = await this.db
      .prepare(`SELECT indexed_at, article_count, row_count, truncated FROM referrer_index_stamp WHERE shop = ?1`)
      .bind(this.shop)
      .first<{ indexed_at: string; article_count: number; row_count: number; truncated: number }>();
    if (!row) return null;
    return {
      indexedAt: row.indexed_at,
      articleCount: row.article_count,
      rowCount: row.row_count,
      truncated: row.truncated === 1,
    };
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

  /** Daily AI expense ledger (owner request 2026-07-11): per day x task x model
   * rollup since the cutoff, newest day first, biggest spend first within a
   * day. Feeds the console Settings "AI spend" card. */
  async llmUsageDaily(sinceIso: string): Promise<{ day: string; task: string; model: string; calls: number; cost_usd: number }[]> {
    const rs = await this.db
      .prepare(`SELECT substr(created_at, 1, 10) AS day, task, model, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost_usd
                FROM llm_usage WHERE shop = ?1 AND created_at >= ?2
                GROUP BY day, task, model ORDER BY day DESC, cost_usd DESC`)
      .bind(this.shop, sinceIso)
      .all<{ day: string; task: string; model: string; calls: number; cost_usd: number }>();
    return rs.results ?? [];
  }

  /** Upsert one vetted Q-A pair. Re-answering the same normalized question
   * REPLACES the stored answer with the newest vetted one, re-enables a
   * disabled pair (the new send is fresh vetted content), and preserves the
   * usage history. `at` backdates backfilled pairs to their real send time. */
  async upsertAnswerMemory(rec: { qhash: string; category: string; questionText: string; questionNorm: string; answerText: string; threadId: string; at?: string }): Promise<void> {
    const now = rec.at ?? new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO answer_memory (shop, qhash, category, question_text, question_norm, answer_text, thread_id, disabled, used_count, last_used_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, NULL, ?8, ?8)
         ON CONFLICT(shop, qhash) DO UPDATE SET
           question_text = ?4, answer_text = ?6, thread_id = ?7, disabled = 0, updated_at = ?8`
      )
      .bind(this.shop, rec.qhash, rec.category, rec.questionText, rec.questionNorm, rec.answerText, rec.threadId, now)
      .run();
  }

  /** The Answer library card: pairs newest-first plus totals. */
  async listAnswerMemory(limit = 100): Promise<{ total: number; disabled: number; rows: { qhash: string; category: string; question: string; answer: string; usedCount: number; lastUsedAt: string | null; updatedAt: string; disabled: number }[] }> {
    const counts = await this.db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(disabled), 0) AS off FROM answer_memory WHERE shop = ?1`)
      .bind(this.shop)
      .first<{ total: number; off: number }>();
    const rs = await this.db
      .prepare(
        `SELECT qhash, category, question_text, answer_text, used_count, last_used_at, updated_at, disabled
         FROM answer_memory WHERE shop = ?1 ORDER BY updated_at DESC LIMIT ?2`
      )
      .bind(this.shop, Math.min(Math.max(limit, 1), 200))
      .all<AnswerMemoryRow>();
    return {
      total: counts?.total ?? 0,
      disabled: counts?.off ?? 0,
      rows: (rs.results ?? []).map((r) => ({
        qhash: r.qhash, category: r.category, question: r.question_text, answer: r.answer_text,
        usedCount: r.used_count, lastUsedAt: r.last_used_at, updatedAt: r.updated_at, disabled: r.disabled,
      })),
    };
  }

  /** Owner Disable/Enable on one pair (recall skips disabled pairs). */
  async setAnswerDisabled(qhash: string, disabled: boolean): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE answer_memory SET disabled = ?3, updated_at = updated_at WHERE shop = ?1 AND qhash = ?2`)
      .bind(this.shop, qhash, disabled ? 1 : 0)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Fresh enabled pairs for recall scoring (scored in JS by the caller). */
  async listRecallCandidates(sinceIso: string, limit = 500): Promise<AnswerMemoryRow[]> {
    const rs = await this.db
      .prepare(
        `SELECT qhash, category, question_text, question_norm, answer_text, thread_id, disabled, used_count, last_used_at, created_at, updated_at
         FROM answer_memory WHERE shop = ?1 AND disabled = 0 AND updated_at >= ?2 ORDER BY updated_at DESC LIMIT ?3`
      )
      .bind(this.shop, sinceIso, limit)
      .all<AnswerMemoryRow>();
    return rs.results ?? [];
  }

  /** Mark pairs as recalled (usage stats on the library card). */
  async bumpAnswerUsage(qhashes: string[]): Promise<void> {
    if (!qhashes.length) return;
    const placeholders = qhashes.map((_, i) => `?${i + 3}`).join(',');
    await this.db
      .prepare(`UPDATE answer_memory SET used_count = used_count + 1, last_used_at = ?2 WHERE shop = ?1 AND qhash IN (${placeholders})`)
      .bind(this.shop, new Date().toISOString(), ...qhashes)
      .run();
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

  /** Owner "Keep" override (2026-07-12): 1 = the profitability agent must not
   * reprice, flag or drop this product; the judge short-circuits to a pass
   * verdict until the owner releases it from the console row. Returns false
   * when no link row exists for the pid. */
  async setProfitKeep(cjPid: string, keep: boolean): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE product_links SET profit_keep = ?3, updated_at = ?4 WHERE shop = ?1 AND cj_pid = ?2`)
      .bind(this.shop, cjPid, keep ? 1 : 0, new Date().toISOString())
      .run();
    return (r.meta.changes ?? 0) > 0;
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

  /** Detail-only update of a warehouse row (e.g. the freight backfill enriching
   *  the stored CjDetail). Unlike putWarehouseProduct this touches NOTHING else -
   *  no status reset to 'available', no stock overwrite, no freshness restamp -
   *  because the caller is annotating stored data, not reporting a fresh fetch. */
  async updateWarehouseDetail(cjPid: string, detailJson: string): Promise<void> {
    await this.db
      .prepare(`UPDATE warehouse_products SET detail = ?3 WHERE shop = ?1 AND cj_pid = ?2`)
      .bind(this.shop, cjPid, detailJson)
      .run();
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
    // Cap raised 200 -> 500 (2026-07-12) so the one-time answer-memory backfill
    // (src/inbox/answer-memory.ts, requests 500) doesn't silently skip older
    // threads on shops past 200. Verified via graphite (callers listThreads):
    // every other caller passes <= 100 or relies on the 50 default, so this is
    // a strict widening with no behavior change for them.
    const lim = Math.min(Math.max(limit, 1), 500);
    let rs;
    if (status === 'open') {
      // Default console view = threads still needing the merchant's attention, i.e.
      // ONLY new + needs_reply. awaiting_customer is excluded too: once a reply is
      // sent the thread flips to awaiting_customer (send.ts) and must drop OFF this
      // list (it's processed - the ball is in the customer's court). Excluding only
      // converted/closed/spam left replied threads lingering here, which read as
      // "still unprocessed". The merchant can still see them via the dedicated
      // "Awaiting customer" filter.
      rs = await this.db.prepare(`SELECT * FROM inbox_threads WHERE shop = ?1 AND status ${OPEN_THREAD_STATUSES_SQL} ORDER BY last_message_at DESC LIMIT ${lim}`).bind(this.shop).all<ThreadRow>();
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
                  AND t.status ${OPEN_THREAD_STATUSES_SQL}`)
      .bind(this.shop).first<{ n: number; oldest: string | null }>();
    return { n: row?.n ?? 0, oldestAt: row?.oldest ?? null };
  }

  /** Size of the Open (unprocessed) queue - the SAME definition the Inbox
   * default list uses, so the rail badge can never disagree with what opening
   * the Inbox shows (owner invariant, 2026-07-05: a thread awaiting attention
   * counts whether or not its draft has been generated yet). */
  async openThreadCount(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM inbox_threads WHERE shop = ?1 AND status ${OPEN_THREAD_STATUSES_SQL}`)
      .bind(this.shop).first<{ n: number }>();
    return row?.n ?? 0;
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

  /** Imported, Shopify-linked products whose warehouse row carries NO freightUsd.
   *  For these the nightly cost sync can only compute a freight-FREE landed cost,
   *  so the profitability agent judges them on understated costs (the freight-blind
   *  audit gap, 2026-07-10) - the nightly backfill (backfillWarehouseFreight) works
   *  this list off. Keyed on the very field the backfill writes, so a failed
   *  estimate stays in the list and retries the next night. */
  async importedRowsWithoutFreight(limit = 25): Promise<{ cj_pid: string; detail: string }[]> {
    const rs = await this.db
      .prepare(
        `SELECT w.cj_pid AS cj_pid, w.detail AS detail
         FROM product_links l
         JOIN warehouse_products w ON w.shop = l.shop AND w.cj_pid = l.cj_pid
         WHERE l.shop = ?1 AND l.state = 'imported' AND l.shopify_product_id IS NOT NULL
           AND json_extract(w.detail, '$.freightUsd') IS NULL
         ORDER BY l.created_at ASC LIMIT ${Math.min(Math.max(limit, 1), 100)}`
      )
      .bind(this.shop)
      .all<{ cj_pid: string; detail: string }>();
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

  /** Latest applicant record for an email - lets a one-click voucher issue land
   *  its code invite back in the applicant's own inbox thread. */
  getApplicantByEmail(email: string): Promise<ApplicantRow | null> {
    return this.db.prepare(`SELECT * FROM affiliate_applicants WHERE shop = ?1 AND contact_email = ?2 ORDER BY updated_at DESC LIMIT 1`)
      .bind(this.shop, email.toLowerCase()).first<ApplicantRow>();
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

  /** Trial-code queue (2026-07-06): park a qualified applicant as a partner row
   *  with status 'queued' so their code can be issued later from Partners. The
   *  issue flow runs through upsertAffiliatePartner, which flips status back to
   *  'active' - a queued row graduates automatically the moment a code is minted. */
  async queueAffiliatePartner(p: { contactEmail: string; name?: string | null; notes?: string | null }): Promise<'queued' | 'already_queued' | 'live_partner'> {
    const email = p.contactEmail.trim().toLowerCase();
    const now = new Date().toISOString();
    const existing = await this.db
      .prepare(
        `SELECT p.id, p.status,
                (SELECT COUNT(*) FROM affiliate_vouchers v
                  WHERE v.shop = p.shop AND v.partner_id = p.id AND v.status = 'live' AND v.ends_at > ?3) AS live
         FROM affiliate_partners p WHERE p.shop = ?1 AND p.contact_email = ?2 LIMIT 1`
      )
      .bind(this.shop, email, now).first<{ id: string; status: string; live: number }>();
    if (existing && existing.live > 0) return 'live_partner';
    if (existing && existing.status === 'queued') return 'already_queued';
    if (existing) {
      await this.db
        .prepare(`UPDATE affiliate_partners SET status = 'queued', name = COALESCE(?3, name), notes = COALESCE(?4, notes), updated_at = ?5 WHERE shop = ?1 AND id = ?2`)
        .bind(this.shop, existing.id, p.name ?? null, p.notes ?? null, now).run();
      return 'queued';
    }
    await this.db
      .prepare(
        `INSERT INTO affiliate_partners (shop, id, contact_email, name, channel_url, status, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, 'queued', ?5, ?6, ?6)`
      )
      .bind(this.shop, crypto.randomUUID(), email, p.name ?? null, p.notes ?? null, now).run();
    return 'queued';
  }

  /** The queue, newest first, for the Partners view. */
  async listQueuedPartners(): Promise<{ id: string; contact_email: string; name: string | null; notes: string | null; marketing_consent: number; updated_at: string }[]> {
    const rs = await this.db
      .prepare(`SELECT id, contact_email, name, notes, marketing_consent, updated_at FROM affiliate_partners WHERE shop = ?1 AND status = 'queued' ORDER BY updated_at DESC`)
      .bind(this.shop)
      .all<{ id: string; contact_email: string; name: string | null; notes: string | null; marketing_consent: number; updated_at: string }>();
    return rs.results ?? [];
  }

  /** Take someone out of the queue without issuing ('ended' keeps the history). */
  async unqueueAffiliatePartner(partnerId: string): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE affiliate_partners SET status = 'ended', updated_at = ?3 WHERE shop = ?1 AND id = ?2 AND status = 'queued'`)
      .bind(this.shop, partnerId, new Date().toISOString()).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Pool state for one email - drives the Inbox context-rail queue control. */
  async partnerPoolState(email: string): Promise<'none' | 'queued' | 'live' | 'former'> {
    const row = await this.db
      .prepare(
        `SELECT p.status,
                (SELECT COUNT(*) FROM affiliate_vouchers v
                  WHERE v.shop = p.shop AND v.partner_id = p.id AND v.status = 'live' AND v.ends_at > ?3) AS live
         FROM affiliate_partners p WHERE p.shop = ?1 AND p.contact_email = ?2 LIMIT 1`
      )
      .bind(this.shop, email.trim().toLowerCase(), new Date().toISOString()).first<{ status: string; live: number }>();
    if (!row) return 'none';
    if (row.live > 0) return 'live';
    if (row.status === 'queued') return 'queued';
    return 'former';
  }

  /** Partner row id for an email, if one exists (consent setter uses this so it
   *  never routes through upsertAffiliatePartner, which would graduate a queued
   *  row or resurrect an ended one as a side effect). */
  async partnerIdByEmail(email: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT id FROM affiliate_partners WHERE shop = ?1 AND contact_email = ?2 LIMIT 1`)
      .bind(this.shop, email.trim().toLowerCase()).first<{ id: string }>();
    return row?.id ?? null;
  }

  /** Marketing consent for one email: true/false, or null when no partner row
   *  exists yet - drives the Inbox context-rail consent control. */
  async partnerConsentByEmail(email: string): Promise<boolean | null> {
    const row = await this.db
      .prepare(`SELECT marketing_consent FROM affiliate_partners WHERE shop = ?1 AND contact_email = ?2 LIMIT 1`)
      .bind(this.shop, email.trim().toLowerCase()).first<{ marketing_consent: number }>();
    return row ? row.marketing_consent === 1 : null;
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
  async listAffiliateVouchers(nowMs: number = Date.now()): Promise<AffiliateVoucherListRow[]> {
    // owed splits into owed_cleared (past the clearance hold, payable now) and
    // owed_maturing (still in the return-window hold) on the same cutoff the
    // payout uses, so the owner only ever pays what has genuinely cleared.
    const cutoff = clearanceCutoffIso(nowMs);
    const rs = await this.db
      .prepare(
        `SELECT v.id AS voucher_id, v.code, v.pct_off, v.commission_pct, v.starts_at, v.ends_at, v.status, v.created_at,
                p.id AS partner_id, p.contact_email, p.name, p.channel_url, p.notes, p.marketing_consent,
                COALESCE(o.uses, 0) AS uses, COALESCE(o.gross, 0) AS gross, COALESCE(o.discount, 0) AS discount,
                COALESCE(o.owed, 0) AS owed, COALESCE(o.owed_cleared, 0) AS owed_cleared,
                COALESCE(o.owed_maturing, 0) AS owed_maturing, COALESCE(po.paid, 0) AS paid, o.last_order_at
         FROM affiliate_vouchers v
         JOIN affiliate_partners p ON p.shop = v.shop AND p.id = v.partner_id
         LEFT JOIN (
           SELECT voucher_id,
                  SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS uses,
                  SUM(CASE WHEN eligible = 1 THEN gross_gbp ELSE 0 END) AS gross,
                  SUM(CASE WHEN eligible = 1 THEN discount_gbp ELSE 0 END) AS discount,
                  SUM(CASE WHEN paid_out_at IS NULL THEN commission_gbp ELSE 0 END) AS owed,
                  SUM(CASE WHEN paid_out_at IS NULL AND COALESCE(placed_at, created_at) <= ?2 THEN commission_gbp ELSE 0 END) AS owed_cleared,
                  SUM(CASE WHEN paid_out_at IS NULL AND COALESCE(placed_at, created_at) >  ?2 THEN commission_gbp ELSE 0 END) AS owed_maturing,
                  MAX(placed_at) AS last_order_at
           FROM affiliate_orders WHERE shop = ?1 GROUP BY voucher_id
         ) o ON o.voucher_id = v.id
         -- Paid = the frozen payout record (cash that really left), NOT the live
         -- commission of stamped rows: a refund after a payout recomputes the
         -- ledger but must never rewrite what was actually paid.
         LEFT JOIN (
           SELECT voucher_id, SUM(amount_gbp) AS paid
           FROM affiliate_payouts WHERE shop = ?1 GROUP BY voucher_id
         ) po ON po.voucher_id = v.id
         WHERE v.shop = ?1
         ORDER BY v.created_at DESC`
      )
      .bind(this.shop, cutoff)
      .all<AffiliateVoucherListRow>();
    return rs.results ?? [];
  }

  /** All registered vouchers (any status) for the attribution sweep's code map.
   *  Revoked/expired codes still record matches: if Shopify honoured the code,
   *  the discount was really given and the ledger reflects reality. LEFT JOINs
   *  affiliate_partners for contact_email (the self-referral guard's compare
   *  target) - deliberately a LEFT JOIN, not INNER: a voucher whose partner
   *  row is ever missing must still attribute orders exactly as before
   *  (partner_email just comes back null and the guard has no determination),
   *  never silently drop out of the sweep. */
  async attributionVouchers(): Promise<AttributionVoucherRow[]> {
    const rs = await this.db
      .prepare(
        `SELECT v.id AS id, v.code AS code, v.commission_pct AS commission_pct, v.status AS status, v.created_at AS created_at,
                p.contact_email AS partner_email
         FROM affiliate_vouchers v
         LEFT JOIN affiliate_partners p ON p.shop = v.shop AND p.id = v.partner_id
         WHERE v.shop = ?1`
      )
      .bind(this.shop)
      .all<AttributionVoucherRow>();
    return rs.results ?? [];
  }

  /** Upsert one attributed order. Re-upserts on later order updates (refunds,
   *  edits) refresh the money columns but NEVER touch paid_out_at, so payouts
   *  already made stay stamped. buyerEmailHash/selfReferral are the
   *  self-referral guard's output (task-2): buyerEmailHash is a keyed hash,
   *  never the raw email; selfReferral zeroes commission upstream (the caller
   *  passes commissionGbp already forced to 0 when true) but this row still
   *  keeps gross/discount honest - the sale happened.
   *
   *  self_referral is STICKY (monotonic) across re-upserts: the stored value
   *  is MAX(existing self_referral, this call's selfReferral), never allowed
   *  to fall back from 1 to 0. Order emails are protected customer data that
   *  can come back null on a later poll (dashboard access revoked, a
   *  transient field-access gap, etc.) even though the order itself has not
   *  changed - that absence must never be read as "not a self-referral after
   *  all" and used to restore a commission that was correctly denied.
   *  commission_gbp follows the same effective (post-MAX) self_referral, so
   *  once a row is flagged self-referral its commission can only ever be
   *  read as 0 from then on, regardless of what a later poll computes. This
   *  does not interfere with refund clawback: clawback only ever lowers
   *  commission via the caller's own commissionGbp recompute, and a
   *  non-self-referral row's self_referral stays MAX(0, 0) = 0 throughout,
   *  so its commission still moves freely (down on refund, back up on a
   *  later correction) exactly as before this guard existed. */
  async upsertAffiliateOrder(o: {
    shopifyOrderId: string; voucherId: string; orderName: string | null; grossGbp: number; discountGbp: number;
    commissionGbp: number; financialStatus: string | null; eligible: boolean; placedAt: string | null;
    buyerEmailHash?: string | null; selfReferral?: boolean;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO affiliate_orders (shop, shopify_order_id, voucher_id, order_name, gross_gbp, discount_gbp, commission_gbp, financial_status, eligible, placed_at, buyer_email_hash, self_referral, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
         ON CONFLICT(shop, shopify_order_id, voucher_id) DO UPDATE SET
           order_name = ?4, gross_gbp = ?5, discount_gbp = ?6,
           commission_gbp = CASE WHEN MAX(affiliate_orders.self_referral, ?12) = 1 THEN 0 ELSE ?7 END,
           financial_status = ?8, eligible = ?9, placed_at = ?10, buyer_email_hash = ?11,
           self_referral = MAX(affiliate_orders.self_referral, ?12), updated_at = ?13`
      )
      .bind(
        this.shop, o.shopifyOrderId, o.voucherId, o.orderName, o.grossGbp, o.discountGbp, o.commissionGbp,
        o.financialStatus, o.eligible ? 1 : 0, o.placedAt, o.buyerEmailHash ?? null, o.selfReferral ? 1 : 0, now
      )
      .run();
  }

  /** Ledger drill-down for one voucher, newest order first. */
  async affiliateOrdersForVoucher(voucherId: string, limit = 100): Promise<AffiliateOrderRow[]> {
    const rs = await this.db
      .prepare(
        `SELECT shopify_order_id, order_name, gross_gbp, discount_gbp, commission_gbp, financial_status, eligible, placed_at, paid_out_at, payout_id, buyer_email_hash, self_referral
         FROM affiliate_orders WHERE shop = ?1 AND voucher_id = ?2
         ORDER BY placed_at DESC LIMIT ?3`
      )
      .bind(this.shop, voucherId, limit)
      .all<AffiliateOrderRow>();
    return rs.results ?? [];
  }

  /** Record a commission payout (2026-07-06, the accounting record): snapshot
   *  every eligible unpaid commission row into an immutable affiliate_payouts
   *  row (amount + per-order figures FROZEN at payout time), then stamp those
   *  exact rows paid_out_at + payout_id. Later refunds still recompute the
   *  live ledger honestly, but what was actually paid can never be rewritten.
   *  Returns null when nothing is owed. */
  async createAffiliatePayout(voucherId: string, opts?: { method?: string | null; reference?: string | null; note?: string | null }, nowMs: number = Date.now()): Promise<{ payoutId: string; amount: number; ordersCovered: number; createdAt: string } | null> {
    // Only CLEARED rows are payable: an order still inside its return window can
    // still be refunded, so paying its commission early risks paying on a sale
    // that reverses (and the frozen payout record can never be rewritten).
    const cutoff = clearanceCutoffIso(nowMs);
    const rs = await this.db
      .prepare(
        `SELECT shopify_order_id, order_name, placed_at, gross_gbp, discount_gbp, commission_gbp
         FROM affiliate_orders
         WHERE shop = ?1 AND voucher_id = ?2 AND paid_out_at IS NULL AND eligible = 1 AND commission_gbp > 0
           AND COALESCE(placed_at, created_at) <= ?3
         ORDER BY placed_at ASC`
      )
      .bind(this.shop, voucherId, cutoff)
      .all<{ shopify_order_id: string; order_name: string | null; placed_at: string | null; gross_gbp: number; discount_gbp: number; commission_gbp: number }>();
    const rows = rs.results ?? [];
    if (!rows.length) return null;
    const voucher = await this.db
      .prepare(`SELECT partner_id FROM affiliate_vouchers WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, voucherId).first<{ partner_id: string }>();
    if (!voucher) return null;
    const payoutId = crypto.randomUUID();
    const now = new Date().toISOString();
    const amount = Math.round(rows.reduce((s, r) => s + r.commission_gbp, 0) * 100) / 100;
    const snapshot = rows.map((r) => ({
      id: r.shopify_order_id, name: r.order_name, placedAt: r.placed_at,
      gross: r.gross_gbp, discount: r.discount_gbp, commission: r.commission_gbp
    }));
    await this.db
      .prepare(
        `INSERT INTO affiliate_payouts (shop, id, voucher_id, partner_id, amount_gbp, orders_count, method, reference, note, orders_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      )
      .bind(this.shop, payoutId, voucherId, voucher.partner_id, amount, rows.length,
        opts?.method?.trim() || null, opts?.reference?.trim() || null, opts?.note?.trim() || null,
        JSON.stringify(snapshot), now)
      .run();
    // Stamp exactly the snapshotted rows (by id, chunked under D1's bind cap),
    // never a re-run of the WHERE - an order landing between the read and this
    // write must fall into the NEXT payout, not into this one unrecorded.
    for (let i = 0; i < rows.length; i += 60) {
      const chunk = rows.slice(i, i + 60);
      const marks = chunk.map((_, j) => `?${j + 5}`).join(', ');
      await this.db
        .prepare(
          `UPDATE affiliate_orders SET paid_out_at = ?3, payout_id = ?4
           WHERE shop = ?1 AND voucher_id = ?2 AND paid_out_at IS NULL AND shopify_order_id IN (${marks})`
        )
        .bind(this.shop, voucherId, now, payoutId, ...chunk.map((r) => r.shopify_order_id))
        .run();
    }
    return { payoutId, amount, ordersCovered: rows.length, createdAt: now };
  }

  /** Payout history for one voucher, newest first (statement data included). */
  async listAffiliatePayouts(voucherId: string): Promise<{ id: string; amount_gbp: number; orders_count: number; method: string | null; reference: string | null; note: string | null; orders_json: string; created_at: string }[]> {
    const rs = await this.db
      .prepare(
        `SELECT id, amount_gbp, orders_count, method, reference, note, orders_json, created_at
         FROM affiliate_payouts WHERE shop = ?1 AND voucher_id = ?2 ORDER BY created_at DESC`
      )
      .bind(this.shop, voucherId)
      .all<{ id: string; amount_gbp: number; orders_count: number; method: string | null; reference: string | null; note: string | null; orders_json: string; created_at: string }>();
    return rs.results ?? [];
  }

  /** Self-serve partner portal aggregate (Task 5, 2026-07-12): ONLY this
   *  partner's own numbers, across every voucher they have ever held - never
   *  a per-order list, so no buyer PII (order name, buyer email/address) can
   *  ever reach the portal surface (see PartnerPortalSummary's doc). Uses the
   *  same ELIGIBLE-only filter as listAffiliateVouchers' uses/gross columns;
   *  paid comes from the frozen affiliate_payouts total (what actually left,
   *  immune to a later refund recompute), pending is the live unpaid
   *  commission on eligible rows - same owed/paid split as listAffiliateVouchers. */
  async partnerPortalSummary(partnerId: string, nowMs: number = Date.now()): Promise<PartnerPortalSummary> {
    const cutoff = clearanceCutoffIso(nowMs);
    const vouchersRs = await this.db
      .prepare(
        `SELECT code, status, starts_at, ends_at FROM affiliate_vouchers
         WHERE shop = ?1 AND partner_id = ?2 ORDER BY created_at DESC`
      )
      .bind(this.shop, partnerId)
      .all<PartnerPortalVoucher>();
    const agg = await this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN o.eligible = 1 THEN 1 ELSE 0 END), 0) AS orders_count,
           COALESCE(SUM(CASE WHEN o.eligible = 1 THEN o.gross_gbp ELSE 0 END), 0) AS gross_gbp,
           COALESCE(SUM(CASE WHEN o.eligible = 1 THEN o.commission_gbp ELSE 0 END), 0) AS commission_gbp,
           COALESCE(SUM(CASE WHEN o.eligible = 1 AND o.paid_out_at IS NULL THEN o.commission_gbp ELSE 0 END), 0) AS pending_gbp,
           COALESCE(SUM(CASE WHEN o.eligible = 1 AND o.paid_out_at IS NULL AND COALESCE(o.placed_at, o.created_at) <= ?3 THEN o.commission_gbp ELSE 0 END), 0) AS available_gbp,
           COALESCE(SUM(CASE WHEN o.eligible = 1 AND o.paid_out_at IS NULL AND COALESCE(o.placed_at, o.created_at) >  ?3 THEN o.commission_gbp ELSE 0 END), 0) AS maturing_gbp,
           MAX(o.placed_at) AS last_order_at
         FROM affiliate_orders o
         JOIN affiliate_vouchers v ON v.shop = o.shop AND v.id = o.voucher_id
         WHERE o.shop = ?1 AND v.partner_id = ?2`
      )
      .bind(this.shop, partnerId, cutoff)
      .first<{ orders_count: number; gross_gbp: number; commission_gbp: number; pending_gbp: number; available_gbp: number; maturing_gbp: number; last_order_at: string | null }>();
    const paidRow = await this.db
      .prepare(`SELECT COALESCE(SUM(amount_gbp), 0) AS paid_gbp FROM affiliate_payouts WHERE shop = ?1 AND partner_id = ?2`)
      .bind(this.shop, partnerId)
      .first<{ paid_gbp: number }>();
    return {
      partner_id: partnerId,
      vouchers: vouchersRs.results ?? [],
      orders_count: agg?.orders_count ?? 0,
      gross_gbp: agg?.gross_gbp ?? 0,
      commission_gbp: agg?.commission_gbp ?? 0,
      paid_gbp: paidRow?.paid_gbp ?? 0,
      pending_gbp: agg?.pending_gbp ?? 0,
      available_gbp: agg?.available_gbp ?? 0,
      maturing_gbp: agg?.maturing_gbp ?? 0,
      last_order_at: agg?.last_order_at ?? null
    };
  }

  async setAffiliateVoucherStatus(voucherId: string, status: 'live' | 'revoked'): Promise<void> {
    await this.db
      .prepare(`UPDATE affiliate_vouchers SET status = ?3, updated_at = ?4 WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, voucherId, status, new Date().toISOString())
      .run();
  }

  // --- Affiliate self-serve marketplace (2026-07-12): applications + claim tokens.
  // Ships DARK behind tenant_config.selfServe.enabled (src/types.ts) - this store
  // layer is inert plumbing until a later task turns the funnel on. ---

  /** New self-serve signup. Returns the generated id. */
  async insertApplication(a: {
    email: string; name?: string | null; channelUrl?: string | null; answersJson?: string | null;
    stage: string; score?: number | null; factsJson?: string | null; flagsJson?: string | null; ipHash?: string | null;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO affiliate_applications (shop, id, email, name, channel_url, answers_json, stage, score, facts_json, flags_json, ip_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`
      )
      .bind(this.shop, id, a.email.trim().toLowerCase(), a.name ?? null, a.channelUrl ?? null, a.answersJson ?? null,
        a.stage, a.score ?? null, a.factsJson ?? null, a.flagsJson ?? null, a.ipHash ?? null, now)
      .run();
    return id;
  }

  getApplication(id: string): Promise<AffiliateApplicationRow | null> {
    return this.db.prepare(`SELECT * FROM affiliate_applications WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, id).first<AffiliateApplicationRow>();
  }

  /** Advance the funnel stage. score/factsJson/flagsJson are patched only when given (COALESCE). */
  async updateApplicationStage(id: string, stage: string, fields?: { score?: number | null; factsJson?: string | null; flagsJson?: string | null }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE affiliate_applications SET stage = ?3,
           score = COALESCE(?4, score), facts_json = COALESCE(?5, facts_json), flags_json = COALESCE(?6, flags_json),
           updated_at = ?7
         WHERE shop = ?1 AND id = ?2`
      )
      .bind(this.shop, id, stage, fields?.score ?? null, fields?.factsJson ?? null, fields?.flagsJson ?? null, new Date().toISOString())
      .run();
  }

  /** The CAS (compare-and-swap) counterpart to updateApplicationStage: advances
   *  the stage ONLY when the row is currently at `fromStage`, otherwise a
   *  no-op. Returns whether the row actually changed. Two call sites (final
   *  review, 2026-07-13):
   *   - src/affiliate/verify.ts: a claimed 'verify' token only ever advances
   *     submitted -> verified. A duplicate/resent token (apply.ts's resend
   *     path can mint a SECOND valid verify token for an application that has
   *     already moved past 'submitted') claimed AFTER the application has
   *     since reached e.g. 'approved' must never demote it back to
   *     'verified' for reprocessing (Fix 1).
   *   - src/affiliate/screen.ts's screenOneApplication catch: only reset
   *     judging -> verified when the row is STILL at 'judging' - a throw
   *     AFTER a successful issueVoucher (post-approval) must not demote an
   *     already-approved row (Fix 3).
   *  fields are COALESCEd the same way updateApplicationStage's are. */
  async advanceApplicationStage(
    id: string, fromStage: string, toStage: string,
    fields?: { score?: number | null; factsJson?: string | null; flagsJson?: string | null }
  ): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE affiliate_applications SET stage = ?4,
           score = COALESCE(?5, score), facts_json = COALESCE(?6, facts_json), flags_json = COALESCE(?7, flags_json),
           updated_at = ?8
         WHERE shop = ?1 AND id = ?2 AND stage = ?3`
      )
      .bind(this.shop, id, fromStage, toStage, fields?.score ?? null, fields?.factsJson ?? null, fields?.flagsJson ?? null, new Date().toISOString())
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Isolate-death recovery (Fix 3, 2026-07-13 final review): nothing else
   *  ever re-reads the `judging` stage - only screenOneApplication's own
   *  catch resets it, and only if the isolate survives long enough to run
   *  that catch. An isolate that dies mid-screen (OOM, eviction, a killed
   *  request) leaves the row stranded at `judging` forever: no retry, no
   *  alert, silently lost. Called once per shop per sweep tick
   *  (runAffiliateScreenSweep): any `judging` row whose updated_at is older
   *  than `beforeIso` is reset back to `verified` so the SAME tick's
   *  `verified`-stage query can pick it straight back up. Returns the count
   *  reclaimed. */
  async reclaimStaleJudging(beforeIso: string): Promise<number> {
    const r = await this.db
      .prepare(
        `UPDATE affiliate_applications SET stage = ?3, updated_at = ?5
         WHERE shop = ?1 AND stage = ?2 AND updated_at < ?4`
      )
      .bind(this.shop, AFFILIATE_STAGE_JUDGING, AFFILIATE_STAGE_VERIFIED, beforeIso, new Date().toISOString())
      .run();
    return r.meta.changes ?? 0;
  }

  /** Console/queue drill-down: one funnel stage, newest first. */
  async listApplicationsByStage(stage: string, limit = 100): Promise<AffiliateApplicationRow[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM affiliate_applications WHERE shop = ?1 AND stage = ?2 ORDER BY updated_at DESC LIMIT ?3`)
      .bind(this.shop, stage, Math.min(Math.max(limit, 1), 500))
      .all<AffiliateApplicationRow>();
    return rs.results ?? [];
  }

  /** Console table: every application, any stage, actionable stages first.
   *  A plain `ORDER BY updated_at DESC LIMIT n` would let a still-pending
   *  owner_queue/deflected/approved_pending_issue row silently fall off the
   *  list once >n OTHER (terminal) applications had updated more recently -
   *  those rows are static (updated_at stops bumping until acted on), so they
   *  age out even though nothing about them changed. Sorting actionable
   *  stages to priority 0 keeps them visible for as long as their own count
   *  stays under the limit; terminal stages (approved/declined/everything
   *  else) fill the remaining slots as recent history, newest first. */
  async listApplicationsForConsole(limit = 100): Promise<AffiliateApplicationRow[]> {
    const rs = await this.db
      .prepare(
        `SELECT * FROM affiliate_applications WHERE shop = ?1
           ORDER BY
             CASE stage WHEN ?3 THEN 0 WHEN ?4 THEN 0 WHEN ?5 THEN 0 ELSE 1 END ASC,
             updated_at DESC
           LIMIT ?2`
      )
      .bind(
        this.shop, Math.min(Math.max(limit, 1), 500),
        AFFILIATE_STAGE_OWNER_QUEUE, AFFILIATE_STAGE_DEFLECTED, AFFILIATE_STAGE_APPROVED_PENDING_ISSUE
      )
      .all<AffiliateApplicationRow>();
    return rs.results ?? [];
  }

  /** Latest application for an email (case-insensitive), or null. */
  applicationByEmail(email: string): Promise<AffiliateApplicationRow | null> {
    return this.db
      .prepare(`SELECT * FROM affiliate_applications WHERE shop = ?1 AND email = ?2 ORDER BY updated_at DESC LIMIT 1`)
      .bind(this.shop, email.trim().toLowerCase())
      .first<AffiliateApplicationRow>();
  }

  /** Dedup check for a promoted channel: true if any LIVE partner or pending
   *  application already lists a channel_url containing this host. A loose
   *  substring match (host "example.com" also matches "notexample.com") -
   *  acceptable for a funnel dedup nudge, not a security boundary.
   *
   *  `excludeEmail` (optional, backward-compatible - existing callers that
   *  omit it get the exact prior behavior) excludes rows owned by that email
   *  from the match. Callers that fall through a TERMINAL application stage
   *  (approved/declined/deflected) and re-check this as a "genuinely new
   *  applicant" MUST pass their own email here - otherwise this matches the
   *  submitter's OWN prior terminal row and returns a distinguishable
   *  "already linked" rejection instead of the uniform no-enumeration body,
   *  which is itself an oracle (see src/affiliate/apply.ts step 8). */
  async channelUrlRegistered(host: string, excludeEmail?: string): Promise<boolean> {
    const h = host.trim().toLowerCase();
    if (!h) return false;
    const needle = `%${h}%`;
    const ex = excludeEmail ? excludeEmail.trim().toLowerCase() : null;
    const row = await this.db
      .prepare(
        `SELECT 1 AS hit FROM affiliate_partners WHERE shop = ?1 AND channel_url IS NOT NULL AND lower(channel_url) LIKE ?2
           AND (?3 IS NULL OR lower(contact_email) <> ?3)
         UNION ALL
         SELECT 1 AS hit FROM affiliate_applications WHERE shop = ?1 AND channel_url IS NOT NULL AND lower(channel_url) LIKE ?2
           AND (?3 IS NULL OR lower(email) <> ?3)
         LIMIT 1`
      )
      .bind(this.shop, needle, ex)
      .first<{ hit: number }>();
    return row !== null;
  }

  /** Applications submitted since `sinceIso`, optionally scoped to one abuse
   *  signal (repeat IP, or a spam-domain flood) - the two throttle axes the
   *  self-serve gate checks against selfServe.autoIssueCapPerDay's siblings. */
  async countApplicationsToday(sinceIso: string, by?: { ipHash?: string; emailDomain?: string }): Promise<number> {
    let sql = `SELECT COUNT(*) AS n FROM affiliate_applications WHERE shop = ?1 AND created_at >= ?2`;
    const binds: (string | number)[] = [this.shop, sinceIso];
    if (by?.ipHash) {
      sql += ` AND ip_hash = ?${binds.length + 1}`;
      binds.push(by.ipHash);
    } else if (by?.emailDomain) {
      // Escape LIKE wildcards (% and _, plus a literal backslash) in the
      // domain before binding - an unescaped domain containing either
      // becomes an uncontrolled wildcard. Self-DoS-only risk (it only ever
      // widens the caller's OWN rate-limit bucket query), but a domain like
      // "a%b.com" must not silently match unrelated rows.
      const escapedDomain = by.emailDomain.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
      sql += ` AND email LIKE ?${binds.length + 1} ESCAPE '\\'`;
      binds.push(`%@${escapedDomain}`);
    }
    const row = await this.db.prepare(sql).bind(...binds).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Applications that reached AFFILIATE_STAGE_APPROVED (voucher issued) since
   *  `sinceIso` - the numerator behind selfServe.autoIssueCapPerDay. */
  async countAutoIssuedToday(sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM affiliate_applications WHERE shop = ?1 AND stage = ?2 AND updated_at >= ?3`)
      .bind(this.shop, AFFILIATE_STAGE_APPROVED, sinceIso)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Register a single-use claim token (email verification, voucher claim link,
   *  etc). The token itself is hashed by the CALLER before it ever reaches here.
   *  created_at (migration 0034) backs recentUnclaimedToken's cooldown check. */
  async insertToken(t: { tokenHash: string; kind: string; subjectId: string; expiresAt: string }): Promise<void> {
    await this.db
      .prepare(`INSERT INTO affiliate_tokens (shop, token_hash, kind, subject_id, expires_at, used_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)`)
      .bind(this.shop, t.tokenHash, t.kind, t.subjectId, t.expiresAt, new Date().toISOString())
      .run();
  }

  /** True if an UNCLAIMED token of this kind, for this subject, was issued on
   *  or after sinceIso - the cooldown check behind src/affiliate/portal.ts's
   *  handlePortalLogin (Fix 4, 2026-07-13 final review): without it, a rapid
   *  double POST to /affiliate/portal/login for the same live partner mints
   *  and emails a second 'login' token before the first has even had a
   *  chance to be used. Expired-but-unclaimed tokens still count (they were
   *  still ISSUED recently, even if since expired) - only used_at (claimed)
   *  excludes a row, matching the "do not re-issue while one is already
   *  outstanding" intent. Pre-migration rows (created_at NULL) never match a
   *  sinceIso filter, the safe direction (never falsely suppress). */
  async recentUnclaimedToken(subjectId: string, kind: string, sinceIso: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS hit FROM affiliate_tokens
         WHERE shop = ?1 AND subject_id = ?2 AND kind = ?3 AND used_at IS NULL AND created_at >= ?4
         LIMIT 1`
      )
      .bind(this.shop, subjectId, kind, sinceIso)
      .first<{ hit: number }>();
    return row !== null;
  }

  /** Atomic single-use claim: consumes the token and returns its subject_id,
   *  or null if the hash is unknown, already used, the wrong kind, or expired.
   *  The UPDATE's WHERE clause is the compare-and-swap - a second concurrent
   *  claim of the same hash always loses (meta.changes !== 1). */
  async claimToken(tokenHash: string, kind: string): Promise<string | null> {
    const now = new Date().toISOString();
    const r = await this.db
      .prepare(
        `UPDATE affiliate_tokens SET used_at = ?4
         WHERE shop = ?1 AND token_hash = ?2 AND kind = ?3 AND used_at IS NULL AND expires_at > ?4`
      )
      .bind(this.shop, tokenHash, kind, now)
      .run();
    if ((r.meta.changes ?? 0) !== 1) return null;
    const row = await this.db
      .prepare(`SELECT subject_id FROM affiliate_tokens WHERE shop = ?1 AND token_hash = ?2 AND kind = ?3`)
      .bind(this.shop, tokenHash, kind)
      .first<{ subject_id: string }>();
    return row?.subject_id ?? null;
  }

  /** Screening spend since `sinceIso`, converted to GBP by the caller-supplied
   *  rate (tenant-store never does FX itself - see cfg.pricing.fxUsdToGbp
   *  callers elsewhere). Reads the existing llm_usage ledger, scoped to the
   *  AFFILIATE_SCREEN_LLM_TASK tag - the numerator behind selfServe.screenSpendCapGbpPerDay. */
  async sumScreenSpendTodayGbp(sinceIso: string, fxUsdToGbp: number): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM llm_usage WHERE shop = ?1 AND task = ?2 AND created_at >= ?3`)
      .bind(this.shop, AFFILIATE_SCREEN_LLM_TASK, sinceIso)
      .first<{ usd: number }>();
    return Math.round((row?.usd ?? 0) * fxUsdToGbp * 100) / 100;
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
  /** True if this email has opted out of marketing mail (PECR/GDPR suppression). */
  async isEmailUnsubscribed(email: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 FROM email_unsubscribes WHERE shop = ?1 AND email = ?2 LIMIT 1`).bind(this.shop, email.toLowerCase()).first();
    return row !== null;
  }
  async recordUnsubscribe(email: string, at: string): Promise<void> {
    await this.db.prepare(`INSERT OR IGNORE INTO email_unsubscribes (shop, email, unsubscribed_at) VALUES (?1, ?2, ?3)`)
      .bind(this.shop, email.toLowerCase(), at).run();
  }

  // --- Campaigns (2026-07-05): marketing broadcasts + per-campaign send ledger ---

  async insertCampaign(c: { audience: string; subject: string; bodyText: string }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO campaigns (shop, id, audience, subject, body_text, status, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?6)`)
      .bind(this.shop, id, c.audience, c.subject, c.bodyText, now)
      .run();
    return id;
  }

  getCampaign(id: string): Promise<CampaignRow | null> {
    return this.db.prepare(`SELECT * FROM campaigns WHERE shop = ?1 AND id = ?2`).bind(this.shop, id).first<CampaignRow>();
  }

  async listCampaigns(limit = 20): Promise<CampaignRow[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM campaigns WHERE shop = ?1 ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 50)}`)
      .bind(this.shop).all<CampaignRow>();
    return rs.results ?? [];
  }

  /** Delete an unsent draft campaign. Sent/sending history is never deleted. */
  async discardCampaign(id: string): Promise<boolean> {
    const r = await this.db
      .prepare(`DELETE FROM campaigns WHERE shop = ?1 AND id = ?2 AND status = 'draft'`)
      .bind(this.shop, id).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Draft-only edit: audience, subject and body are locked the moment a
   * campaign starts sending (part of the audience has already seen them). */
  async updateCampaignDraft(id: string, c: { audience: string; subject: string; bodyText: string }): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE campaigns SET audience = ?3, subject = ?4, body_text = ?5, updated_at = ?6
                WHERE shop = ?1 AND id = ?2 AND status = 'draft'`)
      .bind(this.shop, id, c.audience, c.subject, c.bodyText, new Date().toISOString())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Guarded status transition (pause/resume/stop): fires only when the
   * current status is in allowedFrom, so a stale button in another tab can
   * never resurrect a finished or stopped campaign. */
  async setCampaignStatus(id: string, to: string, allowedFrom: string[]): Promise<boolean> {
    if (allowedFrom.length === 0) return false;
    const placeholders = allowedFrom.map((_, i) => `?${i + 5}`).join(', ');
    const r = await this.db
      .prepare(`UPDATE campaigns SET status = ?3, updated_at = ?4 WHERE shop = ?1 AND id = ?2 AND status IN (${placeholders})`)
      .bind(this.shop, id, to, new Date().toISOString(), ...allowedFrom)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Batch bookkeeping: recipientCount is idempotent (audience size at send
   * time), sent_count accumulates across batches, sent_at stamps completion.
   * A pause/stop clicked while a batch was in flight survives it: the batch
   * may only overwrite paused/cancelled when everything actually went out
   * (remaining 0 => 'sent' is simply the truth). */
  async updateCampaignProgress(id: string, p: { recipientCount: number; sentDelta: number; status: string; sentAt: string | null }): Promise<void> {
    await this.db
      .prepare(`UPDATE campaigns SET recipient_count = ?3, sent_count = sent_count + ?4,
                  status = CASE WHEN ?5 = 'sent' THEN 'sent' WHEN status IN ('paused','cancelled') THEN status ELSE ?5 END,
                  sent_at = COALESCE(?6, sent_at), updated_at = ?7 WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, id, p.recipientCount, p.sentDelta, p.status, p.sentAt, new Date().toISOString())
      .run();
  }

  async hasCampaignSend(campaignId: string, email: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 FROM campaign_sends WHERE shop = ?1 AND campaign_id = ?2 AND email = ?3 LIMIT 1`)
      .bind(this.shop, campaignId, email.toLowerCase()).first();
    return row !== null;
  }

  async recordCampaignSend(campaignId: string, email: string, sentAt: string, resendId: string | null = null): Promise<void> {
    await this.db
      .prepare(`INSERT OR IGNORE INTO campaign_sends (shop, campaign_id, email, sent_at, resend_id) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(this.shop, campaignId, email.toLowerCase(), sentAt, resendId).run();
  }

  // --- Email engagement events (2026-07-05): Resend webhook rows + rollups ---

  /** Store one webhook event; svix_id is the dedup key across Resend's
   * redeliveries. Returns false when the event was already stored. */
  async insertEmailEvent(e: {
    svixId: string; resendId: string; email: string; eventType: string;
    kind: string | null; campaignId: string | null; threadId: string | null;
    link: string | null; occurredAt: string;
  }, nowIso = new Date().toISOString()): Promise<boolean> {
    const r = await this.db
      .prepare(`INSERT OR IGNORE INTO email_events (shop, svix_id, resend_id, email, event_type, kind, campaign_id, thread_id, link, occurred_at, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
      .bind(this.shop, e.svixId, e.resendId, e.email.toLowerCase(), e.eventType, e.kind, e.campaignId, e.threadId, e.link, e.occurredAt, nowIso)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Engagement events for ONE thread's outbound emails, newest first (the
   * Inbox context rail's Email engagement block). thread_id arrives as a
   * send-time tag on replies/invoices, echoed back in every webhook event. */
  async listThreadEmailEvents(threadId: string, limit = 12): Promise<{ eventType: string; occurredAt: string; link: string | null }[]> {
    const { results } = await this.db
      .prepare(`SELECT event_type, occurred_at, link FROM email_events WHERE shop = ?1 AND thread_id = ?2 ORDER BY occurred_at DESC LIMIT ?3`)
      .bind(this.shop, threadId, Math.min(Math.max(limit, 1), 50))
      .all<{ event_type: string; occurred_at: string; link: string | null }>();
    return (results ?? []).map((r) => ({ eventType: r.event_type, occurredAt: r.occurred_at, link: r.link }));
  }

  /** Per-campaign engagement rollup: UNIQUE RECIPIENTS per event type (one
   * person opening five times counts once), keyed by campaign id. Only real
   * campaign sends count - [Test] sends carry kind=campaign_test and are
   * excluded so a preview to the owner never inflates the numbers. */
  async campaignEventStats(): Promise<Map<string, Record<string, number>>> {
    const rs = await this.db
      .prepare(`SELECT campaign_id, event_type, COUNT(DISTINCT email) AS n FROM email_events
                WHERE shop = ?1 AND kind = 'campaign' AND campaign_id IS NOT NULL
                GROUP BY campaign_id, event_type`)
      .bind(this.shop).all<{ campaign_id: string; event_type: string; n: number }>();
    const out = new Map<string, Record<string, number>>();
    for (const row of rs.results ?? []) {
      const cur = out.get(row.campaign_id) ?? {};
      cur[row.event_type] = row.n;
      out.set(row.campaign_id, cur);
    }
    return out;
  }

  // --- Recurring events (2026-07-06): enable flags + pct override, never dates ---

  async listRecurringEvents(): Promise<{ key: string; enabled: number; pct_off: number | null; armed_for: string | null }[]> {
    const rs = await this.db
      .prepare(`SELECT key, enabled, pct_off, armed_for FROM recurring_events WHERE shop = ?1`)
      .bind(this.shop).all<{ key: string; enabled: number; pct_off: number | null; armed_for: string | null }>();
    return rs.results ?? [];
  }

  async setRecurringEvent(key: string, enabled: boolean, pctOff: number | null): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO recurring_events (shop, key, enabled, pct_off, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                ON CONFLICT(shop, key) DO UPDATE SET enabled = ?3, pct_off = ?4, updated_at = ?5`)
      .bind(this.shop, key, enabled ? 1 : 0, pctOff, now)
      .run();
  }

  async setRecurringArmedFor(key: string, windowStart: string): Promise<void> {
    await this.db
      .prepare(`UPDATE recurring_events SET armed_for = ?3, updated_at = ?4 WHERE shop = ?1 AND key = ?2`)
      .bind(this.shop, key, windowStart, new Date().toISOString())
      .run();
  }

  // --- Blog content pipeline (2026-07-07): staging rows for authored posts ---

  async insertBlogPostDraft(d: {
    id: string; shopifyArticleId: string | null; blogHandle: string | null; title: string;
    collectionHandle: string | null; briefJson: string | null; claimFlagsJson: string | null; model: string | null;
    relatedHandlesJson?: string | null; heroImageUrl?: string | null; heroSourceHandle?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO blog_post_drafts (shop, id, shopify_article_id, blog_handle, title, collection_handle, status, brief_json, claim_flags_json, related_handles_json, hero_image_url, hero_source_handle, model, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'drafted', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`)
      .bind(this.shop, d.id, d.shopifyArticleId, d.blogHandle, d.title, d.collectionHandle, d.briefJson, d.claimFlagsJson,
            d.relatedHandlesJson ?? null, d.heroImageUrl ?? null, d.heroSourceHandle ?? null, d.model, now)
      .run();
  }

  async listBlogPostDrafts(limit = 50): Promise<{
    id: string; shopify_article_id: string | null; blog_handle: string | null; title: string;
    collection_handle: string | null; status: string; brief_json: string | null; claim_flags_json: string | null;
    related_handles_json: string | null; hero_image_url: string | null; hero_source_handle: string | null; created_at: string;
  }[]> {
    const rs = await this.db
      .prepare(`SELECT id, shopify_article_id, blog_handle, title, collection_handle, status, brief_json, claim_flags_json, related_handles_json, hero_image_url, hero_source_handle, created_at
                FROM blog_post_drafts WHERE shop = ?1 ORDER BY created_at DESC LIMIT ?2`)
      .bind(this.shop, limit)
      .all<{ id: string; shopify_article_id: string | null; blog_handle: string | null; title: string; collection_handle: string | null; status: string; brief_json: string | null; claim_flags_json: string | null; related_handles_json: string | null; hero_image_url: string | null; hero_source_handle: string | null; created_at: string }>();
    return rs.results ?? [];
  }

  async setBlogPostStatus(id: string, status: string): Promise<void> {
    await this.db
      .prepare(`UPDATE blog_post_drafts SET status = ?3, updated_at = ?4 WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, id, status, new Date().toISOString())
      .run();
  }

  /** Record the shop-block handles + hero the enrich pass chose, keyed by the
   *  Shopify article id (so a later D1 read confirms exactly what was set). */
  async setBlogPostAssets(shopifyArticleId: string, a: {
    relatedHandlesJson?: string | null; heroImageUrl?: string | null; heroSourceHandle?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(`UPDATE blog_post_drafts SET related_handles_json = ?3, hero_image_url = ?4, hero_source_handle = ?5, updated_at = ?6
                WHERE shop = ?1 AND shopify_article_id = ?2`)
      .bind(this.shop, shopifyArticleId, a.relatedHandlesJson ?? null, a.heroImageUrl ?? null, a.heroSourceHandle ?? null, new Date().toISOString())
      .run();
  }

  // --- Blog syndication (phase 1, 2026-07-11): creative packs + send ledger ---

  async upsertSyndicationPack(p: {
    postId: string; articleHandle: string | null; captionsJson: string;
    pinImageUrl?: string | null; squareImageUrl?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO syndication_packs (shop, post_id, article_handle, captions_json, pin_image_url, square_image_url, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                ON CONFLICT(shop, post_id) DO UPDATE SET article_handle = excluded.article_handle,
                  captions_json = excluded.captions_json, pin_image_url = excluded.pin_image_url,
                  square_image_url = excluded.square_image_url, updated_at = excluded.updated_at`)
      .bind(this.shop, p.postId, p.articleHandle, p.captionsJson, p.pinImageUrl ?? null, p.squareImageUrl ?? null, now)
      .run();
  }

  async getSyndicationPack(postId: string): Promise<{
    post_id: string; article_handle: string | null; captions_json: string;
    pin_image_url: string | null; square_image_url: string | null; updated_at: string;
  } | null> {
    return await this.db
      .prepare(`SELECT post_id, article_handle, captions_json, pin_image_url, square_image_url, updated_at
                FROM syndication_packs WHERE shop = ?1 AND post_id = ?2`)
      .bind(this.shop, postId)
      .first();
  }

  /** Idempotent enqueue: the (shop, post_id, channel) PK means a re-run can
   * never create a second row. Returns true when a NEW row was created. */
  async enqueueSyndication(postId: string, channel: string): Promise<boolean> {
    const now = new Date().toISOString();
    const r = await this.db
      .prepare(`INSERT OR IGNORE INTO syndication_ledger (shop, post_id, channel, status, attempts, created_at, updated_at)
                VALUES (?1, ?2, ?3, 'queued', 0, ?4, ?4)`)
      .bind(this.shop, postId, channel, now)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async listSyndicationLedger(limit = 300): Promise<{
    post_id: string; channel: string; status: string; external_id: string | null;
    error: string | null; attempts: number; sent_at: string | null; updated_at: string;
  }[]> {
    const rs = await this.db
      .prepare(`SELECT post_id, channel, status, external_id, error, attempts, sent_at, updated_at
                FROM syndication_ledger WHERE shop = ?1 ORDER BY updated_at DESC LIMIT ?2`)
      .bind(this.shop, limit)
      .all<{ post_id: string; channel: string; status: string; external_id: string | null; error: string | null; attempts: number; sent_at: string | null; updated_at: string }>();
    return rs.results ?? [];
  }

  /** Partial ledger update. `error` is ALWAYS written (pass null to clear);
   * status/externalId/sentAt/attempts only when provided. */
  async markSyndication(postId: string, channel: string, patch: {
    status?: string; externalId?: string | null; error?: string | null; sentAt?: string | null; attempts?: number;
  }): Promise<void> {
    await this.db
      .prepare(`UPDATE syndication_ledger SET
                  status = COALESCE(?4, status),
                  external_id = COALESCE(?5, external_id),
                  error = ?6,
                  sent_at = COALESCE(?7, sent_at),
                  attempts = COALESCE(?8, attempts),
                  updated_at = ?3
                WHERE shop = ?1 AND post_id = ?2 AND channel = ?9`)
      .bind(this.shop, postId, new Date().toISOString(), patch.status ?? null, patch.externalId ?? null,
            patch.error ?? null, patch.sentAt ?? null, patch.attempts ?? null, channel)
      .run();
  }

  /** Optimistic send fence: bump attempts only if it still equals the value
   * the caller read. Returns false when a concurrent actor (cron sweep vs a
   * console click) claimed the send first - the loser must NOT post. This is
   * the double-post guard for a public action; crash-safe (a crash after a
   * claim just burns one attempt number, it never strands a status). */
  async claimSyndicationAttempt(postId: string, channel: string, expectedAttempts: number): Promise<boolean> {
    const r = await this.db
      .prepare(`UPDATE syndication_ledger SET attempts = attempts + 1, updated_at = ?3
                WHERE shop = ?1 AND post_id = ?2 AND channel = ?4 AND attempts = ?5`)
      .bind(this.shop, postId, new Date().toISOString(), channel, expectedAttempts)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Email-event heartbeat for the System states register: proof the tracking
   * pipeline is really flowing (webhook verified + at least one event stored)
   * without trusting any stored flag. */
  async emailEventPulse(): Promise<{ total: number; latestAt: string | null }> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n, MAX(occurred_at) AS latest FROM email_events WHERE shop = ?1`)
      .bind(this.shop).first<{ n: number; latest: string | null }>();
    return { total: row?.n ?? 0, latestAt: row?.latest ?? null };
  }

  /** Size of the shared suppression list (unsubscribes + complaints + hard bounces). */
  async countUnsubscribes(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM email_unsubscribes WHERE shop = ?1`)
      .bind(this.shop).first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Partner-audience recipients: partners who explicitly opted in. Queued
   *  partners (trial code not issued yet) count - their yes is a yes; only
   *  'ended' rows drop out of the audience. */
  async listConsentingPartnerEmails(): Promise<string[]> {
    const rs = await this.db
      .prepare(`SELECT DISTINCT contact_email FROM affiliate_partners WHERE shop = ?1 AND status IN ('active', 'queued') AND marketing_consent = 1`)
      .bind(this.shop).all<{ contact_email: string }>();
    return (rs.results ?? []).map((r) => r.contact_email);
  }

  // --- Traffic strategy board (2026-07-05): acquisition channels + next actions ---

  async listTrafficChannels(): Promise<TrafficChannelRow[]> {
    const rs = await this.db
      .prepare(`SELECT * FROM traffic_channels WHERE shop = ?1 ORDER BY priority ASC, name ASC`)
      .bind(this.shop).all<TrafficChannelRow>();
    return rs.results ?? [];
  }

  /** Insert or update one channel; omitted id = new row. Returns the id. */
  async upsertTrafficChannel(c: { id?: string; name: string; status: string; priority: number; rationale: string; nextAction: string; notes: string }): Promise<string> {
    const id = c.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO traffic_channels (shop, id, name, status, priority, rationale, next_action, notes, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                ON CONFLICT(shop, id) DO UPDATE SET name = ?3, status = ?4, priority = ?5, rationale = ?6, next_action = ?7, notes = ?8, updated_at = ?9`)
      .bind(this.shop, id, c.name, c.status, c.priority, c.rationale, c.nextAction, c.notes, now)
      .run();
    return id;
  }

  async deleteTrafficChannel(id: string): Promise<boolean> {
    const r = await this.db
      .prepare(`DELETE FROM traffic_channels WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, id).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Owner-flipped marketing opt-in for a partner (records when consent was given). */
  async setPartnerMarketingConsent(partnerId: string, on: boolean): Promise<boolean> {
    const now = new Date().toISOString();
    const r = await this.db
      .prepare(`UPDATE affiliate_partners SET marketing_consent = ?3, marketing_consent_at = ?4, updated_at = ?5 WHERE shop = ?1 AND id = ?2`)
      .bind(this.shop, partnerId, on ? 1 : 0, on ? now : null, now)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }
}

// --- cross-tenant maintenance (cron jobs) - keep all raw D1 in this file ---

export async function listActiveShops(db: D1Database): Promise<string[]> {
  const rs = await db.prepare(`SELECT shop FROM tenants WHERE status = 'active' AND access_token_enc != ''`).all<{ shop: string }>();
  return (rs.results ?? []).map((r) => r.shop);
}

/** Cross-tenant job checkpoint (the daily chain's cursor) stored in
 * search_cache under a sentinel shop. The raw D1 lives HERE per the tenant-
 * isolation guard; jobs.ts owns the semantics and JSON shape. */
export async function readJobCheckpoint(db: D1Database, shop: string, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT payload FROM search_cache WHERE shop = ?1 AND cache_key = ?2`)
    .bind(shop, key).first<{ payload: string }>();
  return row?.payload ?? null;
}

/** Upsert (payload) or delete (null). expires_at = now + ttlMs so an abandoned
 * checkpoint self-purges with the cache sweep. */
export async function writeJobCheckpoint(db: D1Database, shop: string, key: string, payload: string | null, ttlMs: number): Promise<void> {
  if (payload === null) {
    await db.prepare(`DELETE FROM search_cache WHERE shop = ?1 AND cache_key = ?2`).bind(shop, key).run();
    return;
  }
  const now = new Date();
  await db.prepare(
    `INSERT INTO search_cache (shop, cache_key, payload, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(shop, cache_key) DO UPDATE SET payload = ?3, expires_at = ?5`
  ).bind(shop, key, payload, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()).run();
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
