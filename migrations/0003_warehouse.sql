-- W1: PS-local product warehouse. Searches/previews serve from here;
-- CJ is only touched by paced background jobs. See docs/WAREHOUSE_PLAN.md.

ALTER TABLE tenant_config ADD COLUMN floors TEXT NOT NULL DEFAULT '{}';

-- status: available | low_stock | stale
CREATE TABLE warehouse_products (
  shop             TEXT NOT NULL,
  cj_pid           TEXT NOT NULL,
  category         TEXT,              -- collection key, or NULL (keyword-demand admit)
  title            TEXT NOT NULL,
  detail           TEXT NOT NULL,     -- full normalized CjDetail JSON (incl. stock)
  price_usd        REAL NOT NULL,     -- lowest variant landed cost
  listed_num       INTEGER NOT NULL,
  stock            INTEGER NOT NULL,  -- last known max variant stock at CJ
  search_text      TEXT NOT NULL,     -- lowercase title + category, for matching
  status           TEXT NOT NULL DEFAULT 'available',
  fetched_at       TEXT NOT NULL,     -- last full detail fetch
  stock_checked_at TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (shop, cj_pid)
);
CREATE INDEX idx_warehouse_lookup ON warehouse_products (shop, status, category);
