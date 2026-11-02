-- Phase 3 follow-up: what a payee is (looked up by Claude), and tags for one-off expenses in Miscellaneous.
ALTER TABLE payee_hints ADD COLUMN about TEXT;
ALTER TABLE payee_hints ADD COLUMN researched BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN tag TEXT;
ALTER TABLE transactions ADD COLUMN tag_source TEXT;
