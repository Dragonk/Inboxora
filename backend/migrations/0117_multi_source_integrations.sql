-- DAV-01, first step: let a user hold more than one source of the same provider.
--
-- `user_integrations` shipped with `UNIQUE (user_id, provider)`, so a user could connect exactly one CardDAV
-- server and one CalDAV server — several were impossible to represent, never mind to synchronise. The audit's
-- requirement is a source model, and this is its additive first step: the table can hold several rows per provider,
-- while the *existing* single-source behaviour is preserved exactly, so nothing that reads it today changes.
--
-- How: the constraint is replaced by two partial unique indexes. One keeps "at most one row per provider that has
-- no label" — everything written before this migration, and every reader that today expects a single row, still
-- sees exactly one and cannot accidentally get a second. The other makes a label unique per user and provider, so
-- additional sources are addressed by their own name. Nothing is rewritten, no row is touched, and an application
-- version that does not know about `label` reads the same rows as before.
ALTER TABLE user_integrations DROP CONSTRAINT IF EXISTS user_integrations_user_id_provider_key;

-- A human name for the source. NULL for every row that exists today, and for the single-source form still.
ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS label TEXT;

-- The unlabelled row per provider: exactly the guarantee the dropped constraint gave, so existing code that
-- inserts or looks up "the" integration for a provider keeps its behaviour.
CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_unlabelled_key
  ON user_integrations (user_id, provider) WHERE label IS NULL;

-- Labelled rows are distinct sources of the same provider.
CREATE UNIQUE INDEX IF NOT EXISTS user_integrations_labelled_key
  ON user_integrations (user_id, provider, label) WHERE label IS NOT NULL;
