-- Invitation delivery must be distinguishable from invitation creation.
--
-- The outbox previously had only 'sending' and 'sent': a delivery that failed
-- stayed 'sending' with last_error set and next_attempt_at did not exist, so a
-- retry could never be told apart from an in-flight attempt (and never resent).
-- 'failed' plus next_attempt_at makes a failed invitation a retryable queued
-- item instead of a dead row, and lets the GUI report the real delivery state.
ALTER TABLE calendar_invitation_outbox DROP CONSTRAINT IF EXISTS calendar_invitation_outbox_status_check;
ALTER TABLE calendar_invitation_outbox
  ADD CONSTRAINT calendar_invitation_outbox_status_check CHECK (status IN ('sending', 'sent', 'failed'));

ALTER TABLE calendar_invitation_outbox ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

-- The background drain only ever looks at undelivered rows.
CREATE INDEX IF NOT EXISTS calendar_invitation_outbox_pending_idx
  ON calendar_invitation_outbox (next_attempt_at, created_at)
  WHERE status <> 'sent';
