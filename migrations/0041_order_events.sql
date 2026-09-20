-- Order trail (phase 2): one append-only row per step an order goes through,
-- so a failed or disputed order can be reconstructed and the owner can see what
-- happened without reading logs. `detail` is short plain text and must never
-- hold a name, an address, an email or a phone number.
CREATE TABLE order_events (
  shop              TEXT NOT NULL,
  shopify_order_id  TEXT NOT NULL,
  seq               INTEGER NOT NULL,   -- 1, 2, 3 ... per order
  at                TEXT NOT NULL,      -- ISO time
  kind              TEXT NOT NULL,
  detail            TEXT,
  PRIMARY KEY (shop, shopify_order_id, seq)
);
