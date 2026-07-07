-- Blog content pipeline (2026-07-07): staging record for each post the blog
-- agents author. The Shopify DRAFT article is the real artifact; this row is
-- the worker's bookkeeping - idempotency, the research brief, the fabrication
-- flags surfaced for human review, and the link from topic to live article.
-- Deliberately NOT a copy of the article body (that lives in Shopify).
CREATE TABLE blog_post_drafts (
  shop               TEXT NOT NULL,
  id                 TEXT NOT NULL,               -- uuid
  shopify_article_id TEXT,                        -- gid://shopify/Article/... once created
  blog_handle        TEXT,
  title              TEXT NOT NULL,
  collection_handle  TEXT,                        -- funnel target + article tag
  status             TEXT NOT NULL DEFAULT 'drafted', -- drafted | published | discarded
  brief_json         TEXT,                        -- the research brief (angle/keyword/keyPoints)
  claim_flags_json   TEXT,                        -- fabrication category-flags for human verification
  model              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
