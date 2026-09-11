-- An event created from a mail invitation must keep a link to that message, so the
-- calendar can offer "open the original message" instead of forcing the user to
-- hunt for it in the mailbox.
--
-- ON DELETE SET NULL: deleting the mail must never delete the calendar event, it
-- only removes a link that would dangle.
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

-- The calendar lists events for a range and then offers the link; the lookup by
-- source message stays cheap.
CREATE INDEX IF NOT EXISTS calendar_events_source_message_idx
  ON calendar_events (source_message_id)
  WHERE source_message_id IS NOT NULL;
