-- Local calendar objects shared by the Inboxora GUI and the built-in CalDAV server.
-- Imported CalDAV/ICS sources will use the same projection table later but remain read-only.
CREATE TABLE IF NOT EXISTS calendar_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id   UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uid           TEXT NOT NULL,
  recurrence_id TEXT NOT NULL DEFAULT '',
  raw_ical      TEXT,
  etag          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  summary       TEXT,
  description   TEXT,
  location      TEXT,
  url           TEXT,
  organizer     TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  all_day       BOOLEAN NOT NULL DEFAULT false,
  timezone      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calendar_events_time_range CHECK (ends_at >= starts_at),
  UNIQUE (calendar_id, uid, recurrence_id)
);

CREATE INDEX IF NOT EXISTS calendar_events_user_range_idx
  ON calendar_events (user_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS calendar_events_calendar_range_idx
  ON calendar_events (calendar_id, starts_at, ends_at);
