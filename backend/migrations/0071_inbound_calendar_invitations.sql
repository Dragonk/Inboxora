-- Parsed inbound iCalendar invitations are bound to the physical mail copy that carried them.
-- The original ICS remains available for a lossless invitation lifecycle without writing remotely.
CREATE TABLE IF NOT EXISTS inbound_calendar_invitations (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('REQUEST', 'CANCEL')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'cancelled')),
  CHECK (
    (method = 'REQUEST' AND state = 'pending')
    OR (method = 'CANCEL' AND state = 'cancelled')
  ),
  uid TEXT NOT NULL,
  recurrence_id TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  summary TEXT,
  organizer TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  all_day BOOLEAN,
  timezone TEXT,
  raw_ical TEXT NOT NULL CHECK (octet_length(raw_ical) <= 1048576),
  parsed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inbound_calendar_invitations_uid_idx
  ON inbound_calendar_invitations (uid, recurrence_id);
