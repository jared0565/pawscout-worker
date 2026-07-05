-- Email engagement events (2026-07-05): Resend webhook events (delivered /
-- opened / clicked / bounced / complained) stored per shop and correlated back
-- to campaigns and inbox threads via send-time tags. svix_id is the webhook
-- delivery id (stable across Resend's retries of the SAME event), so it is the
-- dedup key; two genuine opens are two events with two svix ids and both rows
-- are kept.

CREATE TABLE email_events (
  shop        TEXT NOT NULL,
  svix_id     TEXT NOT NULL,   -- svix-id header of the webhook delivery
  resend_id   TEXT NOT NULL,   -- data.email_id (the send API's returned id)
  email       TEXT NOT NULL,   -- first recipient, normalised lowercase
  event_type  TEXT NOT NULL,   -- delivered | opened | clicked | bounced | complained | ...
  kind        TEXT,            -- send-time tag: campaign | campaign_test | reply | invoice | retention
  campaign_id TEXT,            -- send-time tag (campaign sends only)
  thread_id   TEXT,            -- send-time tag (inbox replies / invoices)
  link        TEXT,            -- clicked URL (email.clicked only)
  occurred_at TEXT NOT NULL,   -- event timestamp from Resend
  created_at  TEXT NOT NULL,   -- when we stored it
  PRIMARY KEY (shop, svix_id)
);

CREATE INDEX idx_email_events_campaign ON email_events (shop, campaign_id, event_type);
CREATE INDEX idx_email_events_thread ON email_events (shop, thread_id);

-- Correlate ledger rows to Resend message ids for per-recipient analytics.
ALTER TABLE campaign_sends ADD COLUMN resend_id TEXT;
