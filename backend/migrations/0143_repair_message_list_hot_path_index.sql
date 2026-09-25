-- no-transaction
--
-- Forward repair for the first dev revision of 0141.
--
-- CREATE INDEX CONCURRENTLY can leave an invalid same-named index when its
-- build is interrupted. 0141 intentionally stays immutable because databases
-- may already have recorded its checksum. Rebuild the index in a later
-- migration so both fresh and already-upgraded databases converge on a valid
-- index.
DROP INDEX CONCURRENTLY IF EXISTS message_labels_folder_message_idx;

CREATE INDEX CONCURRENTLY message_labels_folder_message_idx
  ON message_labels (account_id, folder_path, message_id);
