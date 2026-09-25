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
-- **The legacy rows are cleared first, and that is what makes this migration safe on an
-- existing 4.0.4 database.** `provider_message_id` predates the native transports: it
-- arrived with Conversation Engine v2 (0051) as *threading evidence*, and on Gmail IMAP it
-- holds X-GM-MSGID — an identifier that is **mailbox-wide**, so the same value legitimately
-- exists once per folder/label copy (INBOX, `[Gmail]/Important`, `[Gmail]/All Mail`, a
-- custom label), and the relocate/COPY path (`utils/relocateColumns.ts`) preserves it on
-- every physical copy. A real 4.0.4 mailbox shows 19231 rows carrying a provider id against
-- 7445 distinct ones; creating a unique index over that data fails with 23505 and the
-- installation cannot start.
--
-- Those values are evidence, not identity: a legacy account is identified by
-- `(account_id, uid, folder)`, and Gmail threading uses `provider_thread_id` (X-GM-THRID),
-- which this migration does not touch — nor does it touch `uid`, `folder`, `message_id`,
-- `thread_key`, any Conversation Engine column, or any row. Only the column that is *not*
-- authoritative for a legacy account is cleared, and only for the accounts whose own
-- transport says so:
--
--   * `mail_transport` NULL or `imap_smtp` — the legacy IMAP/SMTP model, including every
--     account upgraded from 4.0.4, where the column is NULL. Cleared.
--   * any native transport (`microsoft_graph`, `gmail_api`) — the adapter stores the
--     provider's own per-message id there and the sync reconciles on it. Kept.
--
-- The condition is the account's authoritative state, never the host name: the same Gmail
-- mailbox is legacy or native depending on the transport it deliberately uses.
--
-- Idempotent in all three states an installation can be in: never applied (clears, then
-- creates), already applied by an earlier `:dev` revision (recorded, so not re-run), and a
-- partial attempt that added the column and failed on the index (the clear runs again and
-- the index is then created).
--
-- Expand-only and additive: no row is deleted and no existing constraint is dropped.
-- Apply in order, after 0107, before rolling out the application.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

UPDATE messages m
   SET provider_message_id = NULL
  FROM email_accounts a
 WHERE m.account_id = a.id
   AND m.provider_message_id IS NOT NULL
   AND COALESCE(a.mail_transport, 'imap_smtp') = 'imap_smtp';

CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_identity_key
  ON messages (account_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_provider_folder_idx
  ON messages (account_id, folder)
  WHERE provider_message_id IS NOT NULL;
