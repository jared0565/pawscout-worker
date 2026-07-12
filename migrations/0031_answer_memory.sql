-- Inbox answer memory (2026-07-12): every approved reply becomes a vetted
-- question->answer pair; drafts are grounded with the closest matches
-- (retrieval grounding, never a verbatim cache). PK (shop, qhash) makes the
-- memory self-refreshing: re-answering the same normalized question REPLACES
-- the stored answer with the newest vetted one.
CREATE TABLE answer_memory (
  shop          TEXT NOT NULL,
  qhash         TEXT NOT NULL,
  category      TEXT NOT NULL,
  question_text TEXT NOT NULL,
  question_norm TEXT NOT NULL,
  answer_text   TEXT NOT NULL,
  thread_id     TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  used_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (shop, qhash)
);
CREATE INDEX idx_answer_memory_recall ON answer_memory (shop, disabled, updated_at);
