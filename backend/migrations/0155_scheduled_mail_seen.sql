-- Apply after 0154_mail_merge_batches.sql. Viewing a delivery result is not
-- a delivery mutation: keep revisions, receipts and send-idempotency records intact.
ALTER TABLE scheduled_mail ADD COLUMN sent_seen_at TIMESTAMPTZ;
-- Only small visible headers survive a confirmed delivery. No body, attachment
-- bytes or blind-recipient addresses are retained for historical previews.
ALTER TABLE scheduled_mail ADD COLUMN sent_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(sent_metadata) = 'object');
CREATE INDEX scheduled_mail_unseen_sent ON scheduled_mail (user_id, scheduled_at DESC, id DESC)
  WHERE state = 'sent' AND sent_seen_at IS NULL;
