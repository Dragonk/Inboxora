-- Normalize historical RFC Message-ID values that were stored with surrounding
-- whitespace before the 4.1.1 ingestion fix.
--
-- First repair every thread_id in the same account that points at an old,
-- unnormalized Message-ID. This includes replies rooted at another physical
-- message, not only rows that were self-rooted.
WITH normalized_ids AS (
  SELECT DISTINCT
    account_id,
    message_id AS old_message_id,
    NULLIF(btrim(message_id), '') AS new_message_id
  FROM messages
  WHERE message_id IS NOT NULL
    AND message_id IS DISTINCT FROM NULLIF(btrim(message_id), '')
)
UPDATE messages m
SET thread_id = n.new_message_id
FROM normalized_ids n
WHERE m.account_id = n.account_id
  AND m.thread_id = n.old_message_id;

-- Then normalize the stored RFC Message-ID itself. Whitespace-only identifiers
-- become NULL so thread_key falls back to the physical row identity.
UPDATE messages
SET message_id = NULLIF(btrim(message_id), '')
WHERE message_id IS NOT NULL
  AND message_id IS DISTINCT FROM NULLIF(btrim(message_id), '');
