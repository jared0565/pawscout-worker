-- Flywheel: search backfill, product lifecycle, CJ token cache, pricing config.

ALTER TABLE tenant_config ADD COLUMN pricing TEXT NOT NULL DEFAULT '{}';

-- Cached CJ search results (normalized keyword), 30-day retention.
CREATE TABLE search_cache (
  shop         TEXT NOT NULL,
  cache_key    TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (shop, cache_key)
);

-- Demand signal: every storefront search that hit the backfill path.
CREATE TABLE search_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shop         TEXT NOT NULL,
  keyword_norm TEXT NOT NULL,
  store_hits   INTEGER NOT NULL,
  ghost_hits   INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_search_log_shop_time ON search_log (shop, created_at);

-- CJ product <-> Shopify product mapping and lifecycle state.
-- state: ghost | importing | imported | archived | failed
CREATE TABLE product_links (
  shop               TEXT NOT NULL,
  cj_pid             TEXT NOT NULL,
  shopify_product_id TEXT,
  handle             TEXT,
  category           TEXT,
  state              TEXT NOT NULL DEFAULT 'ghost',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (shop, cj_pid)
);

-- Qualifying events for the 30-day performance cull. event: view | atc | order
CREATE TABLE product_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shop       TEXT NOT NULL,
  cj_pid     TEXT NOT NULL,
  event      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_product_events_lookup ON product_events (shop, cj_pid, created_at);

-- Cached CJ access token (sealed) - CJ allows one auth refresh per 300s.
CREATE TABLE cj_tokens (
  shop         TEXT PRIMARY KEY,
  token_enc    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);
