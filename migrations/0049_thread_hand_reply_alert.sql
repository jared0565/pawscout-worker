-- Once-per-thread "reply by hand" owner alert (design 2026-11-19, 2a):
-- set by TenantStore.claimHandReplyAlert only while NULL, so the alert fires once.
ALTER TABLE inbox_threads ADD COLUMN hand_reply_alert_at TEXT;
