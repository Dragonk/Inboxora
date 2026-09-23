-- RV-08: durable read-only deferrals for native inbox rules whose body or headers are not yet local.
-- Apply after 0120_provider_rule_headers.sql and before rolling out the worker.
CREATE TABLE IF NOT EXISTS provider_rule_deferred_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  transport TEXT NOT NULL CHECK (transport IN ('gmail_api', 'microsoft_graph')),
  needs_body BOOLEAN NOT NULL DEFAULT false,
  needs_headers BOOLEAN NOT NULL DEFAULT false,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id)
);

CREATE INDEX IF NOT EXISTS provider_rule_deferred_ready_idx
  ON provider_rule_deferred_messages (available_at, lease_expires_at, created_at);
