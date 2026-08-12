-- Drop the legacy GTD per-account columns (v3.0 plugin platform).
--
-- gtd_enabled / gtd_folders moved to the generic plugin_account_config table in 0045, and the
-- entire code path now reads/writes only that store: getGtdConfig, the accounts API
-- enrich/persist hooks, the sync-engine gates (registry.hasActiveAsync + async sync.isActive), and
-- the mail.js sibling fan-out gate. The columns have been dead since the 3e cutover and their
-- values were carried across in 0045 — verified live (config rows match the columns 1:1). Drop them
-- so email_accounts carries no plugin-specific schema and GTD owns its config end to end.
ALTER TABLE email_accounts
  DROP COLUMN IF EXISTS gtd_enabled,
  DROP COLUMN IF EXISTS gtd_folders;
