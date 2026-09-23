-- RV-07: an archived Gmail message still exists remotely and must retain its
-- local identity, annotations and thread links even when it has no modeled folder.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS messages_account_archived_idx ON messages (account_id, is_archived);
