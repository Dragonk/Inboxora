-- P1: body/detail routes and reconciliation repeatedly look up physical copies
-- by logical_message_id. The existing conversation index cannot serve that
-- predicate efficiently, especially when a tenant has many accounts/messages.
-- Keep deleted rows out of the hot index because all CE reads exclude them.
CREATE INDEX IF NOT EXISTS idx_messages_logical_message_date
  ON messages(logical_message_id, date DESC NULLS LAST, id DESC)
  WHERE is_deleted = false AND logical_message_id IS NOT NULL;
