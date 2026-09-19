-- P07b: provider-native identity for an ingested message.
--
-- `messages` was keyed by `UNIQUE (account_id, uid, folder)` with `uid BIGINT NOT
-- NULL`, which is an IMAP identity. Microsoft Graph identifies a message by an
-- opaque string that is immutable for the life of the message, and the plan's rule
-- is to use the provider's own stable identifier rather than parse or re-derive
-- one — nor to key on the RFC `Message-ID`, which is neither unique nor stable.
--
-- `uid` therefore stays as the per-account compatibility number it always was (the
-- adapter derives it from the provider id, so it is stable, and `provider_message_id`
-- is the identity a sync reconciles on). The index is partial so every pre-v4 IMAP
-- row, which has no provider id, is untouched.
--
-- Expand-only and additive: no existing row is rewritten and no existing constraint
-- is dropped. Apply in order, after 0107, before rolling out the application.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_identity_key
  ON messages (account_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_provider_folder_idx
  ON messages (account_id, folder)
  WHERE provider_message_id IS NOT NULL;
