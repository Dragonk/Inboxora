-- Metadata-only cutover. No large table rewrite occurs during startup.
-- Deploy all backend workers together: pre-0146 readers do not understand the new
-- journal snapshots. Clients holding earlier DAV tokens must do one full sync.
ALTER TABLE calendars ADD COLUMN sync_min_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE address_books ADD COLUMN sync_min_version BIGINT NOT NULL DEFAULT 0;

CREATE TABLE storage_maintenance (
  task TEXT PRIMARY KEY,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO storage_maintenance(task, progress)
VALUES ('baseline', jsonb_build_object('database_before_bytes', pg_database_size(current_database()),
  'measured_at', clock_timestamp()));

-- Keep retired files until the background worker can release them with a short
-- lock timeout. No live event/contact/message data is in these tables.
ALTER TABLE calendar_sync_changes RENAME TO calendar_sync_changes_legacy_0146;
ALTER TABLE contact_sync_changes RENAME TO contact_sync_changes_legacy_0146;

CREATE TABLE calendar_sync_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  recurrence_id TEXT NOT NULL DEFAULT '',
  dav_filename TEXT NOT NULL,
  version BIGINT NOT NULL,
  etag TEXT,
  deleted BOOLEAN NOT NULL,
  raw_ical TEXT CHECK (raw_ical IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calendar_sync_compact_pk PRIMARY KEY(calendar_id, dav_filename, recurrence_id),
  CONSTRAINT calendar_sync_compact_version UNIQUE(calendar_id, version)
);
CREATE TABLE contact_sync_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  address_book_id UUID NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  version BIGINT NOT NULL,
  etag TEXT,
  deleted BOOLEAN NOT NULL,
  vcard TEXT CHECK (vcard IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contact_sync_compact_pk PRIMARY KEY(address_book_id, filename),
  CONSTRAINT contact_sync_compact_version UNIQUE(address_book_id, version)
);

-- Invalidate every pre-cutover token, including one at the previous tip. Full
-- collection reads come from canonical rows, never from the retired history.
UPDATE calendars SET sync_min_version = sync_version + 1, sync_version = sync_version + 1,
  sync_token = 'sync-' || (sync_version + 1)::text;
UPDATE address_books SET sync_min_version = sync_version + 1, sync_version = sync_version + 1,
  sync_token = gen_random_uuid()::text;

CREATE OR REPLACE FUNCTION record_calendar_sync_change() RETURNS TRIGGER AS $$
DECLARE next_version BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND
     (OLD.calendar_id, OLD.uid, OLD.recurrence_id, COALESCE(OLD.dav_filename, OLD.uid || '.ics'), OLD.etag, OLD.raw_ical)
     IS NOT DISTINCT FROM
     (NEW.calendar_id, NEW.uid, NEW.recurrence_id, COALESCE(NEW.dav_filename, NEW.uid || '.ics'), NEW.etag, NEW.raw_ical)
  THEN RETURN NEW; END IF;

  -- A rename/move is also a deletion at the old DAV URL. Never lose its tombstone.
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
     (OLD.calendar_id, COALESCE(OLD.dav_filename, OLD.uid || '.ics'), OLD.recurrence_id)
     IS DISTINCT FROM
     (NEW.calendar_id, COALESCE(NEW.dav_filename, NEW.uid || '.ics'), NEW.recurrence_id)) THEN
    UPDATE calendars SET sync_version = sync_version + 1,
      sync_token = 'sync-' || (sync_version + 1)::text, updated_at = NOW()
      WHERE id = OLD.calendar_id RETURNING sync_version INTO next_version;
    IF FOUND THEN
      INSERT INTO calendar_sync_changes(calendar_id, uid, recurrence_id, dav_filename, version, deleted)
      VALUES(OLD.calendar_id, OLD.uid, OLD.recurrence_id, COALESCE(OLD.dav_filename, OLD.uid || '.ics'), next_version, true)
      ON CONFLICT(calendar_id, dav_filename, recurrence_id) DO UPDATE SET
        uid = EXCLUDED.uid, version = EXCLUDED.version, deleted = true, etag = NULL, created_at = NOW();
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE calendars SET sync_version = sync_version + 1,
      sync_token = 'sync-' || (sync_version + 1)::text, updated_at = NOW()
      WHERE id = NEW.calendar_id RETURNING sync_version INTO next_version;
    IF FOUND THEN
      INSERT INTO calendar_sync_changes(calendar_id, uid, recurrence_id, dav_filename, version, etag, deleted)
      VALUES(NEW.calendar_id, NEW.uid, NEW.recurrence_id, COALESCE(NEW.dav_filename, NEW.uid || '.ics'), next_version, NEW.etag, false)
      ON CONFLICT(calendar_id, dav_filename, recurrence_id) DO UPDATE SET
        uid = EXCLUDED.uid, version = EXCLUDED.version, deleted = false, etag = EXCLUDED.etag, created_at = NOW();
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_contact_sync_change() RETURNS TRIGGER AS $$
DECLARE next_version BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND
     (OLD.address_book_id, COALESCE(OLD.dav_filename, OLD.uid || '.vcf'), OLD.etag, OLD.vcard)
     IS NOT DISTINCT FROM
     (NEW.address_book_id, COALESCE(NEW.dav_filename, NEW.uid || '.vcf'), NEW.etag, NEW.vcard)
  THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
     (OLD.address_book_id, COALESCE(OLD.dav_filename, OLD.uid || '.vcf')) IS DISTINCT FROM
     (NEW.address_book_id, COALESCE(NEW.dav_filename, NEW.uid || '.vcf'))) THEN
    UPDATE address_books SET sync_version = sync_version + 1, sync_token = gen_random_uuid()::text, updated_at = NOW()
      WHERE id = OLD.address_book_id RETURNING sync_version INTO next_version;
    IF FOUND THEN
      INSERT INTO contact_sync_changes(address_book_id, filename, version, deleted)
      VALUES(OLD.address_book_id, COALESCE(OLD.dav_filename, OLD.uid || '.vcf'), next_version, true)
      ON CONFLICT(address_book_id, filename) DO UPDATE SET
        version = EXCLUDED.version, deleted = true, etag = NULL, created_at = NOW();
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    UPDATE address_books SET sync_version = sync_version + 1, sync_token = gen_random_uuid()::text, updated_at = NOW()
      WHERE id = NEW.address_book_id RETURNING sync_version INTO next_version;
    IF FOUND THEN
      INSERT INTO contact_sync_changes(address_book_id, filename, version, etag, deleted)
      VALUES(NEW.address_book_id, COALESCE(NEW.dav_filename, NEW.uid || '.vcf'), next_version, NEW.etag, false)
      ON CONFLICT(address_book_id, filename) DO UPDATE SET
        version = EXCLUDED.version, deleted = false, etag = EXCLUDED.etag, created_at = NOW();
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE calendar_sync_changes IS 'Latest metadata/tombstone per DAV resource; payload comes from calendar_events in one read snapshot. Retention advances calendars.sync_min_version.';
COMMENT ON TABLE contact_sync_changes IS 'Latest metadata/tombstone per DAV resource; payload comes from contacts in one read snapshot. Retention advances address_books.sync_min_version.';
ALTER TABLE messages ADD COLUMN body_prefetch_after TIMESTAMPTZ;
