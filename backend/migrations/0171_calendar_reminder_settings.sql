-- Calendar event reminders (native Android). The reminder a device schedules
-- is resolved by a three-level cascade, evaluated in calendarReminders.ts:
--
--   1. global user preference (users.preferences.calendarReminders*): when
--      disabled, no event notification or alarm is ever produced;
--   2. per-calendar default (calendars.notify_enabled): off silences the whole
--      calendar; notify_minutes is the calendar's default lead time (NULL =
--      inherit the global default);
--   3. per-event override (calendar_event_reminder_overrides): NULL values
--      inherit from the calendar; enabled = false silences one event.
--
-- Overrides are Inboxora-local presentation state: they are deliberately NOT
-- written back to CalDAV/Google/Microsoft VALARM data.

ALTER TABLE calendars
  ADD COLUMN IF NOT EXISTS notify_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_minutes INT
    CHECK (notify_minutes IS NULL OR (notify_minutes >= 0 AND notify_minutes <= 10080));

CREATE TABLE IF NOT EXISTS calendar_event_reminder_overrides (
  event_id       UUID PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled        BOOLEAN,
  minutes_before INT CHECK (minutes_before IS NULL OR (minutes_before >= 0 AND minutes_before <= 10080)),
  mode           TEXT CHECK (mode IN ('notification', 'alarm')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS calendar_event_reminder_overrides_user_idx
  ON calendar_event_reminder_overrides (user_id, updated_at DESC);
