-- A durable marker distinguishes a reconciliable empty final checkpoint
-- from a malformed outbox row that never contained an invitation action.
ALTER TABLE calendar_invitation_outbox
  ADD COLUMN IF NOT EXISTS completion_checkpointed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS calendar_invitation_outbox_completion_checkpoint_idx
  ON calendar_invitation_outbox (completion_checkpointed_at)
  WHERE completion_checkpointed_at IS NOT NULL AND status <> 'sent';
