-- DAV resource paths are chosen by the client; the embedded UID is independent.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS dav_filename TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS dav_filename TEXT;
ALTER TABLE calendar_sync_changes ADD COLUMN IF NOT EXISTS dav_filename TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_dav_filename_idx ON contacts(address_book_id, (COALESCE(dav_filename, uid || '.vcf')));
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_dav_filename_idx ON calendar_events(calendar_id, (COALESCE(dav_filename, uid || '.ics')), recurrence_id);

CREATE OR REPLACE FUNCTION record_calendar_sync_change() RETURNS TRIGGER AS $$
DECLARE
  changed_calendar_id UUID;
  changed_uid TEXT;
  changed_recurrence_id TEXT;
  changed_etag TEXT;
  changed_raw_ical TEXT;
  next_version BIGINT;
  changed_filename TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_calendar_id := OLD.calendar_id;
    changed_uid := OLD.uid;
    changed_filename := OLD.dav_filename;
    changed_recurrence_id := OLD.recurrence_id;
    changed_etag := NULL;
    changed_raw_ical := NULL;
  ELSE
    changed_calendar_id := NEW.calendar_id;
    changed_uid := NEW.uid;
    changed_filename := NEW.dav_filename;
    changed_recurrence_id := NEW.recurrence_id;
    changed_etag := NEW.etag;
    changed_raw_ical := NEW.raw_ical;
  END IF;

  UPDATE calendars
     SET sync_version = sync_version + 1,
         sync_token = 'sync-' || (sync_version + 1)::text,
         updated_at = NOW()
   WHERE id = changed_calendar_id
   RETURNING sync_version INTO next_version;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  INSERT INTO calendar_sync_changes (calendar_id, uid, recurrence_id, version, etag, deleted, raw_ical, dav_filename)
  VALUES (changed_calendar_id, changed_uid, changed_recurrence_id, next_version, changed_etag, TG_OP = 'DELETE', changed_raw_ical, changed_filename);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

