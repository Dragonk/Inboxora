-- P08: the Gmail label set of an ingested message.
--
-- A Gmail message does not live in one folder: it carries a set of label ids, and
-- Gmail's `INBOX`, `SENT`, `DRAFT`, `TRASH` and `SPAM` are labels like any other.
-- `messages` holds exactly one row per provider message (the partial unique index
-- `messages_provider_identity_key` added in 0108), so the row's `folder` is the
-- *primary* mailbox this adapter derives from the label set, and the complete label
-- id set is kept beside it here. Without it the additional labels a message carries
-- would be lost on ingest, and a label deleted in Gmail could not be resolved to
-- another mailbox the message is still in.
--
-- `provider_labels` is NULL for every message that did not come from the Gmail API
-- — including a Gmail account still using IMAP/SMTP, whose messages store the
-- IMAP `X-GM-*` metadata instead. Nothing rewrites an existing row.
--
-- Expand-only and additive, and it does not change any account's transport. Apply
-- in order, after 0110, before rolling out the application: the Gmail adapter
-- writes the column, and an older application version simply leaves it NULL.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_labels TEXT[];

-- The label set is read back per message row (re-homing a message when a label is
-- deleted), which is a primary-key lookup; no separate index is warranted.
