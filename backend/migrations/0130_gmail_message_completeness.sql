-- NA-09: Gmail metadata, rule hydration and reader MIME are distinct projections.
-- Apply after 0129_calendar_presentation_preferences.sql before deploying Gmail reader-cache completeness checks.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS gmail_rule_body_complete BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gmail_reader_body_complete BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gmail_attachment_metadata_complete BOOLEAN NOT NULL DEFAULT false;
