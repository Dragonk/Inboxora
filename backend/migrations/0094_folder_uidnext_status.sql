-- Store the server's UIDNEXT watermark alongside authoritative STATUS counts.
-- Apply before deploying code that reads or writes folders.uid_next.
ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS uid_next BIGINT;
