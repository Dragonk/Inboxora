-- Apply after 0153_scheduled_mail_dismissal.sql, before enabling mail merge.
-- Keep receipts permanently so a lost enqueue acknowledgement cannot create a second batch.
CREATE TABLE mail_merge_batches (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  item_ids UUID[] NOT NULL CHECK (cardinality(item_ids) BETWEEN 1 AND 100),
  scheduled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, idempotency_key)
);
