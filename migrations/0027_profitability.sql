-- Profitability engine (2026-07-09): per-product net-after-ads + competition
-- verdicts from the observe-first audit, and the dormant profit config block on
-- tenant_config. product_profit is one row per product (verdict in
-- pass|review|reject). The profit config rides the '{}' column default +
-- getConfig's DEFAULT_PROFIT merge, exactly like addons/fulfil/semantic.

CREATE TABLE product_profit (
  shop                  TEXT NOT NULL,
  cj_pid                TEXT NOT NULL,
  verdict               TEXT NOT NULL DEFAULT 'pass',   -- pass | review | reject
  net_gbp               REAL,                            -- worst-variant net after ads, GBP
  net_pct               REAL,                            -- net as a fraction of ex-VAT revenue
  our_retail_gbp        REAL,                            -- our from-price (min sticker)
  competitor_gbp        REAL,                            -- LLM+web UK street estimate (nullable)
  competitor_confidence TEXT,                            -- high | medium | low (nullable)
  competitor_sources    TEXT,                            -- JSON array of source names (nullable)
  reason                TEXT NOT NULL DEFAULT '',
  checked_at            TEXT NOT NULL,
  PRIMARY KEY (shop, cj_pid)
);
CREATE INDEX idx_product_profit_shop ON product_profit (shop, verdict);

ALTER TABLE tenant_config ADD COLUMN profit TEXT NOT NULL DEFAULT '{}';
