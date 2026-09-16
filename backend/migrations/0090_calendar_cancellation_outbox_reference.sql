-- Keep the latest cancellation operation attached to its event so status checks after
-- a form retry or refresh address the same durable outbox row.
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS cancellation_outbox_id UUID
  REFERENCES calendar_invitation_outbox(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS calendar_events_cancellation_outbox_idx
  ON calendar_events (cancellation_outbox_id)
  WHERE cancellation_outbox_id IS NOT NULL;
