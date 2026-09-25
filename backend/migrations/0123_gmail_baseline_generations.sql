-- FV-03/FV-04: a resumable Gmail baseline needs durable membership rather than
-- an in-memory page set. Apply after 0122 and before deploying this synchronizer.
CREATE TABLE IF NOT EXISTS gmail_baseline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_state_id UUID NOT NULL REFERENCES sync_states(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  start_history_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS gmail_baseline_runs_one_active_per_state_idx
  ON gmail_baseline_runs (sync_state_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS gmail_baseline_seen (
  baseline_run_id UUID NOT NULL REFERENCES gmail_baseline_runs(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  PRIMARY KEY (baseline_run_id, provider_message_id)
);
