
import { describe, expect, it, vi, beforeEach } from 'vitest';

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };
type Query = (text: string, params: unknown[]) => Promise<QueryResult>;

const { query } = vi.hoisted(() => ({ query: vi.fn<Query>() }));
const { projectCalendarResources } = vi.hoisted(() => ({ projectCalendarResources: vi.fn() }));
vi.mock('./db.js', () => ({ query }));
vi.mock('./calendarProjectionPool.js', () => ({ projectCalendarResources }));

import {
  DEFAULT_REMINDER_MINUTES,
  loadCalendarReminderSettings,
  sanitizeReminderMinutes,
  sanitizeReminderMode,
  setEventReminderOverride,
  upcomingCalendarReminders,
} from './calendarReminders.js';

function row(overrides: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    event_id: 'e1',
    calendar_id: 'c1',
    recurrence_id: '',
    starts_at: new Date(Date.now() + 3 * 3_600_000),
    ends_at: new Date(Date.now() + 4 * 3_600_000),
    all_day: false,
    summary: 'Standup',
    location: null,
    calendar_name: 'Work',
    override_enabled: null,
    override_minutes: null,
    override_mode: null,
    calendar_minutes: null,
    ...overrides,
  };
}

function mockSettings(preferences: Record<string, unknown>) {
  query.mockImplementation(async (text: string) => {
    if (text.includes('SELECT preferences FROM users')) return { rows: [{ preferences }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  query.mockReset();
  projectCalendarResources.mockReset();
});

describe('reminder settings sanitisation', () => {
  it('accepts bounded minutes and rejects the rest', () => {
    expect(sanitizeReminderMinutes(0)).toBe(0);
    expect(sanitizeReminderMinutes(10080)).toBe(10080);
    expect(sanitizeReminderMinutes(10081)).toBeNull();
    expect(sanitizeReminderMinutes(-5)).toBeNull();
    expect(sanitizeReminderMinutes('30')).toBe(30);
    expect(sanitizeReminderMinutes('soon')).toBeNull();
    expect(sanitizeReminderMinutes(2.5)).toBeNull();
  });

  it('accepts only the two reminder modes', () => {
    expect(sanitizeReminderMode('notification')).toBe('notification');
    expect(sanitizeReminderMode('alarm')).toBe('alarm');
    expect(sanitizeReminderMode('ALARM')).toBeNull();
    expect(sanitizeReminderMode('sms')).toBeNull();
  });

  it('loads the shipped defaults and honours stored preferences', async () => {
    mockSettings({});
    const defaults = await loadCalendarReminderSettings('user-1');
    expect(defaults).toEqual({ enabled: true, minutes: DEFAULT_REMINDER_MINUTES, mode: 'notification' });

    mockSettings({ calendarRemindersEnabled: false, calendarRemindersMinutes: 10, calendarRemindersMode: 'alarm' });
    expect(await loadCalendarReminderSettings('user-1')).toEqual({ enabled: false, minutes: 10, mode: 'alarm' });
  });
});

describe('upcomingCalendarReminders', () => {
  it('keeps only explicitly pinned events when the global preference is off', async () => {
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 24 * 3_600_000);
    const start = new Date(from.getTime() + 2 * 3_600_000);
    query.mockImplementation(async (text: string) => {
      if (text.includes('SELECT preferences FROM users')) return { rows: [{ preferences: { calendarRemindersEnabled: false } }] };
      if (text.includes('FROM calendar_occurrences o')) {
        return { rows: [row({ event_id: 'pinned-event', starts_at: start, override_enabled: true, override_minutes: 10 })] };
      }
      return { rows: [] };
    });

    const reminders = await upcomingCalendarReminders('user-1', { from, to });
    // The pinned event rings anyway; everything without an explicit override is
    // muted by the cascade.
    expect(reminders.map(reminder => reminder.eventId)).toEqual(['pinned-event']);
    expect(reminders[0]?.minutes).toBe(10);
  });

  it('lets one pinned event ring even when its whole calendar is muted', async () => {
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 24 * 3_600_000);
    const start = new Date(from.getTime() + 2 * 3_600_000);
    query.mockImplementation(async (text: string) => {
      if (text.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (text.includes('FROM calendar_occurrences o')) {
        return { rows: [
          row({ event_id: 'pinned', starts_at: start, calendar_enabled: false, override_enabled: true }),
          row({ event_id: 'muted', starts_at: start, calendar_enabled: false, override_enabled: null }),
        ] };
      }
      return { rows: [] };
    });

    const reminders = await upcomingCalendarReminders('user-1', { from, to });
    expect(reminders.map(reminder => reminder.eventId)).toEqual(['pinned']);
  });

  it('resolves the mode cascade: event override > calendar default > global default', async () => {
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 24 * 3_600_000);
    const start = new Date(from.getTime() + 2 * 3_600_000);
    query.mockImplementation(async (text: string) => {
      if (text.includes('SELECT preferences FROM users')) return { rows: [{ preferences: { calendarRemindersMode: 'notification' } }] };
      if (text.includes('FROM calendar_occurrences o')) {
        return { rows: [
          row({ event_id: 'mode-event', starts_at: start, override_mode: 'alarm' }),
          row({ event_id: 'cal-mode-event', starts_at: start, calendar_mode: 'alarm' }),
          row({ event_id: 'global-event', starts_at: start }),
        ] };
      }
      return { rows: [] };
    });

    const reminders = await upcomingCalendarReminders('user-1', { from, to });
    const modeById = new Map(reminders.map(reminder => [reminder.eventId, reminder.mode]));
    expect(modeById.get('mode-event')).toBe('alarm');
    expect(modeById.get('cal-mode-event')).toBe('alarm');
    expect(modeById.get('global-event')).toBe('notification');
  });

  it('resolves the minute cascade: event override > calendar default > global default', async () => {
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 24 * 3_600_000);
    const start = new Date(from.getTime() + 2 * 3_600_000);
    query.mockImplementation(async (text: string) => {
      if (text.includes('SELECT preferences FROM users')) return { rows: [{ preferences: { calendarRemindersMinutes: 30 } }] };
      if (text.includes('FROM calendar_occurrences o')) {
        return { rows: [
          row({ event_id: 'override-event', starts_at: start, override_minutes: 5 }),
          row({ event_id: 'calendar-event', starts_at: start, calendar_minutes: 15 }),
          row({ event_id: 'global-event', starts_at: start }),
        ] };
      }
      return { rows: [] };
    });

    const reminders = await upcomingCalendarReminders('user-1', { from, to });
    const minutesById = new Map(reminders.map(reminder => [reminder.eventId, reminder.minutes]));
    expect(minutesById.get('override-event')).toBe(5);
    expect(minutesById.get('calendar-event')).toBe(15);
    expect(minutesById.get('global-event')).toBe(30);
    // The remind-at moment is derived from the lead time that won the cascade.
    expect(reminders.find(reminder => reminder.eventId === 'override-event')?.remindAt)
      .toBe(new Date(start.getTime() - 5 * 60_000).toISOString());
  });

  it('keeps only reminders whose remind-at moment is inside the window', async () => {
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 3_600_000);
    query.mockImplementation(async (text: string) => {
      if (text.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (text.includes('FROM calendar_occurrences o')) {
        return { rows: [
          // remindAt = start - 30 min, one inside the window, one far outside.
          row({ event_id: 'inside', starts_at: new Date(Date.now() + 30 * 60_000) }),
          row({ event_id: 'outside', starts_at: new Date(Date.now() + 20 * 3_600_000) }),
        ] };
      }
      return { rows: [] };
    });

    const reminders = await upcomingCalendarReminders('user-1', { from, to });
    expect(reminders.map(reminder => reminder.eventId)).toEqual(['inside']);
  });

  it('addresses recurring occurrences by event id and recurrence id', async () => {
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 24 * 3_600_000);
    query.mockImplementation(async (text: string) => {
      if (text.includes('SELECT preferences FROM users')) return { rows: [{ preferences: {} }] };
      if (text.includes('FROM calendar_occurrences o')) {
        return { rows: [row({ event_id: 'series', recurrence_id: '2026-10-20T09:00:00Z', starts_at: new Date(Date.now() + 3_600_000) })] };
      }
      return { rows: [] };
    });

    const reminders = await upcomingCalendarReminders('user-1', { from, to });
    expect(reminders[0]?.key).toBe('series@2026-10-20T09:00:00Z');
  });
});

describe('event reminder overrides', () => {
  it('rejects an out-of-range lead time before touching the database', async () => {
    query.mockResolvedValue({ rows: [{ id: 'e1' }] });
    await expect(setEventReminderOverride('user-1', 'e1', { minutesBefore: 99999 }))
      .rejects.toMatchObject({ statusCode: 400 });
    // The ownership probe ran, but no INSERT with the invalid value did.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown mode', async () => {
    query.mockResolvedValue({ rows: [{ id: 'e1' }] });
    await expect(setEventReminderOverride('user-1', 'e1', { mode: 'buzzer' as never }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('404s for an event the user does not own', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(setEventReminderOverride('user-1', 'e1', { enabled: true }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

