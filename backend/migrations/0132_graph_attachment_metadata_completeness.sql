-- Graph body and attachment metadata are independent reads. A cached body is not proof
-- that the attachment listing succeeded, so retain this state across later reader opens.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS graph_attachment_metadata_complete BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_messages_graph_attachment_metadata_incomplete
  ON messages (account_id, id)
  WHERE graph_attachment_metadata_complete = false;
