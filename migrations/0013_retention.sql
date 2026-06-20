-- Retention / reorder reminders (affiliate 1.3). Two per-shop tables:
--   reorder_reminders — one row per order we've reminded against (dedup, so a
--     customer is never nagged twice for the same purchase).
--   email_unsubscribes — email-level opt-out suppression (PECR/GDPR). Once here,
--     the customer is never emailed a reminder again.
-- The feature ships DORMANT (env RETENTION_REORDER_ENABLED unset); these tables
-- stay empty until it is switched on. Apply this migration before enabling.
CREATE TABLE IF NOT EXISTS reorder_reminders (
  shop      TEXT NOT NULL,
  order_id  TEXT NOT NULL,   -- Shopify order GID reminded against
  email     TEXT NOT NULL,   -- normalised lowercase recipient
  sent_at   TEXT NOT NULL,   -- ISO8601
  PRIMARY KEY (shop, order_id)
);
CREATE INDEX IF NOT EXISTS idx_reorder_reminders_shop_email ON reorder_reminders (shop, email);

CREATE TABLE IF NOT EXISTS email_unsubscribes (
  shop            TEXT NOT NULL,
  email           TEXT NOT NULL,   -- normalised lowercase
  unsubscribed_at TEXT NOT NULL,   -- ISO8601
  PRIMARY KEY (shop, email)
);
