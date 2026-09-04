-- Sender-level block for the inbox (owner rule 2026-09-04): a sender who keeps
-- sending the SAME message is spam, and every later message from them lands as
-- spam at ingest before classification, drafting or alerting can run.
--
-- Until now spam was decided only by a DMARC failure on each message, so a
-- sender who wrote again under a new subject got a fresh thread, an LLM
-- classification and a draft every time (one mass-mailer created 8 threads).
-- The block lives on the CONTACT, not the thread, because that is the unit
-- that recurs. Reversible: the console's "Unblock sender" clears both columns.
ALTER TABLE inbox_contacts ADD COLUMN blocked_at TEXT;
ALTER TABLE inbox_contacts ADD COLUMN blocked_reason TEXT;
