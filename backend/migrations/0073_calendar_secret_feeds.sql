-- Revocable, bearer-token calendar subscriptions. Store only a verifier.
CREATE TABLE IF NOT EXISTS calendar_secret_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  calendar_ids UUID[] NOT NULL CHECK (cardinality(calendar_ids) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS calendar_secret_feeds_owner_idx
  ON calendar_secret_feeds (owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS calendar_secret_feeds_active_hash_idx
  ON calendar_secret_feeds (token_hash) WHERE revoked_at IS NULL;
