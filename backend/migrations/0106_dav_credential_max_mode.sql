-- P11: maximum DAV mode per application password (plan §17.1, W05).
--
-- A device password may only narrow what the collection already allows. The
-- ceiling belongs to the credential, not to the device: a read-only credential
-- cannot write even to a read-write collection, and it never widens one. The
-- default `read_write` keeps every existing credential exactly as capable as it
-- was before this migration.
--
-- Expand-only: one defaulted column and one check; no row is rewritten.

ALTER TABLE dav_app_passwords ADD COLUMN IF NOT EXISTS max_dav_mode VARCHAR(16) NOT NULL DEFAULT 'read_write';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dav_app_passwords_max_dav_mode_check') THEN
    ALTER TABLE dav_app_passwords ADD CONSTRAINT dav_app_passwords_max_dav_mode_check
      CHECK (max_dav_mode IN ('read_only', 'read_write'));
  END IF;
END $$;
