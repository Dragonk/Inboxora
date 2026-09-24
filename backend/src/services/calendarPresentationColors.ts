import { query } from './db.js';

export interface ColorPreference { calendar_id: string; color_override: string | null }
export function validPresentationColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
export function colorPreferenceMap(rows: readonly ColorPreference[]): Map<string, string | null> {
  return new Map(rows.map(row => [row.calendar_id, validPresentationColor(row.color_override) ? row.color_override : null]));
}
export async function loadCalendarColorPreferences(userId: string): Promise<Map<string, string | null>> {
  const result = await query<ColorPreference>('SELECT calendar_id, color_override FROM user_calendar_presentation_preferences WHERE user_id = $1', [userId]);
  return colorPreferenceMap(result.rows);
}
export function calendarColorFields(id: string, source: unknown, preferences: ReadonlyMap<string, string | null>) {
  const sourceColor = validPresentationColor(source) ? source : null;
  const override = preferences.get(id) ?? null;
  return { source_color: sourceColor, color_override: override, color: override ?? sourceColor };
}
/** Apply identically to materialised, expanded and synthetic occurrences. */
export function withCalendarPresentationColor<T extends object>(event: T, preferences: ReadonlyMap<string, string | null>) {
  const row = event as T & { calendar_id?: unknown; calendar_color?: unknown };
  const id = typeof row.calendar_id === 'string' ? row.calendar_id : '';
  const fields = calendarColorFields(id, row.calendar_color, preferences);
  return { ...event, calendar_source_color: fields.source_color, calendar_color: fields.color };
}
export type CalendarPresentationPatch = { sidebarHidden?: boolean; colorOverride?: string | null };
export function parseCalendarPresentationPatch(value: unknown): CalendarPresentationPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>; const keys = Object.keys(input);
  if (!keys.length || keys.some(key => key !== 'sidebarHidden' && key !== 'colorOverride')) return null;
  const patch: CalendarPresentationPatch = {};
  if (Object.prototype.hasOwnProperty.call(input, 'sidebarHidden')) {
    if (typeof input.sidebarHidden !== 'boolean') return null;
    patch.sidebarHidden = input.sidebarHidden;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'colorOverride')) {
    if (input.colorOverride !== null && !validPresentationColor(input.colorOverride)) return null;
    patch.colorOverride = input.colorOverride as string | null;
  }
  return patch;
}
/** Only supplied fields change, including when two browser tabs write concurrently. */
export async function writeCalendarPresentationPatch(userId: string, calendarId: string, patch: CalendarPresentationPatch): Promise<void> {
  const hasHidden = typeof patch.sidebarHidden === 'boolean';
  const hasColor = Object.prototype.hasOwnProperty.call(patch, 'colorOverride');
  await query(`INSERT INTO user_calendar_presentation_preferences (user_id, calendar_id, sidebar_hidden, color_override, updated_at)
    VALUES ($1, $2, COALESCE($3::boolean, false), $4::text, NOW())
    ON CONFLICT (user_id, calendar_id) DO UPDATE SET
      sidebar_hidden = CASE WHEN $5::boolean THEN EXCLUDED.sidebar_hidden ELSE user_calendar_presentation_preferences.sidebar_hidden END,
      color_override = CASE WHEN $6::boolean THEN EXCLUDED.color_override ELSE user_calendar_presentation_preferences.color_override END,
      updated_at = NOW()`, [userId, calendarId, hasHidden ? patch.sidebarHidden : null, hasColor ? patch.colorOverride : null, hasHidden, hasColor]);
}
