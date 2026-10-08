-- Operational support: deduplicate historical unresolved conversation ingest failure records,
-- resolve failures for messages that are already successfully attached to a logical message,
-- and add a partial index for active unresolved failure lookups.

-- 1. If the underlying message is already successfully attached to a logical message, mark active failures resolved.
UPDATE conversation_ingest_failures f
   SET resolved_at = NOW(), updated_at = NOW()
  FROM messages m
 WHERE f.resolved_at IS NULL
   AND f.message_row_id = m.id
   AND m.logical_message_id IS NOT NULL;

-- 2. Mark duplicate unresolved failures resolved, keeping the latest active record per message and operation.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), message_row_id, operation
           ORDER BY created_at DESC, id DESC
         ) AS rank
    FROM conversation_ingest_failures
   WHERE resolved_at IS NULL
     AND message_row_id IS NOT NULL
)
UPDATE conversation_ingest_failures f
   SET resolved_at = NOW(), updated_at = NOW()
  FROM ranked
 WHERE f.id = ranked.id
   AND ranked.rank > 1;

-- 3. Add partial index for fast lookup of active unresolved failures during deduplication and claims.
CREATE INDEX IF NOT EXISTS idx_conversation_ingest_failures_unresolved_lookup
  ON conversation_ingest_failures(user_id, account_id, message_row_id, operation)
  WHERE resolved_at IS NULL;
