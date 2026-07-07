-- 0026_blog_post_assets.sql
-- Record the "Shop this guide" product handles and the auto-picked hero image
-- the blog pipeline / enrich pass chose for each post, so a later D1 read can
-- confirm exactly what was set on the Shopify article (verification without an
-- Admin API read from the shell).

ALTER TABLE blog_post_drafts ADD COLUMN related_handles_json TEXT;
ALTER TABLE blog_post_drafts ADD COLUMN hero_image_url TEXT;
ALTER TABLE blog_post_drafts ADD COLUMN hero_source_handle TEXT;
