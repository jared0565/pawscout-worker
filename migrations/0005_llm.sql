-- W3: LLM curation via OpenRouter. Config + per-call usage/cost log.

ALTER TABLE tenant_config ADD COLUMN llm TEXT NOT NULL DEFAULT '{}';

CREATE TABLE llm_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  shop              TEXT NOT NULL,
  task              TEXT NOT NULL,   -- curation | keyword | digest
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_llm_usage_shop_time ON llm_usage (shop, created_at);
