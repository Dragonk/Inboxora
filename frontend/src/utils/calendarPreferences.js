export const DEFAULT_CALENDAR_PREFERENCES = Object.freeze({
  calendarWorkDays: Object.freeze([1, 2, 3, 4, 5]),
  calendarWorkHoursStart: '09:00',
  calendarWorkHoursEnd: '17:00',
});

export function normalizeCalendarWorkDays(value) {
  if (!Array.isArray(value)) return [...DEFAULT_CALENDAR_PREFERENCES.calendarWorkDays];
  const days = [...new Set(value.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
  return days.length ? days : [...DEFAULT_CALENDAR_PREFERENCES.calendarWorkDays];
}

export function normalizeCalendarWorkTime(value, fallback = '09:00') {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return fallback;
  return value;
}
