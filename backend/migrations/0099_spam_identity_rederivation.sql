-- Re-derive antispam training identities with the unified rule from 0098.
--
-- Databases that already applied the FIRST revision of 0098 got identities
-- where the content fallback hashed RAW values and the physical copy triple
-- was preferred over content. Both are wrong for messages without a
-- Message-ID: a Spam→Ham correction changes folder+UID, so a copy: identity
-- splits one mail into two samples and defeats latest-wins. This migration
-- re-derives every row with the shipped rule (identical to
-- trainingIdentityFor in spamModel.ts) so those databases converge with
-- fresh ones. Unconditional and idempotent: rows already correct are
-- rewritten to the same value. Apply after 0098, before application rollout.
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
END;

CREATE INDEX IF NOT EXISTS idx_spam_training_log_user_identity
  ON spam_training_log (user_id, training_identity);
