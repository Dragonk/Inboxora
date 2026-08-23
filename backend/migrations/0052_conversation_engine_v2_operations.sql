-- Operational support for Conversation Engine v2 retries and safe rebuilds.
CREATE TABLE IF NOT EXISTS conversation_ingest_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_row_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  diagnostics JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_ingest_retry ON conversation_ingest_failures(user_id, next_attempt_at, resolved_at);
CREATE INDEX IF NOT EXISTS idx_conversation_overrides_message ON conversation_overrides(user_id, logical_message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_overrides_conversation ON conversation_overrides(user_id, conversation_id, created_at DESC);
