-- Durable per-calendar change log for RFC 6578 CalDAV incremental sync.
-- Event triggers keep REST and DAV mutations in one database transaction and retain
-- deleted object tombstones until an explicit future retention policy is introduced.
ALTER TABLE calendars ADD COLUMN IF NOT EXISTS sync_version BIGINT NOT NULL DEFAULT 0;
UPDATE calendars SET sync_version = 0, sync_token = 'sync-0';

CREATE TABLE IF NOT EXISTS calendar_sync_changes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  calendar_id   UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  uid           TEXT NOT NULL,
  recurrence_id TEXT NOT NULL DEFAULT '',
  version       BIGINT NOT NULL,
  etag          TEXT,
  deleted       BOOLEAN NOT NULL DEFAULT false,
  raw_ical      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (calendar_id, version)
);
CREATE INDEX IF NOT EXISTS calendar_sync_changes_incremental_idx
  ON calendar_sync_changes (calendar_id, version);

CREATE OR REPLACE FUNCTION record_calendar_sync_change() RETURNS TRIGGER AS $$
DECLARE
  changed_calendar_id UUID;
  changed_uid TEXT;
  changed_recurrence_id TEXT;
  changed_etag TEXT;
  changed_raw_ical TEXT;
  next_version BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_calendar_id := OLD.calendar_id;
    changed_uid := OLD.uid;
    changed_recurrence_id := OLD.recurrence_id;
    changed_etag := NULL;
    changed_raw_ical := NULL;
  ELSE
    changed_calendar_id := NEW.calendar_id;
    changed_uid := NEW.uid;
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

  INSERT INTO calendar_sync_changes (calendar_id, uid, recurrence_id, version, etag, deleted, raw_ical)
  VALUES (changed_calendar_id, changed_uid, changed_recurrence_id, next_version, changed_etag, TG_OP = 'DELETE', changed_raw_ical);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS calendar_events_sync_change ON calendar_events;
CREATE TRIGGER calendar_events_sync_change
AFTER INSERT OR UPDATE OR DELETE ON calendar_events
FOR EACH ROW EXECUTE FUNCTION record_calendar_sync_change();
