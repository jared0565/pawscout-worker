-- Affiliate voucher trials (2026-07-04): the owner hand-picks a collaborator,
-- issues them an expiring percentage voucher, and pays commission on the face
-- value (pre-discount goods subtotal, ex shipping) of paid orders placed with
-- the code. Attribution rides the 15-minute pipeline via read_orders (already
-- granted); Phase 1 has no write_discounts, so the code itself is created by
-- the owner in Shopify admin and registered here.

-- One row per collaborator (matched by email; a partner can hold several
-- vouchers over time, e.g. a renewal issued as a fresh code).
CREATE TABLE affiliate_partners (
  shop          TEXT NOT NULL,
  id            TEXT NOT NULL,                 -- uuid
  contact_email TEXT NOT NULL,
  name          TEXT,
  channel_url   TEXT,                          -- where they promote (their channel/site)
  status        TEXT NOT NULL DEFAULT 'active',-- active | ended
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
CREATE INDEX idx_affiliate_partners_email ON affiliate_partners (shop, contact_email);

-- One row per issued code. `status` is owner-controlled (live | revoked);
-- expiry is DERIVED from ends_at at read time so no cron has to flip rows.
-- Codes are stored UPPERCASE; matching is case-insensitive.
CREATE TABLE affiliate_vouchers (
  shop           TEXT NOT NULL,
  id             TEXT NOT NULL,                -- uuid
  partner_id     TEXT NOT NULL,
  code           TEXT NOT NULL,
  pct_off        REAL NOT NULL,                -- customer discount, e.g. 5
  commission_pct REAL NOT NULL,                -- partner commission on face value, e.g. 2
  starts_at      TEXT NOT NULL,
  ends_at        TEXT NOT NULL,
  usage_limit    INTEGER,                      -- informational (enforced by Shopify, not here)
  status         TEXT NOT NULL DEFAULT 'live', -- live | revoked
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
CREATE UNIQUE INDEX idx_affiliate_vouchers_code ON affiliate_vouchers (shop, code);

-- Ledger: one row per (order, voucher) the attribution sweep matched. Rows are
-- re-upserted whenever Shopify reports the order updated (refunds, edits), so
-- gross/commission always reflect CURRENT order state; paid_out_at survives
-- re-upserts so payouts are never double-counted.
CREATE TABLE affiliate_orders (
  shop             TEXT NOT NULL,
  shopify_order_id TEXT NOT NULL,
  voucher_id       TEXT NOT NULL,
  order_name       TEXT,                       -- e.g. "#1042"
  gross_gbp        REAL NOT NULL,              -- face value: current subtotal + current discounts
  discount_gbp     REAL NOT NULL,
  commission_gbp   REAL NOT NULL,              -- 0 while ineligible (unpaid/refunded/cancelled)
  financial_status TEXT,
  eligible         INTEGER NOT NULL DEFAULT 0, -- 1 = paid + not cancelled (commission counts)
  placed_at        TEXT,
  paid_out_at      TEXT,                       -- payout stamp (owner's "mark paid")
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (shop, shopify_order_id, voucher_id)
);
CREATE INDEX idx_affiliate_orders_voucher ON affiliate_orders (shop, voucher_id, paid_out_at);
