-- Drop the legacy gtd_pets table (v3.0 plugin platform).
--
-- The GTD Inbox-Zero pet was migrated to the generic plugin_data store; gtd_pets was kept only
-- for reversibility during the transition. No code path reads or writes it anymore (the last
-- reference — a user-delete cleanup — now removes the pet through the plugin storage capability),
-- so it is safe to drop. Idempotent.
DROP TABLE IF EXISTS gtd_pets;
