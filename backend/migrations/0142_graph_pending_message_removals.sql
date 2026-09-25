CREATE TABLE graph_pending_message_removals (
  message_row_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,

  provider_message_id TEXT NOT NULL,
  internet_message_id TEXT,

  source_folder_path TEXT NOT NULL,
  source_folder_remote_id TEXT NOT NULL,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verify_after TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '60 seconds'),

  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX graph_pending_message_removals_due_idx
  ON graph_pending_message_removals (connection_id, account_id, verify_after);
