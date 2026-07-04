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
  CJ_RELAY_TOKEN?: string;
  // OpenRouter (W3 LLM curation) - optional: absent = mechanical gates only.
  OPENROUTER_API_KEY?: string;
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
// fulfilment mode 'manual' by default - Stage B never spends until set to 'pawscout'.
export const DEFAULT_FULFIL: Fulfil = { mode: 'manual' };
export const DEFAULT_TARGET = 12;

export const ACTIVE_PAW_COLLECTION_MAP: TenantConfig['collectionMap'] = {
  'pet-cleaning': { handle: 'pet-cleaning', tag: 'cj-pet-cleaning' },
  'pet-accessories': { handle: 'pet-accessories', tag: 'cj-pet-accessories' },
  'pet-health': { handle: 'pet-health', tag: 'cj-pet-health' },
  'pet-toys': { handle: 'pet-toys', tag: 'cj-pet-toys' },
  'pet-grooming': { handle: 'pet-grooming', tag: 'cj-pet-grooming' },
  'more-to-love': { handle: 'more-to-love', tag: 'cj-pet-more-to-love' }
};
