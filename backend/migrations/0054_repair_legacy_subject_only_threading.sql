-- Repair legacy subject-only joins introduced by the old 0002 backfill.
-- RFC/provider evidence is required by Conversation Engine v2; these legacy
-- rows are detached so they can be rebuilt safely by the v2 reconciler.
UPDATE messages AS m
SET thread_id = m.message_id
WHERE m.is_deleted = false
  AND m.message_id IS NOT NULL
  AND m.thread_id IS NOT NULL
  AND m.thread_id IS DISTINCT FROM m.message_id
  AND (m.in_reply_to IS NULL OR m.in_reply_to = '')
  AND (m.thread_references IS NULL OR m.thread_references = '')
  AND EXISTS (
    SELECT 1
    FROM messages AS sibling
    WHERE sibling.account_id = m.account_id
      AND sibling.is_deleted = false
      AND sibling.message_id IS NOT NULL
      AND sibling.message_id = m.thread_id
      AND sibling.normalized_subject = m.normalized_subject
      AND (sibling.in_reply_to IS NULL OR sibling.in_reply_to = '')
      AND (sibling.thread_references IS NULL OR sibling.thread_references = '')
  );
