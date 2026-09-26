-- Forward-only repair: do not edit already-applied migrations 0141--0144.
-- Match the ECMAScript String.trim whitespace set, including tabs/newlines.
CREATE FUNCTION inboxora_trim_identity(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT NULLIF(btrim(value, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '')
$fn$;

-- This also repairs references when 0144 already normalized the message itself.
UPDATE snoozed_messages s
SET message_id_header = inboxora_trim_identity(s.message_id_header)
WHERE inboxora_trim_identity(s.message_id_header) IS NOT NULL
  AND s.message_id_header IS DISTINCT FROM inboxora_trim_identity(s.message_id_header)
  AND EXISTS (
    SELECT 1 FROM messages m WHERE m.account_id = s.account_id
      AND inboxora_trim_identity(m.message_id) = inboxora_trim_identity(s.message_id_header)
  );

UPDATE messages SET thread_id = inboxora_trim_identity(thread_id)
WHERE thread_id IS DISTINCT FROM inboxora_trim_identity(thread_id);
UPDATE messages SET message_id = inboxora_trim_identity(message_id)
WHERE message_id IS DISTINCT FROM inboxora_trim_identity(message_id);
UPDATE graph_pending_message_removals
SET internet_message_id = inboxora_trim_identity(internet_message_id)
WHERE internet_message_id IS DISTINCT FROM inboxora_trim_identity(internet_message_id);
DROP FUNCTION inboxora_trim_identity(text);

-- MOVE receipts preserve physical identity across replayed source-folder pages.
CREATE TABLE graph_mail_move_receipts (
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  old_provider_message_id TEXT NOT NULL,
  message_row_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  source_folder_path TEXT NOT NULL,
  target_folder_path TEXT NOT NULL,
  new_provider_message_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, old_provider_message_id)
);
CREATE INDEX graph_mail_move_receipts_row_idx ON graph_mail_move_receipts(message_row_id);
