// Calendar event reminders for the native clients (and the settings UI).
//
// A reminder is resolved by a three-level cascade, mirroring the columns added
// in migration 0171:
//
//   1. users.preferences.calendarReminders* (global): the default for every
//      event without a per-event override;
//   2. calendars.notify_enabled / notify_minutes / notify_mode: off silences
//      the whole calendar; NULL minutes/mode inherit the global default;
//   3. calendar_event_reminder_overrides: NULL fields inherit from the calendar,
//      enabled = false silences one event, enabled = true keeps it ringing even
//      when the calendar (or the global default) is muted, minutes_before
//      overrides the lead time, mode picks between a notification and an alarm.
//
// The overrides are Inboxora-local presentation state. They are deliberately
// NOT written back to CalDAV/Google/Microsoft VALARM data: providers disagree
// about what a VALARM means, and writing alarms into someone else's calendar
// would leak Inboxora-local preferences to every attendee of the event.
//
// Time handling relies on the materialised occurrence layer: calendar_occurrences
// already carries resolved timestamptz instances, so no per-device timezone
// expansion is needed here. Uncovered series (a lagging materialisation worker)
// fall back to the same on-the-fly projection the events route uses, so a
// reminder can never be missed because the worker has not reached a series yet.

import { query } from './db.js';
import { EVENT_COLUMNS, coveragePredicate } from './calendarOccurrences.js';
import { projectCalendarResources } from './calendarProjectionPool.js';

export const DEFAULT_REMINDER_MINUTES = 30;
export const MAX_REMINDER_MINUTES = 10080; // 7 days
export const REMINDER_MODES = ['notification', 'alarm'] as const;
export type ReminderMode = typeof REMINDER_MODES[number];

export interface CalendarReminderSettings {
  enabled: boolean;
  minutes: number;
  mode: ReminderMode;
}

export interface UpcomingReminder {
  key: string;
  eventId: string;
  calendarId: string;
  calendarName: string | null;
  summary: string;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  minutes: number;
  remindAt: string;
  mode: ReminderMode;
}

export interface EventReminderOverride {
  eventId: string;
  enabled: boolean | null;
  minutesBefore: number | null;
  mode: ReminderMode | null;
}

// -- Global preference slice -----------------------------------------------

export function sanitizeReminderMinutes(value: unknown): number | null {
  if (!Number.isInteger(Number(value))) return null;
  const minutes = Number(value);
  if (minutes < 0 || minutes > MAX_REMINDER_MINUTES) return null;
  return minutes;
}

export function sanitizeReminderMode(value: unknown): ReminderMode | null {
  return REMINDER_MODES.includes(value as ReminderMode) ? (value as ReminderMode) : null;
}

/** The global slice of users.preferences, with the shipped defaults. */
export async function loadCalendarReminderSettings(userId: string): Promise<CalendarReminderSettings> {
  const result = await query<{ preferences: Record<string, unknown> | null }>(
    'SELECT preferences FROM users WHERE id = $1',
    [userId],
  );
  const preferences = result.rows[0]?.preferences ?? {};
  const minutes = sanitizeReminderMinutes(preferences.calendarRemindersMinutes);
  return {
    enabled: preferences.calendarRemindersEnabled !== false,
    minutes: minutes ?? DEFAULT_REMINDER_MINUTES,
    mode: sanitizeReminderMode(preferences.calendarRemindersMode) ?? 'notification',
  };
}

// -- Per-event overrides ----------------------------------------------------

export async function getEventReminderOverride(userId: string, eventId: string): Promise<EventReminderOverride | null> {
  const result = await query(
    `SELECT r.event_id, r.enabled, r.minutes_before, r.mode
       FROM calendar_event_reminder_overrides r
       JOIN calendar_events e ON e.id = r.event_id
       JOIN calendars c ON c.id = e.calendar_id
      WHERE r.user_id = $1 AND r.event_id = $2
        AND c.user_id = $1 AND c.owner_user_id = $1`,
    [userId, eventId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    eventId: String(row.event_id),
    enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
    minutesBefore: row.minutes_before == null ? null : Number(row.minutes_before),
    mode: sanitizeReminderMode(row.mode),
  };
}

export interface ReminderOverrideInput {
  enabled?: boolean | null;
  minutesBefore?: number | null;
  mode?: ReminderMode | null;
}

/**
 * Upsert one event's override. Rows are addressed by (user, event) with the
 * calendar ownership re-checked, so a foreign event id can only ever 404.
 */
export async function setEventReminderOverride(userId: string, eventId: string, input: ReminderOverrideInput): Promise<EventReminderOverride> {
  const owned = await query(
    `SELECT e.id FROM calendar_events e
       JOIN calendars c ON c.id = e.calendar_id
      WHERE e.id = $2 AND c.user_id = $1 AND c.owner_user_id = $1`,
    [userId, eventId],
  );
  if (!owned.rows.length) {
    throw Object.assign(new Error('Calendar event not found'), { statusCode: 404 });
  }
  const enabled = input.enabled === undefined ? null : (input.enabled === null ? true : Boolean(input.enabled));
  const minutes = input.minutesBefore === undefined || input.minutesBefore === null ? null : sanitizeReminderMinutes(input.minutesBefore);
  if (minutes === null && input.minutesBefore != null) {
    throw Object.assign(new Error(`minutesBefore must be an integer from 0 to ${MAX_REMINDER_MINUTES}`), { statusCode: 400 });
  }
  const mode = input.mode === undefined || input.mode === null ? null : sanitizeReminderMode(input.mode);
  if (mode === null && input.mode != null) {
    throw Object.assign(new Error(`mode must be one of ${REMINDER_MODES.join(', ')}`), { statusCode: 400 });
  }
  const result = await query(
    `INSERT INTO calendar_event_reminder_overrides (event_id, user_id, enabled, minutes_before, mode, updated_at)
     VALUES ($2, $1, $3, $4, $5, NOW())
     ON CONFLICT (event_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           minutes_before = EXCLUDED.minutes_before,
           mode = EXCLUDED.mode,
           updated_at = NOW()
     RETURNING event_id, enabled, minutes_before, mode`,
    [userId, eventId, enabled, minutes, mode],
  );
  const row = result.rows[0];
  return {
    eventId: String(row.event_id),
    enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
    minutesBefore: row.minutes_before == null ? null : Number(row.minutes_before),
    mode: sanitizeReminderMode(row.mode),
  };
}

export async function clearEventReminderOverride(userId: string, eventId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM calendar_event_reminder_overrides r
      USING calendar_events e, calendars c
      WHERE r.event_id = e.id AND c.id = e.calendar_id
        AND r.user_id = $1 AND r.event_id = $2
        AND c.user_id = $1 AND c.owner_user_id = $1`,
    [userId, eventId],
  );
  return (result.rowCount ?? 0) > 0;
}

// -- Reminder resolution ----------------------------------------------------

interface ReminderSourceRow {
  event_id: string;
  calendar_id: string;
  recurrence_id: string;
  starts_at: Date;
  ends_at: Date;
  all_day: boolean;
  summary: string | null;
  location: string | null;
  calendar_name: string | null;
  override_enabled: boolean | null;
  override_minutes: number | null;
  override_mode: string | null;
  calendar_minutes: number | null;
  calendar_enabled: boolean | null;
  calendar_mode: string | null;
}

function reminderKey(eventId: string, recurrenceId: string): string {
  return recurrenceId ? `${eventId}@${recurrenceId}` : eventId;
}

/** Resolve the cascade for one occurrence and return it, or null when muted. */
function resolveReminder(row: ReminderSourceRow, settings: CalendarReminderSettings): UpcomingReminder | null {
  // An explicit per-event override wins over both the calendar and the global
  // default: enabled = true keeps this one event ringing even when everything
  // else is muted, enabled = false silences just this event.
  if (row.override_enabled === false) return null;
  if (row.override_enabled !== true && !(settings.enabled && row.calendar_enabled !== false)) return null;
  const minutes = row.override_minutes ?? row.calendar_minutes ?? settings.minutes;
  const mode = sanitizeReminderMode(row.override_mode) ?? sanitizeReminderMode(row.calendar_mode) ?? settings.mode;
  const startsAt = new Date(row.starts_at);
  const remindAt = new Date(startsAt.getTime() - minutes * 60_000);
  return {
    key: reminderKey(String(row.event_id), row.recurrence_id || ''),
    eventId: String(row.event_id),
    calendarId: String(row.calendar_id),
    calendarName: row.calendar_name ?? null,
    summary: row.summary || '(no title)',
    location: row.location ?? null,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    allDay: Boolean(row.all_day),
    minutes,
    remindAt: remindAt.toISOString(),
    mode,
  };
}

/**
 * Every reminder whose remind-at moment falls inside [from, to], after the
 * full cascade. The window must stay bounded (it is fetched by a device on a
 * schedule), so the result is capped at 100 rows and the window at 14 days.
 */
export async function upcomingCalendarReminders(
  userId: string,
  window: { from: Date; to: Date },
): Promise<UpcomingReminder[]> {
  const settings = await loadCalendarReminderSettings(userId);
  const from = new Date(Math.min(window.from.getTime(), window.to.getTime()));
  const to = new Date(Math.max(window.from.getTime(), window.to.getTime()));
  const MAX_WINDOW_MS = MAX_REMINDER_MINUTES * 60_000 * 2;
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    to.setTime(from.getTime() + MAX_WINDOW_MS);
  }
  // An occurrence with a minutes lead time can still be pending when its
  // remind-at moment is inside the window, so the occurrence range extends by
  // the maximum lead time - no series past that can produce a pending reminder.
  const rangeTo = new Date(to.getTime() + MAX_REMINDER_MINUTES * 60_000);

  // Fast path: materialised occurrences with a current state row, same trust
  // rule as the events route (NOT coveragePredicate).
  const materialized = await query<ReminderSourceRow>(
    `SELECT o.event_id, o.calendar_id, o.recurrence_id, o.starts_at, o.ends_at, o.all_day,
            COALESCE(o.summary, e.summary) AS summary,
            COALESCE(o.location, e.location) AS location,
            c.name AS calendar_name,
            r.enabled AS override_enabled, r.minutes_before AS override_minutes, r.mode AS override_mode,
            c.notify_minutes AS calendar_minutes,
            c.notify_enabled AS calendar_enabled, c.notify_mode AS calendar_mode
       FROM calendar_occurrences o
       JOIN calendar_events e ON e.id = o.event_id
       JOIN calendars c ON c.id = o.calendar_id
       LEFT JOIN calendar_event_reminder_overrides r ON r.event_id = e.id AND r.user_id = $1
       LEFT JOIN calendar_occurrence_state s ON s.event_id = e.id
      WHERE o.user_id = $1 AND c.user_id = $1 AND c.owner_user_id = $1
        AND (r.enabled = true
             OR (r.enabled IS NULL AND c.notify_enabled = true AND $4::boolean))
        AND o.starts_at >= $2 AND o.starts_at <= $3
        AND NOT ${coveragePredicate('s')}
      ORDER BY o.starts_at ASC
      LIMIT 400`,
    [userId, from, rangeTo, settings.enabled],
  );

  // Slow path: series the materialisation worker has not covered yet are
  // expanded on the fly by the same projection the events route uses.
  const fallback = await query<ReminderSourceRow>(
    `SELECT ${EVENT_COLUMNS},
            c.id AS calendar_id, c.name AS calendar_name,
            c.notify_minutes AS calendar_minutes, c.notify_enabled AS calendar_enabled, c.notify_mode AS calendar_mode,
            r.enabled AS override_enabled, r.minutes_before AS override_minutes, r.mode AS override_mode
       FROM calendar_events e
       JOIN calendars c ON c.id = e.calendar_id
       LEFT JOIN calendar_event_reminder_overrides r ON r.event_id = e.id AND r.user_id = $1
       LEFT JOIN calendar_occurrence_state s ON s.event_id = e.id
      WHERE e.user_id = $1 AND c.user_id = $1 AND c.owner_user_id = $1
        AND (r.enabled = true
             OR (r.enabled IS NULL AND c.notify_enabled = true AND $4::boolean))
        AND ((e.starts_at >= $2 AND e.starts_at <= $3) OR e.recurring)
        AND ${coveragePredicate('s')}
      ORDER BY e.starts_at ASC
      LIMIT 200`,
    [userId, from, rangeTo, settings.enabled],
  );

  const reminders = materialized.rows.map(row => resolveReminder(row, settings)).filter((reminder): reminder is UpcomingReminder => reminder !== null);

  if (fallback.rows.length) {
    const projection = await projectCalendarResources(fallback.rows, from, rangeTo, { userId });
    const overrides = new Map(fallback.rows.map(row => [String(row.event_id), row]));
    for (const event of projection.events) {
      const base = overrides.get(String(event.id ?? ''));
      if (!base) continue;
      // ProjectionEvent only carries the timing fields; the title and location
      // of an uncovered series come from the event row itself.
      const source: ReminderSourceRow = {
        ...base,
        recurrence_id: event.recurrence_id ?? '',
        starts_at: new Date(event.starts_at ?? base.starts_at),
        ends_at: new Date(event.ends_at ?? base.ends_at),
        all_day: event.all_day ?? base.all_day,
      };
      const reminder = resolveReminder(source, settings);
      if (reminder) reminders.push(reminder);
    }
  }

  const windowFrom = from.getTime();
  const windowTo = to.getTime();
  const seen = new Set<string>();
  return reminders
    .filter(reminder => {
      if (seen.has(reminder.key)) return false;
      seen.add(reminder.key);
      const remindAt = Date.parse(reminder.remindAt);
      return remindAt >= windowFrom && remindAt <= windowTo;
    })
    .sort((left, right) => Date.parse(left.remindAt) - Date.parse(right.remindAt))
    .slice(0, 100);
}

