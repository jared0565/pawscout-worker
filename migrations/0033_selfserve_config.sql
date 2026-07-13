-- Affiliate self-serve marketplace, config persistence (2026-07-12, Task 6):
-- Task 1 added the SelfServeConfig TYPE + DEFAULT_SELF_SERVE (src/types.ts)
-- but deliberately did NOT wire it into tenant_config, so selfServe.enabled
-- was permanently the default (false) with no way for the owner to flip it.
-- This migration adds the missing column; src/tenant-store.ts's getConfig()
-- merges it over DEFAULT_SELF_SERVE the same way profit/syndicate/inbox do,
-- and saveSelfServe() persists owner edits from the console.
ALTER TABLE tenant_config ADD COLUMN selfserve TEXT;
