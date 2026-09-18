-- Durable per-account maintenance state for one-time repairs/migrations.
-- Replaces the pseudo-folder marker row in `folders` (which syncFolders would
-- prune and backfillAllFolders would try to SELECT on IMAP). Apply before
-- deploying code that reads/writes account_maintenance_state.
CREATE TABLE IF NOT EXISTS account_maintenance_state (
  account_id   UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  completed_at TIMESTAMPTZ,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, key)
);
