export const DEFAULT_CALENDAR_PREFERENCES = Object.freeze({
  calendarWorkDays: Object.freeze([1, 2, 3, 4, 5]),
  calendarWorkHoursStart: '09:00',
  calendarWorkHoursEnd: '17:00',
});

export const CALENDAR_VIEWS = Object.freeze(['month', 'week', 'workweek', 'agenda']);
export const CALENDAR_VIEW_DEFAULT = 'month';
// The view is remembered per device (like the panel widths), not per account: how
// much of a calendar fits on screen is a property of the screen. A phone and a
// desktop can therefore keep different views without fighting each other.
export const CALENDAR_VIEW_STORAGE_KEY = 'mailflow_calendar_view';

export function normalizeCalendarView(value) {
  return CALENDAR_VIEWS.includes(value) ? value : CALENDAR_VIEW_DEFAULT;
}

export function readStoredCalendarView() {
  try {
    return normalizeCalendarView(localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY));
  } catch {
    // A blocked storage must not stop the calendar from opening.
    return CALENDAR_VIEW_DEFAULT;
  }
}

export function storeCalendarView(value) {
  const view = normalizeCalendarView(value);
  try {
    localStorage.setItem(CALENDAR_VIEW_STORAGE_KEY, view);
  } catch { /* a blocked storage must not break switching the view */ }
  return view;
}

export function normalizeCalendarWorkDays(value) {
  if (!Array.isArray(value)) return [...DEFAULT_CALENDAR_PREFERENCES.calendarWorkDays];
  const days = [...new Set(value.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
  return days.length ? days : [...DEFAULT_CALENDAR_PREFERENCES.calendarWorkDays];
}

export function normalizeCalendarWorkTime(value, fallback = '09:00') {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return fallback;
  return value;
}
