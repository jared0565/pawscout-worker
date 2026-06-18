CREATE TABLE inbox_invoices (
  shop                   TEXT NOT NULL,
  id                     TEXT NOT NULL,
  thread_id              TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'proposed',
  line_items_json        TEXT NOT NULL,
  currency               TEXT NOT NULL DEFAULT 'GBP',
  total                  REAL NOT NULL,
  cover_text             TEXT,
  confidence             INTEGER,
  hold_reasons           TEXT,
  shopify_draft_order_id TEXT,
  invoice_url            TEXT,
  shopify_order_id       TEXT,
  created_at             TEXT NOT NULL,
  sent_at                TEXT,
  paid_at                TEXT,
  PRIMARY KEY (shop, id)
);
CREATE INDEX idx_inbox_invoices_thread ON inbox_invoices (shop, thread_id, status);
CREATE INDEX idx_inbox_invoices_order  ON inbox_invoices (shop, shopify_order_id);
