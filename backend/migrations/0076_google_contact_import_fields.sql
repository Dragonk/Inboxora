-- Preserve every non-empty column from Google Contacts CSV imports verbatim.
-- Known fields are also normalized into contacts columns and vCard properties.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS google_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
