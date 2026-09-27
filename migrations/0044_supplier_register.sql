-- Supplier register and thread readings (owner decision 2026-09-27).
--
-- The 2026-09-26 inbox audit found eight suppliers in three weeks, all filed as
-- "other" and answered by the general drafter, with nothing kept for later.
-- supplier_register holds one row per supplier email, filled from the thread
-- reader's structured reading and never blanked by a later, thinner reading.
-- status and notes belong to the owner and are never written by the worker.
-- dropship is the supplier's own answer to "do you offer dropshipping?":
-- 'unknown' until they say yes or no.
--
-- inbox_threads.reading_json keeps the latest reading of the thread (sender
-- role, open questions, what they offered, whether a reply is due) so the
-- console can show it; read_at is when it was taken.
CREATE TABLE IF NOT EXISTS supplier_register (
  shop TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  contact_name TEXT,
  website TEXT,
  store_links TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'goods',
  product_lines TEXT NOT NULL DEFAULT '[]',
  ships_from TEXT,
  niche_fit TEXT NOT NULL DEFAULT 'adjacent',
  dropship TEXT NOT NULL DEFAULT 'unknown',
  first_thread_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  PRIMARY KEY (shop, email)
);
CREATE INDEX IF NOT EXISTS idx_supplier_register_seen ON supplier_register (shop, last_seen_at);
ALTER TABLE inbox_threads ADD COLUMN reading_json TEXT;
ALTER TABLE inbox_threads ADD COLUMN read_at TEXT;
