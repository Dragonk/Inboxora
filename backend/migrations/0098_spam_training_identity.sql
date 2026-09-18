-- Stable per-message training identity for antispam maturity dedup.
-- One physical mail re-confirmed N times must remain ONE usable sample, and
-- a Spam→Ham correction must resolve deterministically (latest wins).
--
-- Priority (mirrors trainingIdentityFor in spamModel.ts exactly):
--   1. 'mid:<message-id-header>' — strongest stable reference.
--   2. 'sub:<sender domain>:<md5 subject>:<md5 body lead>' — stable across a
--      MOVE. A copy: identity cannot survive Relocate/Spam→Ham because the
--      server hands out a new folder+UID for the SAME mail; message content
--      does not change on a move, so a content identity does.
--   3. 'copy:<account_id>:<folder>:<uid>' — last resort, only for rows with
--      no header and no content at all.
--
-- Normalization is identical on both sides (lowercase → collapse whitespace →
-- trim, then cap: domain 255, subject 500, body lead 4000), so an
-- already-applied database and rows written from TypeScript agree without any
-- normalization at comparison time. Apply before deploying code that reads or
-- writes training_identity.
ALTER TABLE spam_training_log
  ADD COLUMN IF NOT EXISTS training_identity TEXT;

UPDATE spam_training_log
SET training_identity = CASE
  WHEN message_id_header IS NOT NULL AND btrim(message_id_header) <> ''
    THEN 'mid:' || btrim(message_id_header)
  WHEN btrim(COALESCE(sender_domain, '')) <> ''
    OR btrim(COALESCE(subject, '')) <> ''
    OR btrim(COALESCE(body_text, '')) <> ''
    THEN 'sub:'
      || left(btrim(regexp_replace(lower(COALESCE(sender_domain, '')), '\s+', ' ', 'g')), 255)
      || ':' || md5(left(btrim(regexp_replace(lower(COALESCE(subject, '')), '\s+', ' ', 'g')), 500))
      || ':' || md5(left(btrim(regexp_replace(lower(COALESCE(body_text, '')), '\s+', ' ', 'g')), 4000))
  WHEN account_id IS NOT NULL AND folder IS NOT NULL AND message_uid IS NOT NULL
    THEN 'copy:' || account_id::text || ':' || folder || ':' || message_uid::text
  ELSE NULL
END
WHERE training_identity IS NULL;

CREATE INDEX IF NOT EXISTS idx_spam_training_log_user_identity
  ON spam_training_log (user_id, training_identity);
