-- Reverse index: which internal surfaces point at a product handle.
--
-- DERIVED CACHE, never a source of truth. Rebuilt from article bodies, the
-- related_products metafield, and syndication_ledger. A MISS means "unknown"
-- and must BLOCK an archive; it must never be read as "safe to archive".
-- That single rule is what stops this cache becoming the next thing that
-- silently rots (the failure blog/article-health.ts exists to repair).
--
-- referrer_type: blog | syndication | collection
--   blog        - repairable: the article can be rewritten to a live product
--   syndication - NOT repairable: an already-published social post is beyond
--                 our reach forever, so a product it references is refused
--   collection  - curated Shop-this-guide picks
CREATE TABLE product_referrers (
  shop          TEXT NOT NULL,
  handle        TEXT NOT NULL,
  referrer_type TEXT NOT NULL,
  referrer_id   TEXT NOT NULL,
  detected_at   TEXT NOT NULL,
  PRIMARY KEY (shop, handle, referrer_type, referrer_id)
);

CREATE INDEX idx_product_referrers_handle ON product_referrers (shop, handle);
CREATE INDEX idx_product_referrers_source ON product_referrers (shop, referrer_type, referrer_id);
