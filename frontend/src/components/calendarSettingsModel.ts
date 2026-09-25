export interface CalendarRow {
  id: string; name?: string | null; color?: string | null; source_color?: string | null; color_override?: string | null;
  source?: string | null; read_only?: boolean | null; owner_user_id?: string | null; display_visible?: boolean | null;
  custom_name?: boolean | null; dav_mode?: string | null; collection_id?: string | null;
  source_access?: string | null; user_access?: string | null;
  [key: string]: unknown;
}
export interface CalendarPresentationSource {
  id: string; kind: string; label: string; labelKey?: string; accountId: string | null;
  identityLabel: string | null; featureEnabled: boolean; canSync: boolean; collapsed: boolean;
}
export interface CalendarPresentationCalendar {
  id: string; sourceId: string; displayName: string; readOnly: boolean; selected: boolean; sidebarHidden: boolean;
  sourceColor?: string | null; colorOverride?: string | null; effectiveColor?: string | null;
}
export interface CalendarPresentation {
  sources?: CalendarPresentationSource[]; calendars?: CalendarPresentationCalendar[];
  groups?: Array<CalendarPresentationSource & { calendars: CalendarPresentationCalendar[] }>;
}
export function calendarSourceCategory(source: CalendarPresentationSource): 'local' | 'external' | 'google' | 'microsoft' | 'system' {
  if (source.kind === 'local' || source.kind === 'google' || source.kind === 'microsoft' || source.kind === 'system') return source.kind;
  return 'external';
}
function rank(kind: string): number {
  return kind === 'google' ? 0 : kind === 'microsoft' ? 1 : kind === 'caldav' ? 2 : kind === 'local' ? 3 : kind === 'system' ? 5 : 4;
}
export function calendarSidebarGroups(presentation: CalendarPresentation | null, calendars: CalendarRow[]) {
  const byId = new Map(calendars.map(calendar => [calendar.id, calendar]));
  return (presentation?.groups ?? []).map(group => ({
    ...group, category: calendarSourceCategory(group),
    rows: group.calendars.map(view => ({ view, calendar: byId.get(view.id) }))
      .filter((item): item is { view: CalendarPresentationCalendar; calendar: CalendarRow } => item.calendar !== undefined),
  })).sort((left, right) => rank(left.kind) - rank(right.kind) || (left.identityLabel || left.label).localeCompare(right.identityLabel || right.label));
}
/** A settings hide/show action does not grant source writes. */
export async function setCalendarSidebarHidden(update: (id: string, hidden: boolean) => Promise<unknown>, id: string, hidden: boolean) { await update(id, hidden); }
export function canManageLocalCalendar(calendar: CalendarRow) {
  return calendar.source === 'local' && !calendar.read_only && Boolean(calendar.owner_user_id);
}
