-- A product the supplier has stopped answering about.
--
-- Measured 2026-09-20: six imported products had carried the same stock and
-- the same supplier stamps for days to weeks, four of them still on sale. For
-- each, BOTH nightly supplier reads (product detail and stock) were failing,
-- and the inventory sync treats "no answer" as "leave everything alone". That
-- rule is right for one bad night (a broken endpoint must never zero the
-- store) and wrong for ever: a product the supplier has dropped stays on sale
-- on its last known figures with nobody told.
--
-- These columns let the sync tell the two apart by counting:
--   supplier_silent_nights   consecutive UTC days on which both reads failed
--                            for this product WHILE the supplier answered about
--                            at least one other product in the same run (so an
--                            outage or a lost login never counts)
--   supplier_silent_day      the UTC date (YYYY-MM-DD) last counted, so several
--                            runs on one day count as one night
--   supplier_silent_alerted  1 once the owner has been told about the pause;
--                            stays 0 until a notice is actually sent
-- All three go back to their defaults on the first answer from the supplier.
ALTER TABLE product_links ADD COLUMN supplier_silent_nights INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_links ADD COLUMN supplier_silent_day TEXT;
ALTER TABLE product_links ADD COLUMN supplier_silent_alerted INTEGER NOT NULL DEFAULT 0;
