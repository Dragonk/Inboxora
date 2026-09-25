-- Per-collection write-back permission (P07d/P09/P10).
--
-- `integration_collections.user_access` had two values, `source` and `read_only`, and neither could
-- express "the user has enabled Inboxora to write this collection back to its origin" — so the
-- capability model had no input for the user's choice and a provider collection could only ever be
-- read-only (or, once an adapter declared `writeThrough`, writable without the user asking).
--
-- `read_write` is that missing value. It is **not** a default: every existing and newly pulled
-- collection keeps its current value, so nothing becomes writable because of this migration. A
-- collection becomes writable only when the user opts in **and** `source_access` says the source
-- itself permits writes.
ALTER TABLE integration_collections DROP CONSTRAINT IF EXISTS integration_collections_user_access_check;
ALTER TABLE integration_collections ADD CONSTRAINT integration_collections_user_access_check
  CHECK (user_access IN ('source', 'read_only', 'read_write'));
