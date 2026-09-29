-- Apply after 0151_account_default_recipients.sql, before starting queue workers.
-- Queue receipts are durable: never recycle an enqueue idempotency key.
CREATE TABLE scheduled_mail (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  edit_fingerprint TEXT CHECK (edit_fingerprint IS NULL OR edit_fingerprint ~ '^[a-f0-9]{64}$'),
  subject TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL CHECK (mode IN ('undo', 'schedule')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending', 'editing', 'preparing', 'sending', 'sent', 'partial', 'failed', 'uncertain', 'cancelled')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 80),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  result JSONB,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  dispatch_started_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, idempotency_key),
  CHECK ((state IN ('preparing', 'sending')) = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX scheduled_mail_due ON scheduled_mail (scheduled_at, id) WHERE state = 'pending';
CREATE INDEX scheduled_mail_owner ON scheduled_mail (user_id, scheduled_at, id);
CREATE INDEX scheduled_mail_expired_lease ON scheduled_mail (lease_until) WHERE state IN ('preparing', 'sending');
