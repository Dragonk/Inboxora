-- Persist a one-click intent before the outbound POST. A transport failure can leave
-- the provider effect unknown, so that message must never be submitted again blindly.
CREATE TABLE IF NOT EXISTS message_unsubscribe_attempts (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'uncertain')),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS message_unsubscribe_attempts_unresolved_idx
  ON message_unsubscribe_attempts (updated_at)
  WHERE state IN ('pending', 'uncertain');
