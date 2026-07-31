-- Completeness stamp for the product-referrer index (2026-07-31).
--
-- WHY THIS IS NOT OPTIONAL. product_referrers is a DERIVED cache whose miss
-- semantics are "unknown", not "unreferenced" (see src/catalog/referrers.ts).
-- But archiveProductGuarded can only observe an EMPTY result, and an empty
-- result from a never-built or half-built index looks exactly like a genuinely
-- unreferenced product. That is a 404 generator aimed at precisely the products
-- this work exists to protect.
--
-- The article lister reads blogs(first:20) x articles(first:100). Real shops
-- outgrow that. runArticleHealth merely LOGS hasNextPage, which is fine for
-- healing (a missed article stays healthy-but-unhealed) and fatal for the index
-- (a missed article silently unblocks an archive).
--
-- So the stage records what it actually managed to read, and the guard refuses
-- to archive at all unless the stamp is present, complete and recent. One row
-- per shop, overwritten each rebuild.
--
-- Deliberately NOT stored in search_cache: that table exists to be evicted
-- (purgeExpiredSearchCache), and a correctness gate must not share a home with
-- rows whose whole purpose is to disappear.
CREATE TABLE referrer_index_stamp (
  shop          TEXT NOT NULL PRIMARY KEY,
  indexed_at    TEXT NOT NULL,   -- ISO8601 of the rebuild that produced the index
  article_count INTEGER NOT NULL,-- articles actually read and indexed
  row_count     INTEGER NOT NULL,-- (handle, referrer) rows written
  truncated     INTEGER NOT NULL -- 1 = a page boundary was hit, index is INCOMPLETE
);
