-- Per-user plugin activation (v3.0 plugin platform).
--
-- Activation now lives in users.preferences.enabledPlugins (a JSONB array of plugin ids).
-- Absent/empty = the plugin is OFF for that user. GTD is becoming an opt-in plugin (default off
-- for new users), so grandfather every EXISTING user who already relies on GTD — anyone with at
-- least one gtd_enabled email account — by activating the 'gtd' plugin for them. This preserves
-- their GTD experience across the switch; everyone else starts with GTD off and can activate it
-- from the Plugins settings section.
--
-- Idempotent: only sets enabledPlugins for users who don't already have the key, and only when
-- they have a gtd_enabled account. Re-running is a no-op.
UPDATE users u
   SET preferences = jsonb_set(
         COALESCE(u.preferences, '{}'::jsonb),
         '{enabledPlugins}',
         '["gtd"]'::jsonb
       )
 WHERE (u.preferences -> 'enabledPlugins') IS NULL
   AND EXISTS (
         SELECT 1 FROM email_accounts a
          WHERE a.user_id = u.id AND a.gtd_enabled = true
       );
