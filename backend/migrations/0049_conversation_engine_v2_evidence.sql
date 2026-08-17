-- Preserve immutable RFC/provider evidence needed for deterministic rebuilds.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_raw_headers TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_thread_index TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_thread_topic TEXT;
ALTER TABLE logical_messages ADD COLUMN IF NOT EXISTS raw_headers TEXT;

CREATE INDEX IF NOT EXISTS idx_logical_messages_collision
  ON logical_messages(user_id, canonical_message_id, message_id_collision_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_evidence_identity
  ON conversation_evidence(conversation_id, logical_message_id, evidence_type, evidence_value_hash);
