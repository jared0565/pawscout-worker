-- Synced weight-INDEPENDENT CJ TRANSIT-time matrix (delivery-time store).
-- ONE row per (shop, from_country, to_country) = freightQuote()[0] (cheapest =
-- what fulfilment books). logisticAging parsed to INT CALENDAR-day min/max at
-- WRITE time; aging_raw kept for audit. NO price column (customer shipping is a
-- flat decoupled card; the pricing floor uses per-variant detail.freightUsd).
-- Shop-scoped for redactShop()/GDPR parity, but rows are FETCHED ONCE/night and
-- FANNED OUT to every shop (transit is shop-invariant).
-- Spec: docs/superpowers/specs/2026-06-21-cj-logistics-store-design.md
CREATE TABLE IF NOT EXISTS cj_logistics (
  shop                 TEXT    NOT NULL,
  from_country         TEXT    NOT NULL,            -- ISO-2 origin ('CN' for this CN-only catalog)
  to_country           TEXT    NOT NULL,            -- ISO-2 destination ('GB' + in-scope markets)
  channel              TEXT    NOT NULL DEFAULT '', -- logisticName of the cheapest option (audit)
  transit_min          INTEGER,                     -- parsed lower bound, CALENDAR days (NULL => no-data => hedge)
  transit_max          INTEGER,                     -- parsed upper bound, CALENDAR days
  aging_raw            TEXT    NOT NULL DEFAULT '', -- original CJ logisticAging string (audit)
  rep_vid              TEXT    NOT NULL DEFAULT '', -- the in-stock vid the quote used (audit/repro)
  synced_at            TEXT    NOT NULL,            -- ISO-8601 of last SUCCESSFUL refresh (THE freshness anchor)
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  created_at           TEXT    NOT NULL,
  PRIMARY KEY (shop, from_country, to_country)
);
CREATE INDEX IF NOT EXISTS idx_cj_logistics_synced ON cj_logistics (shop, synced_at);
