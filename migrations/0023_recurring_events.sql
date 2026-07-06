-- Recurring events (2026-07-06): which catalogue events the owner has enabled
-- for automatic yearly rotation, plus their percentage override and the
-- occurrence the announcement campaign was last staged for. Deliberately NOT
-- a copy of any dates: windows are computed from the catalogue and live in
-- the Shopify discount once scheduled (the WELCOME10 drift lesson).
CREATE TABLE recurring_events (
  shop        TEXT NOT NULL,
  key         TEXT NOT NULL,              -- catalogue key, e.g. 'summer-bank-holiday'
  enabled     INTEGER NOT NULL DEFAULT 0,
  pct_off     REAL,                       -- NULL = template default
  armed_for   TEXT,                       -- window startsAt the announcement draft was staged for (idempotency cursor)
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (shop, key)
);
