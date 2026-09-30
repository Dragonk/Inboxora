-- no-transaction
-- Bound the legacy-header scan by immutable account/UUID order without indexing
-- or detoasting the header content. A new dedicated index avoids relying on the
-- partial Graph attachment index, which does not cover every message.
-- Retrying a cancelled concurrent build replaces only this dedicated index.
DROP INDEX CONCURRENTLY IF EXISTS messages_header_repair_account_id_idx;
CREATE INDEX CONCURRENTLY messages_header_repair_account_id_idx ON messages (account_id, id);
