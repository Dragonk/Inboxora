-- P07b: link a provider mail-folder collection to the local folder it projects.
--
-- Calendar and address-book collections already carry `local_calendar_id` and
-- `local_address_book_id`, so a synced collection can be found again by its local
-- counterpart. Mail folders had no equivalent, which left a folder pulled from
-- Microsoft Graph identified only by a path the provider is free to change. The
-- Graph folder **id** is immutable, so the remote side of that link lives in
-- `integration_collections.remote_id` and this column holds the local `folders.id`.
--
-- Expand-only: the column is nullable, no existing row is rewritten, and a
-- collection whose value is NULL behaves exactly as it did before this migration.
-- Apply in order, after 0106, before rolling out the application.

ALTER TABLE integration_collections ADD COLUMN IF NOT EXISTS local_folder_id UUID
  REFERENCES folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS integration_collections_local_folder_idx
  ON integration_collections (local_folder_id)
  WHERE local_folder_id IS NOT NULL;
