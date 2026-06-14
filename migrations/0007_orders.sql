-- W-FULFIL: order → CJ fulfilment pipeline. One row per Shopify order.
-- status lifecycle: held (failed a guardrail, awaits operator)
--                 | queued (passed validation; auto-submit after fulfil_after)
--                 | submitted (CJ order created + paid; cj_order_id set)
--                 | fulfilled (tracking written back to Shopify)
--                 | cancelled | error
CREATE TABLE orders (
  shop              TEXT NOT NULL,
  shopify_order_id  TEXT NOT NULL,
  order_name        TEXT,                       -- e.g. "#1001"
  total_price       REAL,                        -- order total in `currency`
  currency          TEXT,
  financial_status  TEXT,
  risk_level        TEXT,                        -- LOW | MEDIUM | HIGH (Shopify fraud)
  status            TEXT NOT NULL DEFAULT 'received',
  hold_reasons      TEXT,                        -- JSON array of guardrail failures
  cj_order_id       TEXT,
  tracking_number   TEXT,
  address_json      TEXT,                        -- shipping address (protected data)
  line_items_json   TEXT,                        -- [{productId, variantId, sku, quantity, price, cjPid}]
  fulfil_after      TEXT,                        -- grace-window expiry (auto-submit not before)
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (shop, shopify_order_id)
);
CREATE INDEX idx_orders_status ON orders (shop, status, fulfil_after);
