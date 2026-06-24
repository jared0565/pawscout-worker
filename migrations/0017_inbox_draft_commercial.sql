-- Task 2: observability for the bounded commercial objective: did a drafted reply carry a
-- CTA or a grounded commercial nudge? 0/1, backfill-safe (existing rows = 0).
ALTER TABLE inbox_drafts ADD COLUMN commercial_intent INTEGER NOT NULL DEFAULT 0;
