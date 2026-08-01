-- Why a product is not in the catalog.
--
-- Measured 2026-08-01: product_links held 270 rows in state 'failed' against 48
-- live, 92 of them added that day. But 'failed' is written from SEVEN different
-- places in src/proxy/import.ts - six are the admission gate doing its job
-- (relevance, pet-relevance, image congruence, local stock, stock floor, profit
-- floor) and one is an unhandled exception. Nothing distinguished them: there
-- was no reason column and no product_events row, so "is the gate protecting
-- our margin, or are imports crashing?" could not be answered from the data at
-- all. Worker log retention had already closed the window on the history.
--
-- That gap matters more since the owner's ruling of the same day made admission
-- gating the primary control on what enters the catalog. It is now the
-- load-bearing part of the architecture, and it was the only part with no
-- instrumentation.
--
-- Nullable with no default and no backfill ON PURPOSE: the existing 270 rows
-- genuinely have an unknown reason, and inventing one would be worse than
-- leaving it null. The column becomes meaningful going forward.
ALTER TABLE product_links ADD COLUMN fail_reason TEXT;

-- Supports the funnel roll-up (GROUP BY fail_reason over failed rows) without
-- scanning the whole table as the reject pile grows.
CREATE INDEX IF NOT EXISTS idx_product_links_fail_reason
  ON product_links (shop, state, fail_reason);
