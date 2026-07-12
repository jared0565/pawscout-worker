-- Owner "Keep" override for the Profitability review table (2026-07-12).
-- profit_keep = 1 means the owner has reviewed this product and wants it left
-- exactly as it is: the agent's judge short-circuits to a pass verdict and
-- never reprices, flags or drops it until the owner releases it from the
-- console row. Lives on product_links (the stable per-product row) so it
-- survives verdict wipes ("Clear list & re-judge") and cache expiry.
ALTER TABLE product_links ADD COLUMN profit_keep INTEGER NOT NULL DEFAULT 0;
