-- Apply after 0136. A confirmed remote calendar mutation can outlive a local projection transaction.
CREATE TABLE IF NOT EXISTS calendar_collection_projection_receipts (
  operation_id UUID PRIMARY KEY REFERENCES provider_operations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'delete')),
  remote_calendar_id TEXT NOT NULL CHECK (length(btrim(remote_calendar_id)) > 0),
  collection_id UUID,
  local_calendar_id UUID,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'projected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  projected_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS calendar_collection_projection_receipts_pending_idx
  ON calendar_collection_projection_receipts (user_id, connection_id, state, created_at);
