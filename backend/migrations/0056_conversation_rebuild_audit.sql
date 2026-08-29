-- Durable audit trail for rebuild requests and completions.
CREATE TABLE IF NOT EXISTS conversation_rebuild_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id UUID NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_rebuild_audit_user_created ON conversation_rebuild_audit(user_id, created_at DESC);
