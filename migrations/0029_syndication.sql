-- Blog distribution phase 1 (2026-07-11 design): per-post creative pack +
-- per-channel send ledger. UNIQUE(shop, post_id, channel) via the ledger PK is
-- THE idempotency guarantee - a re-run sweep can never double-post. Statuses:
-- queued (awaiting send) | sent (accepted by Blotato, pending confirmation) |
-- published (confirmed live) | failed | skipped. tenant_config gains the
-- 'syndicate' block (channel toggles), merged over DEFAULT_SYNDICATE on read.
CREATE TABLE syndication_packs (
  shop             TEXT NOT NULL,
  post_id          TEXT NOT NULL,           -- blog_post_drafts.id
  article_handle   TEXT,                    -- live article handle at pack time (URL building)
  captions_json    TEXT NOT NULL,           -- validated SyndicationCopy JSON
  pin_image_url    TEXT,                    -- Blotato-hosted mirror of the article hero
  square_image_url TEXT,                    -- phase 2 (composed creative), null in phase 1
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (shop, post_id)
);

CREATE TABLE syndication_ledger (
  shop        TEXT NOT NULL,
  post_id     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  external_id TEXT,                          -- Blotato postSubmissionId
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (shop, post_id, channel)
);

ALTER TABLE tenant_config ADD COLUMN syndicate TEXT NOT NULL DEFAULT '{}';
