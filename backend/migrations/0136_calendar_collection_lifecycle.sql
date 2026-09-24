-- Apply after 0135 and before deploying calendar collection lifecycle fencing.
-- These tombstones are durable evidence of confirmed remote deletion, not absence
-- inferred from a provider list. Discovery must never remove or bypass them.
CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_id_user_id_key
  ON provider_connections (id, user_id);

CREATE TABLE IF NOT EXISTS calendar_collection_tombstones (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  remote_calendar_id TEXT NOT NULL CHECK (length(btrim(remote_calendar_id)) > 0),
  -- Account deletion cascades its journal; retain deletion evidence even then.
  operation_id UUID REFERENCES provider_operations(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, connection_id, remote_calendar_id),
  FOREIGN KEY (connection_id, user_id)
    REFERENCES provider_connections(id, user_id) ON DELETE CASCADE
);
