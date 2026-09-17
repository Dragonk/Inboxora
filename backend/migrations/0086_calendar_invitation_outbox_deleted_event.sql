-- Preserve cancellation retries after the event they retract has been deleted.
-- Existing deployments already applied 0085, so this is intentionally additive.
ALTER TABLE calendar_invitation_outbox
  ALTER COLUMN event_id DROP NOT NULL;

ALTER TABLE calendar_invitation_outbox
  DROP CONSTRAINT IF EXISTS calendar_invitation_outbox_event_id_fkey;

ALTER TABLE calendar_invitation_outbox
  ADD CONSTRAINT calendar_invitation_outbox_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE SET NULL;
