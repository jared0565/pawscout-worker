-- Affiliate inbound gating (Phase 1): one applicant record per partnership-lane thread.
-- Tracks funnel stage + the deterministic screen verdict. No payout/PII-sensitive data.
CREATE TABLE affiliate_applicants (
  shop            TEXT NOT NULL,
  id              TEXT NOT NULL,                 -- uuid
  thread_id       TEXT NOT NULL,
  contact_email   TEXT NOT NULL,
  stage           TEXT NOT NULL,                 -- screen_sent|screen_answered|passed_to_form|declined|escalated
  declared_intent TEXT,                          -- contact-form Reason (Phase 2); nullable
  verdict_json    TEXT,                          -- ScreenVerdict JSON (facts+score+reasons); nullable
  score           INTEGER,                       -- 0-12; nullable until screened
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (shop, thread_id)
);
CREATE INDEX idx_affiliate_applicants_stage ON affiliate_applicants (shop, stage, updated_at);
