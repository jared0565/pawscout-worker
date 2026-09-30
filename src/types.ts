import type { InboxConfig } from './inbox/types';

export interface Env {
  DB: D1Database;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  SHOPIFY_APP_URL: string;
  SHOPIFY_SCOPES: string;
  PAWSCOUT_MASTER_KEY: string; // base64, 32 bytes
  // CJ egress relay (relay/ on Fly.io) - optional: absent = direct CJ calls
  // (fine locally, 429s in production: CJ caps 3 API users per source IP).
  CJ_RELAY_URL?: string;
  // Storefront overseas cards + overseas ghost-click imports (inquiry sourcing
  // part D): "on" only once the theme shows the overseas note; see overseasFlag.
  OVERSEAS_STOREFRONT?: string;
  CJ_RELAY_TOKEN?: string;
  // OpenRouter (W3 LLM curation) - optional: absent = mechanical gates only.
  OPENROUTER_API_KEY?: string;
  // eBay Browse API (zero-LLM competitor market lookup, 2026-07-10) - optional:
  // absent = market source dormant; competitor research keeps the legacy LLM+web path.
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
  // Blotato social posting rail (blog distribution phase 1, 2026-07-11) - optional:
  // absent = syndication rail dormant (ledger rows queue; console shows not connected).
  // $29/mo vendor with a 90-day earn-it review; see the 2026-07-11 spec's exit path.
  BLOTATO_API_KEY?: string;
  // OpenAI direct (LLM-centralization last-resort floor, gpt-5.4-mini) - optional:
  // absent = OpenAI tier skipped (OpenRouter tiers + mechanical degradation remain).
  OPENAI_API_KEY?: string;
  // Firecrawl - optional: scrapes CJ's website search for diagnostics /
  // higher-quality supply (absent = feature off).
  FIRECRAWL_API_KEY?: string;
  // Resend (W5 email + owner alerts) - optional: absent = email features off.
  RESEND_API_KEY?: string;
  // W-INBOX-1 safety-net forward: owner's verified Email Routing destination.
  // Unset = no forward (stop forwarding once capture is trusted).
  INBOX_FORWARD_TO?: string;
  // Freight-grounded delivery replies (Task [7]): a representative CJ variant id
  // quoted as a proxy for "a typical small pet item" when a customer asks about
  // international shipping. UNSET = feature dormant (drafter keeps the safe hedge).
  // Orchestrator sets this to a real flagship vid to activate. See src/inbox/freight.ts.
  INBOX_FREIGHT_REP_VID?: string;
  // Retention reorder reminders (affiliate 1.3). UNSET/'' = DORMANT (built but
  // never emails customers). Set to '1' or 'true' to activate live sending -
  // a separate explicit go, and only after checkout marketing-consent capture
  // is confirmed (we send only to emailMarketingConsent SUBSCRIBED regardless).
  RETENTION_REORDER_ENABLED?: string;
  // Cloudflare Turnstile (affiliate self-serve marketplace, Stage 0 bot gate) -
  // optional, like FIRECRAWL_API_KEY. Server-side secret for siteverify.
  // MANDATORY once cfg.selfServe.enabled is true: the apply route hard-fails
  // (never silently skips) when this is unset - see src/affiliate/apply.ts.
  TURNSTILE_SECRET?: string;
  // Turnstile's client-side widget key - PUBLIC, not sensitive (safe to ship in
  // rendered HTML). Absent = the apply form renders with an empty sitekey (the
  // widget will not validate) until the owner sets it, same dark-by-default
  // posture as the rest of selfServe.
  TURNSTILE_SITE_KEY?: string;
  // Deploy safety (2026-09-18), both reported by /healthz (src/health.ts).
  // GIT_SHA is the commit label the guarded deploy script injects with --var;
  // ABSENT means this Worker was deployed some other way (`deploy:raw`), and
  // /healthz then says 'unknown' rather than guessing. ENVIRONMENT is
  // 'production' or 'staging', set per environment in wrangler.toml.
  GIT_SHA?: string;
  ENVIRONMENT?: string;
}

export interface TenantRow {
  shop: string;
  access_token_enc: string;
  dek_wrapped: string;
  scopes: string;
  status: string;
  installed_at: string;
  updated_at: string;
}

export interface Gates {
  popularityFloor: number; // CJ listedNum
  priceMin: number;
  priceMax: number;
  relevance: 'loose' | 'title' | 'strict';
}

/**
 * Pricing rule: landed USD supplier cost → GBP retail.
 * Defaults target ~17% net under the researched cost stack
 * (ads ~33% of revenue at ROAS 3, payments ~2.5%, FX, refunds, fixed).
 */
export interface Pricing {
  multiplier: number;   // retail = landed cost × multiplier
  floor: number;        // hard minimum multiplier
  minMarginGbp: number; // absolute margin floor per unit
  fxUsdToGbp: number;   // configured conversion rate
  fxBufferPct: number;  // safety buffer on conversion, in percent
  // Optional absolute margin CAP per unit - the mirror of minMarginGbp. Above the
  // crossover cost (cap / (multiplier - 1)) the effective multiplier glides down
  // hyperbolically (1 + cap/cost): a smooth high-end taper with no band edges, so
  // big-ticket items are not priced far above their visible street price. Absent
  // or null = no cap (exact legacy behaviour). Validation requires it to sit
  // strictly above minMarginGbp so the two clauses can never fight.
  maxMarginGbp?: number;
}

/** Inventory floors. Goals the crons work toward - never bypass gates to hit them. */
export interface Floors {
  warehouseDepth: number; // PS-local warehouse: products held per category
  storeFloor: number;     // Shopify store: minimum listed per category (W2)
  stockFloor: number;     // CJ units required to admit/sell a product
}

export interface ModelsConfig {
  image?: string;    // OpenRouter slug; blank → CURATED_MODELS[0] (menu head)
  text?: string;     // OpenRouter slug; blank → CURATED_MODELS[0]
  fallback?: string; // OpenRouter slug; blank → omitted from the models[] array
}

/**
 * LLM behavioral config. Model SELECTION lives in `models` (one dashboard block);
 * `enabled`/`scoreThreshold` are the behavioral knobs. Disabled (or no key) =
 * mechanical gates only - the system never depends on the LLM to function.
 */
export interface LlmConfig {
  enabled: boolean;
  scoreThreshold: number; // 0-100: minimum relevance score to admit
  models: ModelsConfig;
}

/**
 * W-FULFIL Stage B fulfilment ownership (per-tenant; white-label toggle):
 *  - 'manual'   - PawScout queues orders only; you pay/fulfil by hand. (default, safe)
 *  - 'pawscout' - PawScout owns fulfilment end-to-end (create + pay + track). The
 *                 money leg. REQUIRES CJ's native Shopify order-import to be OFF
 *                 for this store, or you get duplicate CJ orders.
 *  - 'cj'       - CJ's own Shopify app owns fulfilment; PawScout stays out (no
 *                 create/pay/track) and just shows orders for visibility.
 */
export type FulfilMode = 'manual' | 'pawscout' | 'cj';
export interface Fulfil {
  mode: FulfilMode;
  // createOnly: in 'pawscout' mode, PS creates the CJ order but does NOT pay it
  // (the wallet may be unfunded). The order is left 'awaiting-payment' with its
  // cj_order_id set; the owner pays it manually in CJ and the tracking poll then
  // writes the shipment back. A safety net also kicks in when payBalance fails
  // for insufficient balance even with createOnly off.
  createOnly?: boolean;
  // alertEmail: owner address that gets an email each time an order is created in
  // CJ and is awaiting payment (so the owner can pay it ASAP). Empty = no email.
  alertEmail?: string;
  // logistics: policy knobs for the synced CJ delivery-time matrix (door-to-door
  // model). OPTIONAL + read via resolveLogistics() with per-field defaults - never
  // rely on the one-level DEFAULT_FULFIL merge to fill a nested object.
  logistics?: Partial<LogisticsConfig>;
  // gbFreeUkLive: the verify-then-flip gate for "free UK delivery". The shipping
  // agent may state free UK delivery for a GB-warehoused item to GB ONLY when this
  // is true, which the owner flips ONLY after a live GB-item-to-UK checkout is
  // verified at GBP 0 (Phase 1 cutover). Default OFF (absent) = never claimed.
  gbFreeUkLive?: boolean;
  // shipFx: conservative USD->GBP multiplier applied to CJ freight to set the GBP shipping
  // charge (default 0.82). shipHandlingGbp: flat handling added per shipment (default 0).
  shipFx?: number;
  shipHandlingGbp?: number;
  // servedCountries: ISO-2 destinations the signature delivery profiles offer zones for.
  // Default = LOGISTICS_DESTINATIONS (the set the CJ logistics sync already populates); a
  // destination with no real route is omitted per-signature (checkout blocked there).
  servedCountries?: string[];
}

/**
 * Door-to-door delivery model for the synced CJ logistics matrix. CJ logisticAging
 * is transit-only (calendar days); processing is CJ policy (~2-5d incl. sourced/POD)
 * and customs/slack are conservative pads so the customer-facing band never
 * under-promises. ALL values are CALENDAR days. See docs/superpowers/specs/
 * 2026-06-21-cj-logistics-store-design.md.
 */
export interface LogisticsConfig {
  processingDaysMin: number;
  processingDaysMax: number;
  customsDaysMax: number;   // applied only on cross-border routes (from !== to)
  transitSlackDays: number; // outward pad on the upper bound
  stalenessHours: number;   // a matrix row older than this reads as missing (hedge)
}
export const DEFAULT_LOGISTICS: LogisticsConfig = {
  processingDaysMin: 2, processingDaysMax: 5, customsDaysMax: 5, transitSlackDays: 2, stalenessHours: 72,
};

export interface TenantConfig {
  collectionMap: Record<string, { handle: string; tag: string }>;
  gates: Gates;
  pricing: Pricing;
  floors: Floors;
  llm: LlmConfig;
  addons: Addons;
  fulfil: Fulfil;
  inbox: InboxConfig;
  // Always populated by getConfig (DB '{}' default + DEFAULT_SEMANTIC merge); optional
  // so callers/tests building a partial TenantConfig need not all set it. Read it via
  // the semantic library's own default-guard, never assume presence on a hand-built cfg.
  semantic?: SemanticConfig;
  // Profitability gate config. Always populated by getConfig ('{}' default +
  // DEFAULT_PROFIT merge); optional on hand-built cfgs. Read via DEFAULT_PROFIT guard.
  profit?: ProfitConfig;
  // Blog syndication config. Always populated by getConfig ('{}' default +
  // mergeSyndicate); optional on hand-built cfgs. Read via mergeSyndicate guard.
  syndicate?: SyndicateConfig;
  // Affiliate self-serve marketplace config (2026-07-12). NOT wired into
  // getConfig/tenant_config by this task - it is a type + default only, ready
  // for a later task to persist and expose an owner toggle. Read via
  // `cfg.selfServe ?? DEFAULT_SELF_SERVE`, same guard style as `profit`/`semantic`.
  selfServe?: SelfServeConfig;
  target: number;
}

export { DEFAULT_INBOX } from './inbox/types';

// popularityFloor: CJ listedNum is SMALL-VALUED in practice (max ~5 across a
// typical 40-item search) - it counts listing merchants. 1 = "someone else
// stocks this"; W3's LLM curation is the real quality gate.
/** W-ADDON: hidden basket-filler lane - cheap, LLM-curated, capped pool. */
export interface Addons { enabled: boolean; priceMinUsd: number; priceMaxUsd: number; poolSize: number; suppressFromBrowse: boolean }

export const DEFAULT_GATES: Gates = { popularityFloor: 1, priceMin: 5, priceMax: 80, relevance: 'title' };
export const DEFAULT_PRICING: Pricing = { multiplier: 2.5, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2 };
export const DEFAULT_FLOORS: Floors = { warehouseDepth: 20, storeFloor: 8, stockFloor: 10 };
export const DEFAULT_LLM: LlmConfig = { enabled: true, scoreThreshold: 60, models: {} };
// 12 = display cap of the storefront grid (4×3): show what we can sell, never pad.
export const DEFAULT_ADDONS: Addons = { enabled: true, priceMinUsd: 0.5, priceMaxUsd: 5, poolSize: 12, suppressFromBrowse: true };
/** Pet semantic term library: query/sourcing term expansion, per collection. */
export interface SemanticConfig { enabled: boolean; maxExpansions: number; ttlDays: number; excludeCollections: string[] }
export const DEFAULT_SEMANTIC: SemanticConfig = { enabled: true, maxExpansions: 8, ttlDays: 30, excludeCollections: ['more-to-love'] };

/**
 * Profitability gate config. Ships DORMANT (enabled=false): the import gate and
 * the nightly audit stage are no-ops until the owner flips it on. Two knobs
 * separate OBSERVE from ENFORCE - `enabled` turns on the observe audit + a
 * REVIEW-mode import gate (sub-floor items import as drafts, never rejected);
 * `hardBlock` then turns on actual REJECT. Fee rates are the researched cost
 * stack the pricing multiplier was sized for. All values owner-tunable in
 * tenant_config.profit. See docs/superpowers/specs/2026-07-09-profitability-engine-design.md.
 */
export interface ProfitConfig {
  enabled: boolean;                  // master switch; false = fully dormant (no spend, gate no-ops)
  /** Gates the LIVE reprice sweep ONLY. `enabled` gates the ADMISSION gates
   *  (import + storefront search). Split 2026-07-31: both used to ride on
   *  `enabled`, so stopping the sweep also disabled admission - and after the
   *  agent lost its archive authority, the sweep and the gates have genuinely
   *  different risk profiles and deserve separate switches. Undefined means
   *  ON, so existing saved configs keep their current behaviour. */
  repriceEnabled?: boolean;
  // Preview mode for the ACTIVE agent. true = compute + record every intended
  // action (reprice/drop) WITHOUT touching prices or listings, so the owner sees
  // exactly what full-auto would do. false = full auto (execute on defensible data).
  // First-enable must WRITE this true explicitly (getConfig merges saved JSON over
  // DEFAULT_PROFIT, so a saved profit block's dryRun wins over the default).
  dryRun: boolean;
  hardBlock: boolean;                // enforce: import gate REJECTs a sub-floor product (else imports it as a review draft)
  competitionCheckOnImport: boolean; // add the LLM+web competitor check to the sync import path (default off; audit always runs it)
  adShareOfRevenue: number;          // ad spend as a fraction of GROSS retail (0.33 = ROAS 3)
  paymentsFeeRate: number;           // payment processing, on gross (~0.025)
  refundReserveRate: number;         // refund reserve, on ex-VAT revenue (~0.03)
  vatRate: number;                   // UK VAT included in the sticker (0.20)
  minNetAfterAdsGbp: number;         // per-unit net-after-ads floor, GBP
  minNetMarginPct: number;           // net as a fraction of ex-VAT revenue floor
  competitionTolerancePct: number;   // how far above the cheapest competitor we may sit before "won't sell"
  cacheTtlDays: number;              // competitor-signal cache TTL
  // Event/promo discount cost. A blended revenue haircut: on average, codes
  // (WELCOME10, event vouchers) reduce the price paid by this fraction across all
  // sales. Tunable to the store's promo calendar.
  expectedDiscountRate: number;      // average discount as a fraction of revenue (e.g. 0.05)
  // Fixed overhead (Shopify plan, apps, domain, email) allocated per sale as a
  // fraction of revenue. Owner rule: EVERY expense that affects net profit counts.
  fixedOverheadRate: number;         // fixed overhead as a fraction of revenue (e.g. 0.02)
  // How far BELOW the competitor's delivered price to aim when repricing, so we
  // win as the cheaper newcomer (not just a penny under). e.g. 0.05 => a GBP25
  // competitor targets ~GBP23.99. Applied then rounded to a .99 strictly below market.
  undercutPct: number;
  // Affiliate commission cost. Commission is only paid on the SHARE of sales that
  // come through an affiliate link, so it is a blended expense like ad spend:
  // affiliateSalesShare x (commission on ex-VAT revenue + platform fee on gross).
  // Rates mirror the affiliate-eligibility floor (DEFAULT_AFFILIATE_FLOOR).
  affiliateSalesShare: number;       // fraction of sales made via an affiliate (0..1)
  affiliateCommissionRate: number;   // commission on ex-VAT revenue for those sales (0.08)
  affiliatePlatformFeeRate: number;  // affiliate-platform fee on gross for those sales (0.02)
}
// DORMANT + discriminating defaults. adShareOfRevenue 0.33 is the researched
// worst case (ROAS 3, 100% paid acquisition on GROSS retail). At the live 2.2x
// multiplier per-unit net is thin, so the floor defaults to 0: observe mode
// flags only per-unit MONEY-LOSERS (the high-cost, margin-capped auto-feeder
// class that goes negative once ads are charged), not thin-but-positive items.
// The owner tunes two levers after seeing the observe output: lower
// adShareOfRevenue toward their real BLENDED acquisition cost (organic/repeat/
// affiliate sales carry no ad cost), and/or raise minNetAfterAdsGbp to demand a
// real per-unit cushion.
export const DEFAULT_PROFIT: ProfitConfig = {
  enabled: false, dryRun: true, hardBlock: false, competitionCheckOnImport: false,
  adShareOfRevenue: 0.33, paymentsFeeRate: 0.025, refundReserveRate: 0.03, vatRate: 0.20,
  minNetAfterAdsGbp: 2, minNetMarginPct: 0, competitionTolerancePct: 0.15, cacheTtlDays: 14,
  expectedDiscountRate: 0.05, fixedOverheadRate: 0.02, undercutPct: 0.05,
  affiliateSalesShare: 0.15, affiliateCommissionRate: 0.08, affiliatePlatformFeeRate: 0.02,
};
/** Blog syndication (2026-07-11 design): per-channel distribution config.
 * Ships DORMANT: every channel disabled until the owner configures it in the
 * console, and `auto` is a separate per-channel switch (all false at first),
 * the same preview-to-full-auto ramp as the profitability agent. `digest` is
 * consumed by phase 3 (email digest cadence); stored now so the block shape
 * is stable. See docs/superpowers/specs/2026-07-11-blog-distribution-design.md. */
export interface SyndicateChannelConfig {
  enabled: boolean;   // configured + participating (ledger rows get created)
  auto: boolean;      // fire on publish without an owner click
  accountId?: string; // Blotato connected-account id
  boardId?: string;   // pinterest only
  pageId?: string;    // facebook only
}
export interface SyndicateConfig {
  channels: {
    pinterest: SyndicateChannelConfig;
    facebook: SyndicateChannelConfig;
    instagram: SyndicateChannelConfig;
  };
  digest: { mode: 'weekly' | 'per-post' };
}
export type SyndicateChannelKey = keyof SyndicateConfig['channels'];
export const SYNDICATE_CHANNEL_KEYS: readonly SyndicateChannelKey[] = ['pinterest', 'facebook', 'instagram'];
export const DEFAULT_SYNDICATE: SyndicateConfig = {
  channels: {
    pinterest: { enabled: false, auto: false },
    facebook: { enabled: false, auto: false },
    instagram: { enabled: false, auto: false }
  },
  digest: { mode: 'weekly' }
};
/** Two-level default merge for the stored tenant_config.syndicate blob (a
 * partial saved block must not erase sibling channels or the digest mode). */
export function mergeSyndicate(rawJson: string | null | undefined): SyndicateConfig {
  let raw: { channels?: Record<string, Partial<SyndicateChannelConfig>>; digest?: Partial<SyndicateConfig['digest']> } = {};
  try { raw = JSON.parse(rawJson || '{}') ?? {}; } catch { raw = {}; }
  const ch = (k: SyndicateChannelKey): SyndicateChannelConfig => ({ ...DEFAULT_SYNDICATE.channels[k], ...(raw.channels?.[k] ?? {}) });
  return {
    channels: { pinterest: ch('pinterest'), facebook: ch('facebook'), instagram: ch('instagram') },
    digest: { ...DEFAULT_SYNDICATE.digest, ...(raw.digest ?? {}) }
  };
}
// fulfilment mode 'manual' by default - Stage B never spends until set to 'pawscout'.
export const DEFAULT_FULFIL: Fulfil = { mode: 'manual' };
export const DEFAULT_TARGET = 12;

/**
 * Affiliate self-serve marketplace config (2026-07-12): the fully-automated
 * signup funnel (apply -> screen -> auto-issue) ships DARK behind `enabled`.
 * The remaining knobs are daily safety caps + the screening bar, all owner-
 * tunable once enabled. See docs/superpowers/sdd/task-1-brief.md.
 */
export interface SelfServeConfig {
  enabled: boolean;                 // master switch; false = the whole funnel is dormant
  autoIssueCapPerDay: number;       // max vouchers auto-issued per day, across all applicants
  screenSpendCapGbpPerDay: number;  // max LLM screening spend per day, GBP
  scoreThreshold: number;           // minimum screen score to qualify for auto-issue
  starterUsageLimit: number;        // usage_limit set on an auto-issued starter voucher
}
export const DEFAULT_SELF_SERVE: SelfServeConfig = {
  enabled: false, autoIssueCapPerDay: 5, screenSpendCapGbpPerDay: 2, scoreThreshold: 8, starterUsageLimit: 15,
};

// Affiliate commission clearance hold (owner decision 2026-07-14): a tracked
// order's commission only becomes RELEASABLE (payable, and shown as "available"
// to the partner) once this many days have passed since the order, so it has
// cleared the customer's return window and can no longer be refunded. Refunds
// during the hold already zero the commission via the live recompute, so
// anything that survives to its clearance date is a genuinely cleared sale.
// Single source of truth for BOTH the payout/portal/console gating (tenant-store)
// and the customer-facing copy (partnership.ts, affiliate/apply.ts), so the
// number and the promise can never drift. ~45 days comfortably covers supplier
// delivery time plus the 30-day faulty-return window.
export const COMMISSION_CLEARANCE_DAYS = 45;

export const ACTIVE_PAW_COLLECTION_MAP: TenantConfig['collectionMap'] = {
  'pet-cleaning': { handle: 'pet-cleaning', tag: 'cj-pet-cleaning' },
  'pet-accessories': { handle: 'pet-accessories', tag: 'cj-pet-accessories' },
  'pet-health': { handle: 'pet-health', tag: 'cj-pet-health' },
  'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' },
  'pet-grooming': { handle: 'pet-grooming', tag: 'cj-pet-grooming' },
  'more-to-love': { handle: 'more-to-love', tag: 'cj-pet-more-to-love' }
};
