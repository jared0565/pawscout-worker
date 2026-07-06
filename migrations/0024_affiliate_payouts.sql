-- Affiliate commission payouts (2026-07-06): the accounting record. One row
-- per payout the owner actually made, with the covered orders SNAPSHOT at
-- payout time (orders_json), so later refunds or edits on the live ledger can
-- never rewrite what was really paid. The money itself moves outside PawScout
-- (PayPal, bank transfer); method + reference document the transaction for
-- accounting and any later dispute.
CREATE TABLE affiliate_payouts (
  shop         TEXT NOT NULL,
  id           TEXT NOT NULL,                 -- uuid, quoted on statements
  voucher_id   TEXT NOT NULL,
  partner_id   TEXT NOT NULL,
  amount_gbp   REAL NOT NULL,                 -- frozen sum of covered commissions
  orders_count INTEGER NOT NULL,
  method       TEXT,                          -- e.g. PayPal, bank transfer
  reference    TEXT,                          -- e.g. the PayPal transaction id
  note         TEXT,
  orders_json  TEXT NOT NULL,                 -- [{id,name,placedAt,gross,discount,commission}] frozen
  created_at   TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
CREATE INDEX idx_affiliate_payouts_voucher ON affiliate_payouts (shop, voucher_id, created_at);

-- Each covered order remembers which payout settled it.
ALTER TABLE affiliate_orders ADD COLUMN payout_id TEXT;
