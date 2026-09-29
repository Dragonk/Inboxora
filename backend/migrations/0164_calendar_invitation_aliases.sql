-- Keep a historical alias id even after its alias is removed. The sender
-- resolver must refuse an unavailable identity, never fall back to the mailbox.
ALTER TABLE calendar_events ADD COLUMN invite_alias_id UUID;
