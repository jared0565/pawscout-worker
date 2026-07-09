-- Active profitability agent (2026-07-09): the runner ACTS (reprice / drop) on
-- live Shopify numbers, so it needs (1) an append-only action ledger and (2) the
-- latest action inline on the per-product state row.

-- Append-only ledger: the reviewable, reversible history of every price move and
-- drop. LOAD-BEARING for drops - an archived product's product_profit row is
-- excluded from the console list, so this ledger is the ONLY surviving record that
-- it was dropped (and why, and from what price). dry_run rows record what full-auto
-- WOULD have done during a preview. Columns: action = reprice|drop|flag|keep;
-- from_gbp/to_gbp = a reprice's move (nullable); competitor_gbp/confidence = the
-- market signal that drove it; dry_run = 1 previewed / 0 executed.
CREATE TABLE profit_actions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  shop                  TEXT NOT NULL,
  cj_pid                TEXT NOT NULL,
  action                TEXT NOT NULL,
  from_gbp              REAL,
  to_gbp                REAL,
  competitor_gbp        REAL,
  competitor_confidence TEXT,
  reason                TEXT NOT NULL DEFAULT '',
  dry_run               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL
);
CREATE INDEX idx_profit_actions_shop ON profit_actions (shop, created_at DESC);

-- Latest action inline on the current-state row so the console renders
-- "repriced GBP X->Y" / "dropped" per product without a join. All nullable: a row
-- the agent has not yet acted on simply has no action.
ALTER TABLE product_profit ADD COLUMN action TEXT;
ALTER TABLE product_profit ADD COLUMN from_gbp REAL;
ALTER TABLE product_profit ADD COLUMN to_gbp REAL;
ALTER TABLE product_profit ADD COLUMN acted_at TEXT;
ALTER TABLE product_profit ADD COLUMN dry_run INTEGER;
