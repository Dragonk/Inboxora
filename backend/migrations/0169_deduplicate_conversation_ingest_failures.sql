-- no-transaction
-- Operational support: deduplicate historical unresolved conversation ingest failure records,
-- resolve failures for messages that are already successfully attached to a logical message,
-- and add a partial unique index for active unresolved failure lookups.

-- 1. If the underlying message is already successfully attached to a logical message, mark active failures resolved.
UPDATE conversation_ingest_failures f
   SET resolved_at = NOW(), updated_at = NOW()
  FROM messages m
 WHERE f.resolved_at IS NULL
   AND f.message_row_id = m.id
   AND m.logical_message_id IS NOT NULL;

-- 2. Backfill account_id from messages if any unresolved message failure was missing it.
UPDATE conversation_ingest_failures f
   SET account_id = m.account_id, updated_at = NOW()
  FROM messages m
 WHERE f.resolved_at IS NULL
   AND f.message_row_id = m.id
   AND f.account_id IS NULL;

-- 3. Mark duplicate unresolved failures resolved, keeping the latest active record per message and operation.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, account_id, message_row_id, operation
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

-- 4. Add partial unique index for fast lookup and deduplication of active unresolved message failures.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_ingest_failures_unresolved_lookup
  ON conversation_ingest_failures(user_id, account_id, message_row_id, operation)
  WHERE resolved_at IS NULL AND message_row_id IS NOT NULL;
