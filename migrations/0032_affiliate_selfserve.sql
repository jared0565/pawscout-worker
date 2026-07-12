-- Affiliate self-serve marketplace, foundation (2026-07-12): schema for the
-- automated signup funnel. Ships DARK - nothing in this migration activates
-- anything on its own; the whole feature stays behind tenant_config.selfServe
-- .enabled (defaults false, see src/types.ts) until the owner flips it on.

-- One row per self-serve signup attempt, from first form submit through
-- screen/score to auto-issue or decline. DISTINCT from the existing
-- affiliate_applicants table (migrations/0015_affiliate_applicants.sql),
-- which is thread-keyed and belongs to the inbox partnership lane - this
-- table is the self-serve funnel's own record and is keyed by (shop, id).
CREATE TABLE affiliate_applications (
  shop          TEXT NOT NULL,
  id            TEXT NOT NULL,                 -- uuid
  email         TEXT NOT NULL,
  name          TEXT,
  channel_url   TEXT,                          -- where they promote (their channel/site)
  answers_json  TEXT,                          -- raw form answers, as submitted
  stage         TEXT NOT NULL,                 -- funnel stage (see AFFILIATE_STAGE_* in tenant-store.ts): submitted|verified|judging|approved_pending_issue|approved|deflected|declined|owner_queue
  score         INTEGER,                       -- 0-N; nullable until screened
  facts_json    TEXT,                          -- deterministic facts gathered during screening
  flags_json    TEXT,                          -- risk/abuse flags raised during screening
  ip_hash       TEXT,                          -- hashed submitter IP, for throttling; never raw
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
CREATE INDEX idx_affiliate_applications_stage ON affiliate_applications (shop, stage, updated_at);

-- Single-use claim tokens for the self-serve funnel (e.g. email verification,
-- magic-link claim). Tokens are hashed by the CALLER before being stored or
-- looked up here - this table never sees a raw token value. A token is
-- consumed exactly once via the atomic claim in src/tenant-store.ts
-- (UPDATE ... WHERE used_at IS NULL, single-row change required to succeed).
CREATE TABLE affiliate_tokens (
  shop        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  kind        TEXT NOT NULL,                   -- token kind: verify (email ownership) | login (portal session)
  subject_id  TEXT NOT NULL,                   -- the id a successful claim resolves to (application id, etc.)
  expires_at  TEXT NOT NULL,
  used_at     TEXT,                            -- NULL = unclaimed; set exactly once by claimToken
  PRIMARY KEY (shop, token_hash)
);

-- Self-referral detection groundwork: the hashed buyer email (never raw) lets
-- a later attribution task flag an order where the buyer is the same person
-- as the affiliate partner who owns the voucher used. Both columns are
-- nullable/default-off here - Task 1 only adds the columns; population is a
-- later task's job, and GDPR redaction (redactContact) nulls the hash when a
-- matching hash is supplied by the caller.
ALTER TABLE affiliate_orders ADD COLUMN buyer_email_hash TEXT;
ALTER TABLE affiliate_orders ADD COLUMN self_referral INTEGER DEFAULT 0;

-- Dupe audit (2026-07-12) confirmed 5 partners / 5 distinct emails on the
-- existing non-unique idx_affiliate_partners_email - safe to tighten to a
-- real uniqueness guarantee for the self-serve funnel's email-based lookups.
CREATE UNIQUE INDEX idx_affiliate_partners_email_uniq ON affiliate_partners (shop, contact_email);
