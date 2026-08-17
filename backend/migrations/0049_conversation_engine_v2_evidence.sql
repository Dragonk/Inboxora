-- Conversation Engine v2: durable ingest envelope and per-user rebuild checkpoints.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_raw_headers TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_thread_index TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_thread_topic TEXT;
ALTER TABLE logical_messages ADD COLUMN IF NOT EXISTS raw_headers TEXT;

CREATE INDEX IF NOT EXISTS idx_logical_messages_collision
  ON logical_messages(user_id, canonical_message_id, message_id_collision_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_evidence_identity
  ON conversation_evidence(conversation_id, logical_message_id, evidence_type, evidence_value_hash);

CREATE TABLE IF NOT EXISTS conversation_rebuild_checkpoints (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
  last_message_date TIMESTAMPTZ,
  last_message_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  dry_run BOOLEAN NOT NULL DEFAULT true,
  scanned_count BIGINT NOT NULL DEFAULT 0,
  updated_count BIGINT NOT NULL DEFAULT 0,
  diagnostics JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id)
);
