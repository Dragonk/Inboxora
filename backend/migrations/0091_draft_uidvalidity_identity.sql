-- Preserve the UIDVALIDITY epoch that was current when a Drafts row was appended.
-- A UID alone is not a safe destructive identity after a mailbox is recreated.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS draft_uid_validity BIGINT;

CREATE INDEX IF NOT EXISTS messages_draft_identity_idx
  ON messages (account_id, folder, uid, draft_uid_validity)
  WHERE draft_uid_validity IS NOT NULL;
