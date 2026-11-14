-- Inbound files (owner-approved design 2026-11-14, spec
-- docs/superpowers/specs/2026-11-14-inbox-attachments-and-reply-shell-design.md 5.3).
--
-- Every attachment used to be thrown away at parse, and replies then claimed
-- catalogues we never held. A kept file lives in R2 (binding INBOX_FILES) under
-- inbox/{shop}/{thread_id}/{id}; this table is its record, and also records
-- each part that was NOT kept and why, so the console and the drafter can say
-- so truthfully. filename and content_type are the sender's (untrusted);
-- content_type is never used to serve a file.
CREATE TABLE inbox_attachments (
  shop         TEXT NOT NULL,
  id           TEXT NOT NULL,
  thread_id    TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  status       TEXT NOT NULL,
  r2_key       TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
CREATE INDEX idx_inbox_attachments_thread ON inbox_attachments (shop, thread_id);

-- Erasures still owed in R2. A GDPR redact records the key prefix here in the
-- same D1 batch that deletes the rows (the webhook can never be retried, see
-- gdprWebhook), and the R2 delete is finished by the webhook's waitUntil or by
-- the daily file-erasures stage. One row per prefix.
CREATE TABLE inbox_file_erasures (
  shop       TEXT NOT NULL,
  prefix     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shop, prefix)
);
