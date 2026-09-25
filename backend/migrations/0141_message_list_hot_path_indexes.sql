-- no-transaction
--
-- Restore the indexed threaded-list hot path.
--
-- A handful of historical rows may contain an empty thread_id. thread_key is a
-- generated column based on thread_id, so normalizing those values to NULL makes
-- it fall back to the physical message id just like all other unthreaded rows.
UPDATE messages
SET thread_id = NULL
WHERE thread_id IS NOT NULL
  AND btrim(thread_id) = '';

-- Folder membership is queried as
-- (account_id, folder_path, message_id). The old index stopped at folder_path,
-- forcing an extra heap/filter step for large Gmail mailboxes.
CREATE INDEX CONCURRENTLY message_labels_folder_message_idx
  ON message_labels (account_id, folder_path, message_id);
