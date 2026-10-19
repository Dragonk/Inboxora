-- Per-calendar reminder delivery mode: a regular notification or a full alarm,
-- inherited from the global preference (users.preferences.calendarRemindersMode)
-- while NULL. Read by the reminder cascade in calendarReminders.ts.

ALTER TABLE calendars
  ADD COLUMN IF NOT EXISTS notify_mode TEXT
    CHECK (notify_mode IS NULL OR notify_mode IN ('notification', 'alarm'));
