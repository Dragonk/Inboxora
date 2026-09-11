-- A recurring calendar object has to be found by an index, not by scanning the table.
--
-- The read paths that feed a view select "events overlapping this window, plus every
-- recurring series" because a series' occurrences can fall inside the window even when
-- its base event does not. That second half was expressed as a regular expression over
-- `raw_ical`:
--
--     OR e.raw_ical ~* '(RRULE|RDATE|RECURRENCE-ID)[;:]'
--
-- A regex over an unindexed TEXT column cannot be satisfied by any index, so the planner
-- had no choice but to scan every event the user owns — and to detoast `raw_ical` for
-- each one, which is the expensive part for large iCalendar bodies. Measured on 20k
-- events for a single user the seq scan removed 20 000 rows per loop and cost ~123 ms,
-- before any recurrence was even expanded. It grows linearly with mailbox age.
--
-- Storing the answer as a real column makes both halves of the OR indexable.
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS recurring BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the same expression the queries used, so no behaviour changes. COALESCE
-- for the same reason as the trigger below: a NULL raw_ical must read as "not recurring"
-- rather than as NULL, which this NOT NULL column would reject.
UPDATE calendar_events
   SET recurring = COALESCE(raw_ical ~* '(RRULE|RDATE|RECURRENCE-ID)[;:]', false)
 WHERE recurring IS DISTINCT FROM COALESCE(raw_ical ~* '(RRULE|RDATE|RECURRENCE-ID)[;:]', false);

-- Maintain it on every write. A trigger rather than application code because there are
-- five independent write paths (REST create/update, CalDAV PUT, invitation import,
-- external-source sync, contact-date generation) and a new one must not have to remember.
-- `UPDATE OF raw_ical` keeps the regex off updates that cannot change the answer.
--
-- COALESCE matters: a NULL raw_ical makes the match NULL, and assigning NULL to this
-- NOT NULL column would reject the insert outright — an event with no stored iCalendar
-- body is simply not recurring.
CREATE OR REPLACE FUNCTION set_calendar_event_recurring() RETURNS TRIGGER AS $$
BEGIN
  NEW.recurring := COALESCE(NEW.raw_ical ~* '(RRULE|RDATE|RECURRENCE-ID)[;:]', false);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS calendar_events_set_recurring ON calendar_events;
CREATE TRIGGER calendar_events_set_recurring
BEFORE INSERT OR UPDATE OF raw_ical ON calendar_events
FOR EACH ROW EXECUTE FUNCTION set_calendar_event_recurring();

-- Partial indexes: only recurring rows are indexed, and only the column the two read
-- paths filter on first. The planner turns the OR into a BitmapOr of the existing range
-- index and this one, so neither branch scans the table.
CREATE INDEX IF NOT EXISTS calendar_events_user_recurring_idx
  ON calendar_events (user_id) WHERE recurring;
CREATE INDEX IF NOT EXISTS calendar_events_calendar_recurring_idx
  ON calendar_events (calendar_id) WHERE recurring;
