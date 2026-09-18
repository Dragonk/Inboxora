-- P03 foundation: durable claims for the provider-operation journal, lease/fencing
-- columns for sync runs, and a domain outbox for idempotent post-commit delivery.
--
-- Expand-only: every change is additive and no existing row is rewritten. The
-- journal tables created in 0101 already carried status/attempts/next_attempt_at;
-- these columns add the ownership (claim token + generation + lease) that makes a
-- restarted or superseded worker unable to complete someone else's operation.

-- ── provider_operations: claim, lease and cached result ──────────────────────
ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS claim_token UUID;
ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS owner TEXT;
-- Monotonic fencing token: every (re)claim increments it, so a worker holding an
-- older generation cannot complete an operation that has since been taken over.
ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1;
-- The canonical result of a completed mutation, replayed for an identical
-- idempotent retry instead of performing the provider call again.
ALTER TABLE provider_operations ADD COLUMN IF NOT EXISTS result JSONB;

-- Reclaiming an abandoned in-flight operation only looks at unexpired leases.
CREATE INDEX IF NOT EXISTS provider_operations_claim_idx
  ON provider_operations (status, lease_expires_at)
  WHERE status = 'in_flight';

-- Due retries are picked up by state and time, never by a table scan.
CREATE INDEX IF NOT EXISTS provider_operations_pending_due_idx
  ON provider_operations (next_attempt_at)
  WHERE status = 'pending';

-- ── sync_states: who holds the run, and when it last failed ──────────────────
ALTER TABLE sync_states ADD COLUMN IF NOT EXISTS running_owner TEXT;
ALTER TABLE sync_states ADD COLUMN IF NOT EXISTS running_started_at TIMESTAMPTZ;
ALTER TABLE sync_states ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- ── domain_outbox: idempotent local delivery after the local commit ──────────
-- Notifications, search indexing, rules and CE updates are enqueued inside the
-- same transaction as the local change, so a delivery retry can never send a
-- second mail: the row exists only if the local commit did.
CREATE TABLE IF NOT EXISTS domain_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic           VARCHAR(64) NOT NULL,
  dedupe_key      TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  claim_token     UUID,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One delivery per logical event: re-enqueuing the same event is a no-op.
  UNIQUE (user_id, topic, dedupe_key)
);

CREATE INDEX IF NOT EXISTS domain_outbox_due_idx
  ON domain_outbox (status, next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS domain_outbox_lease_idx
  ON domain_outbox (status, lease_expires_at)
  WHERE status = 'processing';
