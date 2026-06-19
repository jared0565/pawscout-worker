-- Pet semantic term library: shared term -> related-terms map, per collection.
-- Web-seeded (autocomplete) + LLM-cleaned + pet-floor backstop; read by on-site
-- search and CJ sourcing. Per-shop, like every other table.
CREATE TABLE IF NOT EXISTS semantic_terms (
  shop            TEXT NOT NULL,
  collection      TEXT NOT NULL,   -- collection handle; '' for collection-agnostic terms
  term            TEXT NOT NULL,   -- normalized lowercase seed term
  expansions_json TEXT NOT NULL,   -- JSON string[] of pet-clean related terms
  source          TEXT NOT NULL,   -- 'suggest' | 'lazy' | 'manual'
  updated_at      TEXT NOT NULL,   -- ISO8601
  PRIMARY KEY (shop, collection, term)
);
CREATE INDEX IF NOT EXISTS idx_semantic_terms_shop_coll ON semantic_terms (shop, collection);

-- Per-tenant semantic config rides the tenant_config '{}' default + DEFAULT_SEMANTIC merge.
ALTER TABLE tenant_config ADD COLUMN semantic TEXT NOT NULL DEFAULT '{}';
