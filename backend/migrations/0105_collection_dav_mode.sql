-- P11: per-collection DAV visibility and maximum mode (plan §17.1, W05).
--
-- A collection is exported over DAV only when the user enables it. The default is
-- `read_write`, which is exactly the behaviour existing local collections already
-- had, so an upgrade never hides or exposes anything new. New collections created
-- from an external source default to `off` (the importer sets it explicitly):
-- connecting a remote source must not publish it to devices implicitly.
--
-- `dav_mode` can only narrow what the source already allows: a read-only calendar
-- stays read-only even when its DAV mode says read_write. Turning a collection off
-- must hide it from discovery and from every direct URL, not just from the list.
--
-- Expand-only: two defaulted columns and two checks; no row is rewritten.

ALTER TABLE calendars ADD COLUMN IF NOT EXISTS dav_mode VARCHAR(16) NOT NULL DEFAULT 'read_write';
ALTER TABLE address_books ADD COLUMN IF NOT EXISTS dav_mode VARCHAR(16) NOT NULL DEFAULT 'read_write';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendars_dav_mode_check') THEN
    ALTER TABLE calendars ADD CONSTRAINT calendars_dav_mode_check
      CHECK (dav_mode IN ('off', 'read_only', 'read_write'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'address_books_dav_mode_check') THEN
    ALTER TABLE address_books ADD CONSTRAINT address_books_dav_mode_check
      CHECK (dav_mode IN ('off', 'read_only', 'read_write'));
  END IF;
END $$;

-- Discovery only ever asks for exported collections.
CREATE INDEX IF NOT EXISTS calendars_user_dav_idx
  ON calendars (owner_user_id) WHERE dav_mode <> 'off';
CREATE INDEX IF NOT EXISTS address_books_user_dav_idx
  ON address_books (user_id) WHERE dav_mode <> 'off';
