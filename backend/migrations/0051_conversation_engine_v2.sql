-- Additive Conversation Engine v2 model. Legacy message/thread columns remain intact.
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'human_reply_chain',
  subject_snapshot TEXT,
  canonical_subject TEXT,
  first_message_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  logical_message_count INTEGER NOT NULL DEFAULT 0,
  copy_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  algorithm_version TEXT NOT NULL DEFAULT 'conversation-v2',
  threading_confidence NUMERIC(5,4),
  manually_locked BOOLEAN NOT NULL DEFAULT false,
  continued_from_conversation_id UUID REFERENCES conversations(id),
  continued_to_conversation_id UUID REFERENCES conversations(id),
  segment_number INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (kind IN ('human_reply_chain','provider_thread','automated_reference_series','automated_smart_series','manual_conversation')),
  CHECK (threading_confidence IS NULL OR (threading_confidence >= 0 AND threading_confidence <= 1))
);

CREATE TABLE IF NOT EXISTS logical_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  canonical_message_id TEXT,
  raw_message_id TEXT,
  message_id_collision_key TEXT,
  parent_logical_message_id UUID REFERENCES logical_messages(id),
  raw_in_reply_to TEXT,
  raw_references TEXT,
  parsed_in_reply_to JSONB NOT NULL DEFAULT '[]',
  parsed_references JSONB NOT NULL DEFAULT '[]',
  subject TEXT,
  canonical_subject TEXT,
  from_address TEXT,
  sender_address TEXT,
  recipient_signature TEXT,
  sender_signature TEXT,
  direction TEXT NOT NULL DEFAULT 'unknown',
  message_date TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  body_fingerprint TEXT,
  header_fingerprint TEXT,
  threading_reason TEXT,
  threading_confidence NUMERIC(5,4),
  algorithm_version TEXT NOT NULL DEFAULT 'conversation-v2',
  diagnostics JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (direction IN ('incoming','outgoing','self','unknown')),
  CHECK (threading_confidence IS NULL OR (threading_confidence >= 0 AND threading_confidence <= 1))
);

CREATE TABLE IF NOT EXISTS provider_thread_mappings (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  diagnostics JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, account_id, provider, provider_thread_id)
);

CREATE TABLE IF NOT EXISTS unresolved_message_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  child_logical_message_id UUID NOT NULL REFERENCES logical_messages(id) ON DELETE CASCADE,
  referenced_message_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  reference_position INTEGER,
  resolved_logical_message_id UUID REFERENCES logical_messages(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, child_logical_message_id, referenced_message_id, relation_type, reference_position)
);

CREATE TABLE IF NOT EXISTS conversation_aliases (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias_conversation_id UUID NOT NULL,
  canonical_conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, alias_conversation_id)
);

CREATE TABLE IF NOT EXISTS conversation_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  logical_message_id UUID REFERENCES logical_messages(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  evidence_value_hash TEXT,
  weight NUMERIC(5,4),
  algorithm_version TEXT NOT NULL DEFAULT 'conversation-v2',
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  logical_message_id UUID REFERENCES logical_messages(id) ON DELETE CASCADE,
  override_type TEXT NOT NULL,
  target_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (override_type IN ('force-include','force-exclude','manual-split','manual-merge','lock-conversation'))
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS logical_message_id UUID REFERENCES logical_messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS canonical_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_namespace TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS threading_reason TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS threading_confidence NUMERIC(5,4);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS threading_algorithm_version TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_conversations_user_latest ON conversations(user_id, last_message_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_logical_messages_user_message ON logical_messages(user_id, canonical_message_id);
CREATE INDEX IF NOT EXISTS idx_logical_messages_conversation ON logical_messages(conversation_id, message_date ASC, id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, account_id, date DESC) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_messages_provider_thread ON messages(account_id, provider_namespace, provider_thread_id) WHERE provider_thread_id IS NOT NULL;
