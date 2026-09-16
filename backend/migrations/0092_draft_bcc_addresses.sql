-- Retain BCC recipients for locally persisted drafts without exposing them in
-- ordinary recipient projections.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS draft_bcc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb;
