-- Keep the editable draft components separate from the rendered IMAP MIME copy.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS draft_alias_id UUID,
  ADD COLUMN IF NOT EXISTS draft_in_reply_to TEXT,
  ADD COLUMN IF NOT EXISTS draft_references TEXT,
  ADD COLUMN IF NOT EXISTS draft_composition JSONB;
