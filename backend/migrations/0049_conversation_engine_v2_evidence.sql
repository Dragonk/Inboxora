-- Conversation Engine v2: durable ingest envelope and per-user rebuild checkpoints.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_raw_headers TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_thread_index TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_thread_topic TEXT;
ALTER TABLE logical_messages ADD COLUMN IF NOT EXISTS raw_headers TEXT;

CREATE INDEX IF NOT EXISTS idx_logical_messages_collision
  ON logical_messages(user_id, canonical_message_id, message_id_collision_key);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_conversation_evidence_identity'
  ) THEN
    DELETE FROM conversation_evidence older
     USING conversation_evidence newer
     WHERE older.id < newer.id
       AND older.conversation_id IS NOT DISTINCT FROM newer.conversation_id
       AND older.logical_message_id IS NOT DISTINCT FROM newer.logical_message_id
       AND older.evidence_type = newer.evidence_type
       AND older.evidence_value_hash IS NOT DISTINCT FROM newer.evidence_value_hash;
    CREATE UNIQUE INDEX uq_conversation_evidence_identity
      ON conversation_evidence(conversation_id, logical_message_id, evidence_type, evidence_value_hash);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS conversation_rebuild_checkpoints (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_account_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  last_sort_is_null BOOLEAN,
  last_message_date TIMESTAMPTZ,
  last_message_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  dry_run BOOLEAN NOT NULL DEFAULT false,
  scanned_count BIGINT NOT NULL DEFAULT 0,
  updated_count BIGINT NOT NULL DEFAULT 0,
  diagnostics JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, scope_account_id),
  FOREIGN KEY (scope_account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
);
