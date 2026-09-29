-- Additive only: existing mailbox state and provider cursors are retained.
ALTER TABLE email_accounts ADD COLUMN last_folder_sync TIMESTAMPTZ;
ALTER TABLE email_accounts ADD COLUMN reindex_requested_at TIMESTAMPTZ;
ALTER TABLE email_accounts ADD COLUMN reindex_completed_at TIMESTAMPTZ;
ALTER TABLE email_accounts ADD COLUMN reindex_error TEXT;
ALTER TABLE sync_states ADD COLUMN reindex_started_at TIMESTAMPTZ;
ALTER TABLE sync_states ADD COLUMN reindex_finished_at TIMESTAMPTZ;
