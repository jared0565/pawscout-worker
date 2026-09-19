-- Index for the owner-alert retry sweep's candidate query
-- (listOrderIdsWithPendingAlerts in src/tenant-store.ts), which runs on every
-- tick against a table that only grows.
CREATE INDEX IF NOT EXISTS idx_order_events_shop_kind_at ON order_events (shop, kind, at);
