-- Ensure thread-related columns exist before this migration references them.
-- On installs that pre-date the threading feature (Apr 30 2026), the baseline
-- CREATE TABLE IF NOT EXISTS was a no-op and these columns were never added.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_references TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id TEXT;

-- Add normalized_subject as a generated column for subject-based thread fallback.
-- Strips up to 3 levels of common reply/forward prefixes (Re:, FW:, AW:, etc.)
-- and lowercases the result. Used by computeThreadId when RFC 5322 In-Reply-To /
-- References headers are absent (e.g. Outlook RE:, webmail without threading headers).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS normalized_subject TEXT GENERATED ALWAYS AS (
  lower(trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          coalesce(subject, ''),
          '^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:[[:space:]]*',
          '', 'i'
        ),
        '^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:[[:space:]]*',
        '', 'i'
      ),
      '^(re|fw|fwd|aw|sv|vs|tr|wg|ant|antw|ref|rif|ynt|odp|vb|atb)[[:space:]]*:[[:space:]]*',
      '', 'i'
    )
  ))
) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_norm_subject
  ON messages(account_id, normalized_subject)
  WHERE is_deleted = false AND normalized_subject IS NOT NULL;

-- Fix provisional thread_ids: messages synced out of order end up with a
-- thread_id equal to an intermediate reply's message_id rather than the true
-- thread root.  Repeatedly walk the chain (parent.thread_id → grandparent …)
-- until no more updates are needed, capped at 10 passes for safety.
DO $$
DECLARE
  updated_count INT;
  passes INT := 0;
BEGIN
  LOOP
    UPDATE messages m
    SET thread_id = parent.thread_id
    FROM messages parent
    WHERE m.account_id = parent.account_id
      AND m.thread_id  = parent.message_id
      AND m.thread_id IS DISTINCT FROM parent.thread_id
      AND parent.thread_id IS NOT NULL;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    EXIT WHEN updated_count = 0 OR passes >= 10;
    passes := passes + 1;
  END LOOP;
END;
$$;

-- Subject-only grouping is intentionally not performed. Messages without RFC/provider
-- evidence remain separate until the Conversation Engine classifies them explicitly.
