-- Campaigns (2026-07-05): owner-composed marketing broadcasts to consented
-- audiences (buyers = Shopify emailMarketingConsent SUBSCRIBED, resolved live
-- at send time and never copied; partners = active affiliate_partners who
-- explicitly opted in). campaign_sends is the per-campaign ledger: one row per
-- actual send, so a re-run resumes instead of double-sending.

CREATE TABLE campaigns (
  shop            TEXT NOT NULL,
  id              TEXT NOT NULL,                 -- uuid
  audience        TEXT NOT NULL,                 -- buyers | partners
  subject         TEXT NOT NULL,
  body_text       TEXT NOT NULL,                 -- plain text; html rendered at send
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | sending | sent
  recipient_count INTEGER,                       -- eligible audience size at send time
  sent_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  sent_at         TEXT,                          -- stamped when the last batch completes
  PRIMARY KEY (shop, id)
);

CREATE TABLE campaign_sends (
  shop        TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  email       TEXT NOT NULL,   -- normalised lowercase
  sent_at     TEXT NOT NULL,   -- ISO8601
  PRIMARY KEY (shop, campaign_id, email)
);

-- Partner marketing opt-in (PECR: partnership correspondence lets us reply,
-- not broadcast; individuals on personal addresses need their own opt-in).
-- The owner flips this in the Partners view when the partner says yes.
ALTER TABLE affiliate_partners ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE affiliate_partners ADD COLUMN marketing_consent_at TEXT;
