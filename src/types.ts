export interface Env {
  DB: D1Database;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  SHOPIFY_APP_URL: string;
  SHOPIFY_SCOPES: string;
  PAWSCOUT_MASTER_KEY: string; // base64, 32 bytes
  // CJ egress relay (relay/ on Fly.io) — optional: absent = direct CJ calls
  // (fine locally, 429s in production: CJ caps 3 API users per source IP).
  CJ_RELAY_URL?: string;
  CJ_RELAY_TOKEN?: string;
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
}

export interface TenantConfig {
  collectionMap: Record<string, { handle: string; tag: string }>;
  gates: Gates;
  pricing: Pricing;
  target: number;
}

// popularityFloor: CJ listedNum is SMALL-VALUED in practice (max ~5 across a
// typical 40-item search) — it counts listing merchants. 1 = "someone else
// stocks this"; W3's LLM curation is the real quality gate.
export const DEFAULT_GATES: Gates = { popularityFloor: 1, priceMin: 5, priceMax: 80, relevance: 'title' };
export const DEFAULT_PRICING: Pricing = { multiplier: 2.5, floor: 2.2, minMarginGbp: 6, fxUsdToGbp: 0.78, fxBufferPct: 2 };
// 12 = display cap of the storefront grid (4×3): show what we can sell, never pad.
export const DEFAULT_TARGET = 12;

export const ACTIVE_PAW_COLLECTION_MAP: TenantConfig['collectionMap'] = {
  'pet-cleaning': { handle: 'pet-cleaning', tag: 'cj-cat-pet-cleaning' },
  'pet-accessories': { handle: 'pet-accessories', tag: 'cj-cat-pet-accessories' },
  'pet-health': { handle: 'pet-health', tag: 'cj-cat-pet-health' },
  'pet-toys': { handle: 'pet-toys', tag: 'cj-cat-pet-toys' },
  'more-to-love': { handle: 'more-to-love', tag: 'cj-cat-more-to-love' }
};
