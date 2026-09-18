-- Stable per-message training identity for antispam maturity dedup.
-- One physical mail re-confirmed N times must remain ONE usable sample, and
-- a Spam→Ham correction must resolve deterministically (latest wins).
-- Identity = 'mid:<message-id-header>' when present, else
-- 'copy:<account_id>:<folder>:<uid>', else 'sub:<sender_domain>:<subject
-- hash>:<body lead hash>' for rows without any stable reference. Existing
-- rows are backfilled with the same mid/copy rule so retrain semantics apply
-- to them (the sub: fallback hashes raw values in SQL vs normalized values in
-- the TS helper — acceptable best-effort for legacy rows that predate stable
-- references; all new rows are computed in one place in TS).
-- Apply before deploying code that reads/writes training_identity.
ALTER TABLE spam_training_log
  ADD COLUMN IF NOT EXISTS training_identity TEXT;

UPDATE spam_training_log
SET training_identity = CASE
  WHEN message_id_header IS NOT NULL AND btrim(message_id_header) <> ''
    THEN 'mid:' || btrim(message_id_header)
  WHEN account_id IS NOT NULL AND folder IS NOT NULL AND message_uid IS NOT NULL
    THEN 'copy:' || account_id::text || ':' || folder || ':' || message_uid::text
  ELSE 'sub:' || COALESCE(sender_domain, '')
         || ':' || COALESCE(md5(COALESCE(subject, '')), '')
         || ':' || COALESCE(md5(LEFT(COALESCE(body_text, ''), 4000)), '')
END
WHERE training_identity IS NULL;

CREATE INDEX IF NOT EXISTS idx_spam_training_log_user_identity
  ON spam_training_log (user_id, training_identity);
