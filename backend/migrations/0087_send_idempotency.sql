-- Durable idempotency state prevents Redis loss from authorizing a second SMTP dispatch.
CREATE TABLE IF NOT EXISTS send_idempotency (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(128) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'uncertain', 'completed')),
  intent_token UUID NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, idempotency_key),
  CHECK ((status = 'completed') = (result IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS send_idempotency_reconciliation_idx
  ON send_idempotency (status, updated_at)
  WHERE status <> 'completed';
