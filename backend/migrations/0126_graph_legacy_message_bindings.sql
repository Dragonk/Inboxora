-- LIVE-01: an IMAP-era local message may remain addressable after an account changes
-- transport before Graph has projected the matching provider object. Keep that alias
-- separate from messages.provider_message_id: assigning Graph's id to an arbitrary
-- legacy physical copy would violate provider identity and can collapse distinct copies.
CREATE TABLE IF NOT EXISTS graph_legacy_message_bindings (
  legacy_message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  canonical_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'bound' CHECK (status IN ('bound', 'needs_review')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (legacy_message_id <> canonical_message_id)
);

CREATE INDEX IF NOT EXISTS graph_legacy_message_bindings_canonical_idx
  ON graph_legacy_message_bindings (canonical_message_id)
  WHERE status = 'bound';
CREATE INDEX IF NOT EXISTS graph_legacy_message_bindings_account_connection_idx
  ON graph_legacy_message_bindings (account_id, connection_id)
  WHERE status = 'bound';
