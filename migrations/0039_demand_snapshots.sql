-- Demand snapshots: one row per topic-research run, storing the ranked signals.
--
-- Autocomplete tells us what people search for but NOT whether interest is
-- rising or falling, which is the one thing the expensive LLM pass could do
-- ("back-to-routine purchases peak in September-October"). Diffing these
-- snapshots over months recovers that signal deterministically and for free.
--
-- It is written from day one precisely because it CANNOT be backfilled: a
-- snapshot not taken in August is gone. Storage is trivial (a few KB per run,
-- owner-triggered) and nothing reads it yet.
CREATE TABLE IF NOT EXISTS demand_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shop       TEXT NOT NULL,
  mode       TEXT NOT NULL,   -- 'fast' | 'deep', so the two sources stay comparable
  signals    TEXT NOT NULL,   -- JSON DemandSignal[]
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_demand_snapshots_shop_time
  ON demand_snapshots (shop, created_at);
