-- A sending row can outlive its request, so it needs explicit owner/lease state before
-- a background worker may safely recover it. Final writes are token-conditional.
ALTER TABLE calendar_invitation_outbox DROP CONSTRAINT IF EXISTS calendar_invitation_outbox_status_check;
ALTER TABLE calendar_invitation_outbox
  ADD CONSTRAINT calendar_invitation_outbox_status_check
  CHECK (status IN ('sending', 'processing', 'sent', 'failed'));

ALTER TABLE calendar_invitation_outbox
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS calendar_invitation_outbox_claim_idx
  ON calendar_invitation_outbox (status, claim_expires_at, next_attempt_at, created_at)
  WHERE status <> 'sent';
