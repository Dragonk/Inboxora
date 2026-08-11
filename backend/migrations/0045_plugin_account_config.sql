-- Per-account plugin config (v3.0 plugin platform).
--
-- A plugin's configuration for a specific account (GTD: whether it's on for the account + its
-- state→folder overrides) was stored as GTD-specific columns on email_accounts (gtd_enabled,
-- gtd_folders) — a core↔plugin leak. Move it to a generic, plugin-namespaced table keyed by
-- (plugin_id, account_id), cascade-cleaned when the account is deleted.
--
-- Accessed only through the getAccountConfig / setAccountConfig capabilities. The email_accounts
-- columns are migrated here now and dropped in a later migration, after the code cutover.
CREATE TABLE IF NOT EXISTS plugin_account_config (
  plugin_id   TEXT NOT NULL,
  account_id  UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, account_id)
);

-- Carry existing GTD per-account config across. gtd_folders defaults to '{}' (meaning "all
-- defaults"); gtd_enabled defaults to false. Every account gets a row so getAccountConfig has a
-- consistent source (a missing row reads as an empty config = GTD off + default folders).
INSERT INTO plugin_account_config (plugin_id, account_id, config)
SELECT 'gtd', id,
       jsonb_build_object('enabled', COALESCE(gtd_enabled, false),
                          'folders', COALESCE(gtd_folders, '{}'::jsonb))
  FROM email_accounts
ON CONFLICT (plugin_id, account_id) DO NOTHING;
