-- Traffic strategy board (2026-07-05): the console's Traffic view. One row per
-- acquisition channel with its working state, priority and the single next
-- action. Seeded lazily in code on first read (per shop), not here.

CREATE TABLE traffic_channels (
  shop        TEXT NOT NULL,
  id          TEXT NOT NULL,                  -- uuid
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'idea',   -- idea | testing | active | paused
  priority    INTEGER NOT NULL DEFAULT 3,     -- 1 (now) .. 5 (someday)
  rationale   TEXT NOT NULL DEFAULT '',       -- why this channel fits this store
  next_action TEXT NOT NULL DEFAULT '',       -- the one next step
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);

CREATE INDEX idx_traffic_channels_shop ON traffic_channels (shop, priority);
