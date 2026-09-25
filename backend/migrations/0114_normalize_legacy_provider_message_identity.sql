-- Normalise the legacy Conversation Engine provider identity on every database, including the ones where the
-- first revision of 0108 already succeeded.
--
-- 0108 creates `messages_provider_identity_key`, a unique index over
-- `(account_id, provider_message_id)`, and it now clears the legacy values for accounts on a legacy transport
-- **before** creating that index. That fixed the 4.0.4 upgrade. It does not help a database that ran the
-- *first* revision of 0108 on an earlier `:dev`: there the index exists, 0108 is recorded under the old
-- checksum (so the corrected file is deliberately not re-run), and a legacy Gmail IMAP account can still hold
-- X-GM-MSGID values — one per folder/label copy. On such a database the next IMAP COPY or relocate can insert
-- a second physical row for a message whose provider id is already present and fail with `23505`, which is
-- exactly the constraint this column was never meant to impose on a legacy account.
--
-- This migration applies the same rule unconditionally, so the state no longer depends on which revision of
-- 0108 a database happened to run:
--
--   * a database upgraded cleanly from 4.0.4 — 0108 already cleared these rows, so this is a no-op;
--   * an earlier `:dev` database with the old 0108 — the leftover legacy values are cleared here;
--   * an account on a native transport (`microsoft_graph`, `gmail_api`) — untouched: the adapter stores the
--     provider's own per-message id there and the sync reconciles on it.
--
-- An `UPDATE … SET NULL` cannot violate the unique index, and the index itself is left in place. No row is
-- deleted, and `provider_thread_id` (X-GM-THRID), `thread_key`, `uid`, `folder`, `message_id` and every
-- Conversation Engine column keep their values, so threading is unaffected.
--
-- Additive, idempotent and safe to run on any state. Apply after 0113.

UPDATE messages m
   SET provider_message_id = NULL
  FROM email_accounts a
 WHERE m.account_id = a.id
   AND m.provider_message_id IS NOT NULL
   AND COALESCE(a.mail_transport, 'imap_smtp') = 'imap_smtp';
