export interface Env {
  DB: D1Database;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  SHOPIFY_APP_URL: string;
  SHOPIFY_SCOPES: string;
  PAWSCOUT_MASTER_KEY: string; // base64, 32 bytes
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

export interface TenantConfig {
  collectionMap: Record<string, { handle: string; tag: string }>;
  gates: Gates;
  target: number;
}

export const DEFAULT_GATES: Gates = { popularityFloor: 50, priceMin: 5, priceMax: 80, relevance: 'title' };

export const ACTIVE_PAW_COLLECTION_MAP: TenantConfig['collectionMap'] = {
  'pet-cleaning': { handle: 'pet-cleaning', tag: 'cj-cat-pet-cleaning' },
  'pet-accessories': { handle: 'pet-accessories', tag: 'cj-cat-pet-accessories' },
  'pet-health': { handle: 'pet-health', tag: 'cj-cat-pet-health' },
  'pet-toys': { handle: 'pet-toys', tag: 'cj-cat-pet-toys' },
  'more-to-love': { handle: 'more-to-love', tag: 'cj-cat-more-to-love' }
};
