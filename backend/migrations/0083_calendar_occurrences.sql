-- Materialised calendar occurrences.
--
-- Why this exists: a recurring series must be expanded from its own start date — the rule
-- iterator cannot be re-seeded at the requested window without changing the occurrences
-- (it resets the INTERVAL phase, re-anchors MONTHLY/YEARLY rules, drops the time of day and
-- ignores COUNT). Measured on the library itself, most rules disagreed with a full walk.
-- That walk costs ~10-20 us per occurrence, so a daily series running since 2018 takes
-- ~50-90 ms *every* time it is expanded, and a calendar with twenty such series spent
-- ~750 ms of CPU per cold window. Caching could remove the repetition but never the walk,
-- so the first view of each month stayed slow.
--
-- Expanding once, off the request path, and reading the result as an indexed range scan
-- removes the walk from the read entirely.
--
-- Two tables:
--   * calendar_occurrences holds the concrete instances;
--   * calendar_occurrence_state records, per event, whether the materialised rows are
--     current and which time range they cover. Keeping the bookkeeping in its own table
--     means the change trigger can be unconditional (no column list to keep in sync) and
--     the worker's own writes to the state table cannot re-trigger it.
--
-- Overridden fields are stored as NULL = "inherit from the event". Only RECURRENCE-ID
-- exceptions that actually change a field carry a value, so a description is never
-- duplicated across hundreds of occurrences.

CREATE TABLE IF NOT EXISTS calendar_occurrences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  calendar_id   UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- '' for a single (non-recurring) event's only occurrence, otherwise the RECURRENCE-ID
  -- exactly as the series spells it, so the reader can address one instance.
  recurrence_id TEXT NOT NULL DEFAULT '',
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  all_day       BOOLEAN NOT NULL DEFAULT false,
  timezone      TEXT,
  -- NULL means "use the parent event's value"; a value means this instance overrides it.
  summary       TEXT,
  description   TEXT,
  location      TEXT,
  url           TEXT,
  organizer     TEXT,
  attendees     JSONB,
  UNIQUE (event_id, recurrence_id)
);

-- The read is always "this user, this range", so the range index leads with the user.
CREATE INDEX IF NOT EXISTS calendar_occurrences_user_range_idx
  ON calendar_occurrences (user_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS calendar_occurrences_calendar_range_idx
  ON calendar_occurrences (calendar_id, starts_at, ends_at);
-- The fast read looks up whether an event still needs on-the-fly expansion.
CREATE INDEX IF NOT EXISTS calendar_occurrences_event_idx
  ON calendar_occurrences (event_id);

CREATE TABLE IF NOT EXISTS calendar_occurrence_state (
  event_id   UUID PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The window the materialised rows actually cover. A read outside it must not trust them.
  built_from TIMESTAMPTZ,
  built_to   TIMESTAMPTZ,
  -- The event version these rows were expanded from. A build that finishes after the event was
  -- edited underneath it must NOT clear `dirty`: its rows describe the previous version. This
  -- is what stops an edit that lands mid-build from being silently reverted.
  built_etag TEXT,
  -- True until the worker has materialised the event at least once, and again after any change.
  dirty      BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The worker's queue: everything needing (re)building.
CREATE INDEX IF NOT EXISTS calendar_occurrence_state_dirty_idx
  ON calendar_occurrence_state (dirty, updated_at)
  WHERE dirty;
-- A read asks "is this event covered for my window?", so the lookup is by event id (the PK).

-- Mark an event as needing (re)materialisation whenever its own row changes. Unconditional
-- on purpose: any write path — REST create/update, CalDAV PUT, invitation import, external
-- sync — goes through this table, and a column list would silently miss a future one.
-- Writing to calendar_occurrence_state does not touch calendar_events, so the worker clearing
-- the flag cannot re-arm it.
CREATE OR REPLACE FUNCTION mark_calendar_occurrences_dirty() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The FK cascade already removed the occurrences and the state row.
    RETURN OLD;
  END IF;
  INSERT INTO calendar_occurrence_state (event_id, user_id, dirty, updated_at)
  VALUES (NEW.id, NEW.user_id, true, NOW())
  ON CONFLICT (event_id) DO UPDATE SET dirty = true, updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS calendar_events_occurrences_dirty ON calendar_events;
CREATE TRIGGER calendar_events_occurrences_dirty
AFTER INSERT OR UPDATE ON calendar_events
FOR EACH ROW EXECUTE FUNCTION mark_calendar_occurrences_dirty();

-- Seed the state for every existing event so the worker builds them on first run. Without
-- this an upgraded instance would serve nothing until something happened to change.
INSERT INTO calendar_occurrence_state (event_id, user_id, dirty)
SELECT id, user_id, true FROM calendar_events
ON CONFLICT (event_id) DO NOTHING;
