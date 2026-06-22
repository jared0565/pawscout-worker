-- Phase 2: self-declared intent from the contact-form "Reason" dropdown.
-- Reinforces (never overrides) the content classifier's primary_category.
-- Nullable; existing rows and all non-form emails stay NULL.
ALTER TABLE inbox_threads ADD COLUMN declared_intent TEXT;
