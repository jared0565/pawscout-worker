-- W-INBOX-2: AI-drafted replies. One row per drafted reply to a thread.
CREATE TABLE inbox_drafts (
  shop               TEXT NOT NULL,
  id                 TEXT NOT NULL,                 -- uuid
  thread_id          TEXT NOT NULL,
  body_text          TEXT NOT NULL,
  body_html          TEXT NOT NULL,                 -- built from escaped body_text (safe)
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|approved|sent|auto_sent|discarded|superseded
  confidence         INTEGER,                       -- 0-100
  quotes_price_order INTEGER NOT NULL DEFAULT 0,    -- 0/1 (LLM flag OR mechanical money match)
  hold_reasons       TEXT,                          -- JSON array; why auto-send was withheld
  model              TEXT,
  created_at         TEXT NOT NULL,
  sent_at            TEXT,
  sent_message_id    TEXT,
  PRIMARY KEY (shop, id)
);
CREATE INDEX idx_inbox_drafts_thread ON inbox_drafts (shop, thread_id, status);
CREATE INDEX idx_inbox_drafts_status ON inbox_drafts (shop, status, created_at);
