-- Persist an action before invoking SMTP. If the worker dies or DATA's outcome is
-- lost after this marker, recovery must not dispatch the same action again.
ALTER TABLE calendar_invitation_outbox DROP CONSTRAINT IF EXISTS calendar_invitation_outbox_status_check;
ALTER TABLE calendar_invitation_outbox
  ADD CONSTRAINT calendar_invitation_outbox_status_check
  CHECK (status IN ('sending', 'processing', 'sent', 'failed', 'uncertain'));

ALTER TABLE calendar_invitation_outbox
  ADD COLUMN IF NOT EXISTS dispatch_action JSONB,
  ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS calendar_invitation_outbox_uncertain_dispatch_idx
  ON calendar_invitation_outbox (dispatch_started_at)
  WHERE status = 'uncertain';
