-- Portal login cooldown (Fix 4, 2026-07-13 final-review fix pass): affiliate_
-- tokens had no created_at column, so there was nothing to check a "was a
-- token for this subject issued recently" cooldown against. handlePortalLogin
-- (src/affiliate/portal.ts) now checks TenantStore.recentUnclaimedToken()
-- before minting+emailing a second 'login' token for the same partner within
-- ~5 minutes. Existing rows backfill NULL, which is the safe direction - a
-- NULL created_at never matches a "since" filter, so old rows simply never
-- suppress a fresh issue.
ALTER TABLE affiliate_tokens ADD COLUMN created_at TEXT;
