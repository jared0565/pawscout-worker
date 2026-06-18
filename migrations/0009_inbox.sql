-- W-INBOX-1: email CRM. Inbound mail → contacts + threads + messages.
-- All tenant-keyed (shop). status lifecycle on threads:
--   new | needs_reply | awaiting_customer | converted | closed | spam
ALTER TABLE tenant_config ADD COLUMN inbox TEXT NOT NULL DEFAULT '{}';

CREATE TABLE inbox_contacts (
  shop                TEXT NOT NULL,
  email               TEXT NOT NULL,          -- lowercased
  name                TEXT,
  phone               TEXT,
  shopify_customer_id TEXT,
  message_count       INTEGER NOT NULL DEFAULT 0,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  PRIMARY KEY (shop, email)
);

CREATE TABLE inbox_threads (
  shop             TEXT NOT NULL,
  id               TEXT NOT NULL,             -- uuid
  contact_email    TEXT NOT NULL,
  subject          TEXT,
  subject_norm     TEXT,                      -- Re:-stripped, lowercased (matching)
  status           TEXT NOT NULL DEFAULT 'new',
  primary_category TEXT,
  intent_score     INTEGER,                   -- 0-100, NULL = unclassified
  summary          TEXT,
  classified_at    TEXT,                      -- NULL = needs classification
  last_message_at  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
CREATE INDEX idx_inbox_threads_status ON inbox_threads (shop, status, last_message_at);
CREATE INDEX idx_inbox_threads_match  ON inbox_threads (shop, contact_email, subject_norm);
CREATE INDEX idx_inbox_threads_unclassified ON inbox_threads (shop, classified_at);

CREATE TABLE inbox_messages (
  shop          TEXT NOT NULL,
  id            TEXT NOT NULL,                -- uuid
  thread_id     TEXT NOT NULL,
  direction     TEXT NOT NULL,               -- inbound | outbound
  message_id    TEXT,                         -- RFC Message-ID header (dedup key)
  in_reply_to   TEXT,
  ref_ids       TEXT,                         -- References header, space-joined
  from_addr     TEXT NOT NULL,
  to_addr       TEXT,
  subject       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  headers_json  TEXT,
  received_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
-- NULL message_ids are allowed and treated as distinct by SQLite (dedup only fires when present).
CREATE UNIQUE INDEX idx_inbox_messages_msgid ON inbox_messages (shop, message_id);
CREATE INDEX idx_inbox_messages_thread ON inbox_messages (shop, thread_id, received_at);

CREATE TABLE inbox_thread_labels (
  shop      TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  label     TEXT NOT NULL,
  PRIMARY KEY (shop, thread_id, label)
);
